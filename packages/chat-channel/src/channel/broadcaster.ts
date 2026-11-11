// 广播按 rcsSessionId 隔离；慢连接经有界快照追赶恢复，大载荷分片保留背压。

import * as Y from "yjs";
import {
  encodeYjsReplaceFrame,
  encodeYjsUpdateFrame,
  MAX_YJS_SYNC_PAYLOAD_BYTES,
  MAX_YJS_TRANSFER_BYTES,
} from "../protocol/update-frame";
import { SLOW_CONSUMER_RESYNC_TIMEOUT_REASON } from "../transport/ws-close-codes";
import type { ConnectionRegistry } from "./connection-registry";
import type { WsConnection } from "./connection-types";
import {
  deliveredLegacyFrame as DELIVERED,
  type LegacyFrameDelivery,
  rejectedLegacyFrame as REJECTED,
  YjsFragmentSender,
} from "./fragment-delivery";

export type { LegacyFrameDelivery, LegacyFrameRejection } from "./fragment-delivery";

/** WebSocket 发送背压阈值（CLAUDE.md YJS 不变量 9：修改时必须保留限流语义） */
const WS_SEND_THRESHOLD = 64 * 1024;
/** lagging 连接持续超过该时长后 close(1013)，交给客户端重连走全量同步 */
const LAGGING_CLOSE_TIMEOUT_MS = 30_000;
/** 帧打点聚合窗口：每秒输出一次各 docName 前缀的帧数与字节数 */
const FRAME_METRICS_WINDOW_MS = 1_000;

/** broadcaster 可观测性注入（lagging/resync 生命周期日志与 SP-0 帧打点） */
export interface YjsBroadcasterOptions {
  /** 诊断日志；消息只允许包含标识前缀、尺寸与耗时，禁止会话内容 */
  reportLog?: (message: string) => void;
}

/** 单个 lagging 连接的追赶状态：起始时间 + 被丢帧涉及的 doc 集合 */
interface LaggingState {
  since: number;
  docNames: Set<string>;
}

/** 负责 Y.Doc 更新的批处理、路由与 WebSocket 发送。 */
export class YjsBroadcaster {
  private readonly fragments = new YjsFragmentSender((name, bytes) => this.recordFrameMetric(name, bytes));
  private readonly fragmentPeers = new WeakSet<WsConnection>();
  private readonly registeredDocs = new Map<
    string,
    { ydoc: Y.Doc; generation: string; listener: (update: Uint8Array) => void }
  >();
  private updateBuffers = new Map<string, Uint8Array[]>();
  private pendingDocNames = new Set<string>();
  private flushScheduled = false;
  private readonly reportLog: ((message: string) => void) | undefined;
  /** lagging 连接登记（SP-A7）：以 ws 对象身份为键；连接关闭后在 reconcile 时惰性清理 */
  private readonly laggingConnections = new Map<WsConnection, LaggingState>();
  /** SP-0 帧打点：无 reportLog 时不采集（避免无消费方的计数开销） */
  private readonly frameStats: Map<string, { count: number; bytes: number }> | null;
  private frameStatsWindowStart = Date.now();

  constructor(
    private readonly registry: ConnectionRegistry,
    options: YjsBroadcasterOptions = {},
  ) {
    this.reportLog = options.reportLog;
    this.frameStats = this.reportLog ? new Map() : null;
  }

  /** 控制帧触发静默文档追赶；同步结果允许至多 4 KiB 排在数据之后，避免丢掉完成证明。 */
  sendToYjsWs(ws: WsConnection, data: unknown, initialSyncStatus = false): boolean {
    if (ws.readyState !== 1) return false;
    this.reconcileLagging();
    if (!initialSyncStatus && this.bufferedAmountOf(ws) > WS_SEND_THRESHOLD) return false;
    try {
      const frame = JSON.stringify(data);
      if (initialSyncStatus && new TextEncoder().encode(frame).byteLength > 4096) return false;
      ws.send(frame);
      return true;
    } catch (error) {
      this.reportLog?.(
        `[YJS-BROADCAST] control delivery failed: error=${error instanceof Error ? error.name : "unknown"}`,
      );
      // 单个连接的发送失败不得冒泡到 keepalive / message 事件循环；连接关闭由 socket 自身事件收敛。
      return false;
    }
  }

  /** 编码失败仅影响本帧，保留诊断，避免中断共用的动作连接。 */
  private encodeLegacyFrame(
    kind: "update" | "replace",
    docName: string,
    generation: string,
    payload: Uint8Array,
  ): Uint8Array | null {
    if (payload.length > MAX_YJS_SYNC_PAYLOAD_BYTES) {
      this.reportLog?.(
        `[YJS-BROADCAST] dropped oversized legacy ${kind}: prefix=${docPrefix(docName)} ` +
          `bytes=${payload.length} limit=${MAX_YJS_SYNC_PAYLOAD_BYTES}`,
      );
      return null;
    }
    try {
      return kind === "replace"
        ? encodeYjsReplaceFrame(docName, generation, payload)
        : encodeYjsUpdateFrame(docName, generation, payload);
    } catch (error) {
      this.reportLog?.(
        `[YJS-BROADCAST] dropped unencodable legacy ${kind}: prefix=${docPrefix(docName)} ` +
          `bytes=${payload.length} error=${error instanceof Error ? error.name : "unknown"}`,
      );
      return null;
    }
  }

  /** 定向快照；分片时须等待 completion 才能证明交付。 */
  sendSnapshot(
    ws: WsConnection,
    ydoc: Y.Doc,
    docName: string,
    generation = this.generationOf(ydoc),
  ): LegacyFrameDelivery {
    const waiting = this.waitForPending(ws, docName, () => this.sendSnapshot(ws, ydoc, docName, generation));
    if (waiting) return waiting;
    const payload = Y.encodeStateAsUpdate(ydoc);
    return this.deliverPayload(ws, "update", docName, generation, payload);
  }

  /** 定向差量；空 state vector 表示无当前代状态，不能直接交给 lib0 解码。 */
  sendDiff(
    ws: WsConnection,
    ydoc: Y.Doc,
    docName: string,
    generation: string,
    stateVector: Uint8Array,
  ): LegacyFrameDelivery {
    const waiting = this.waitForPending(ws, docName, () => this.sendDiff(ws, ydoc, docName, generation, stateVector));
    if (waiting) return waiting;
    const update = stateVector.length === 0 ? Y.encodeStateAsUpdate(ydoc) : Y.encodeStateAsUpdate(ydoc, stateVector);
    return this.deliverPayload(ws, "update", docName, generation, update);
  }

  /** 权威换代；小 replace 可强制发送，大 replace 保留逐片背压。 */
  broadcastReplacement(ydoc: Y.Doc, docName: string, generation: string, force = false): void {
    this.broadcastPayload("replace", docName, generation, Y.encodeStateAsUpdate(ydoc), force);
  }

  /** 向同 rcsSessionId 的全部客户端广播当前世代快照。 */
  broadcastSnapshot(ydoc: Y.Doc, docName: string, generation = this.generationOf(ydoc)): void {
    this.broadcastPayload("update", docName, generation, Y.encodeStateAsUpdate(ydoc));
  }

  unregisterYjsDocListener(docName: string): void {
    this.fragments.unregisterDocument(docName);
    const registeredDoc = this.registeredDocs.get(docName);
    if (registeredDoc) {
      registeredDoc.ydoc.off("update", registeredDoc.listener);
    }
    this.registeredDocs.delete(docName);
    this.updateBuffers.delete(docName);
    this.pendingDocNames.delete(docName);
    // Doc 已注销（relay 释放 / 实例回收）后无法再构造追赶快照，剔除对应登记；
    // 无剩余待追赶 doc 的条目直接移除（该连接已无丢失内容可恢复）。
    for (const [ws, state] of this.laggingConnections) {
      state.docNames.delete(docName);
      if (state.docNames.size === 0) this.laggingConnections.delete(ws);
    }
  }

  registerYjsDocListener(ydoc: Y.Doc, docName: string, generation = this.generationOf(ydoc)): void {
    const existing = this.registeredDocs.get(docName);
    if (existing?.ydoc === ydoc) return;
    if (existing) this.unregisterYjsDocListener(docName);
    const listener = (update: Uint8Array) => {
      let buffers = this.updateBuffers.get(docName);
      if (!buffers) {
        buffers = [];
        this.updateBuffers.set(docName, buffers);
      }
      buffers.push(update);
      this.pendingDocNames.add(docName);
      this.scheduleFlush();
    };
    this.registeredDocs.set(docName, { ydoc, generation, listener });
    ydoc.on("update", listener);
  }

  private generationOf(ydoc: Y.Doc): string {
    const generation = ydoc.getMap("root").get("projectionGeneration");
    return typeof generation === "string" ? generation : ydoc.guid;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flushBroadcastsNow());
  }

  private flushBroadcastsNow(): void {
    this.flushScheduled = false;
    this.reconcileLagging();
    const updateBuffers = this.updateBuffers;
    const pendingDocNames = this.pendingDocNames;
    this.updateBuffers = new Map();
    this.pendingDocNames = new Set();

    for (const docName of pendingDocNames) {
      const registered = this.registeredDocs.get(docName);
      if (!registered) continue;
      const buffers = updateBuffers.get(docName);
      if (!buffers || buffers.length === 0) continue;
      let update: Uint8Array;
      try {
        update = buffers.length === 1 ? buffers[0] : Y.mergeUpdates(buffers);
      } catch (error) {
        this.reportLog?.(
          `[YJS-BROADCAST] dropped unmergeable update: prefix=${docPrefix(docName)} ` +
            `error=${error instanceof Error ? error.name : "unknown"}`,
        );
        continue;
      }
      this.broadcastPayload("update", docName, registered.generation, update);
    }

    if (this.pendingDocNames.size > 0) {
      this.scheduleFlush();
    }
  }

  /** 关闭连接时立即撤销分片，避免发送任务继续持有大载荷。 */
  cancelConnection(ws: WsConnection): void {
    this.fragments.cancelConnection(ws);
    this.laggingConnections.delete(ws);
    this.fragmentPeers.delete(ws);
  }

  /** 握手明确支持后才发送分片，旧标签页不能忽略新帧后误收成功通知。 */
  enableFragmentSupport(ws: WsConnection): void {
    this.fragmentPeers.add(ws);
  }

  private deliverPayload(
    ws: WsConnection,
    kind: "update" | "replace",
    docName: string,
    generation: string,
    payload: Uint8Array,
  ): LegacyFrameDelivery {
    if (this.fragments.hasPending(ws, docName)) {
      this.markLagging(ws, docName);
      return REJECTED(payload.length, "backpressure");
    }
    if (payload.length > MAX_YJS_TRANSFER_BYTES) {
      this.reportLog?.(
        `[YJS-BROADCAST] dropped oversized legacy ${kind}: prefix=${docPrefix(docName)} bytes=${payload.length} limit=${MAX_YJS_TRANSFER_BYTES}`,
      );
      return { ...REJECTED(payload.length, "too_large"), limitBytes: MAX_YJS_TRANSFER_BYTES };
    }
    if (payload.length > MAX_YJS_SYNC_PAYLOAD_BYTES) {
      if (!this.fragmentPeers.has(ws)) return REJECTED(payload.length, "too_large");
      return {
        ok: false,
        bytes: payload.length,
        limitBytes: MAX_YJS_TRANSFER_BYTES,
        reason: null,
        completion: this.fragments.send(ws, docName, generation, kind, payload).then((result) => {
          this.reconcileLagging();
          const final = result === "delivered" ? DELIVERED(payload.length) : REJECTED(payload.length, result);
          return { ...final, limitBytes: MAX_YJS_TRANSFER_BYTES };
        }),
      };
    }
    const frame = this.encodeLegacyFrame(kind, docName, generation, payload);
    if (frame === null) return REJECTED(payload.length, "encode_failed");
    this.recordFrameMetric(docName, frame.length);
    return this.sendFrameWithBackpressure(ws, docName, frame)
      ? DELIVERED(payload.length)
      : REJECTED(payload.length, "backpressure");
  }

  private waitForPending(
    ws: WsConnection,
    docName: string,
    retry: () => LegacyFrameDelivery,
  ): LegacyFrameDelivery | null {
    const completion = this.fragments
      .afterPending(
        ws,
        docName,
        (result) => {
          if (result !== "delivered" || ws.readyState !== 1) return REJECTED(0, "backpressure");
          const delivery = retry();
          return delivery.completion ?? delivery;
        },
        () => {
          ws.close(1013, SLOW_CONSUMER_RESYNC_TIMEOUT_REASON);
          this.cancelConnection(ws);
          return REJECTED(0, "backpressure");
        },
      )
      ?.catch((error: unknown) => {
        this.reportLog?.(
          `[YJS-BROADCAST] deferred sync failed: prefix=${docPrefix(docName)} error=${error instanceof Error ? error.name : "unknown"}`,
        );
        ws.close(1011, "deferred sync failed");
        this.cancelConnection(ws);
        return REJECTED(0, "encode_failed");
      });
    if (!completion) return null;
    return {
      ok: false,
      bytes: 0,
      limitBytes: MAX_YJS_TRANSFER_BYTES,
      reason: null,
      completion,
    };
  }

  private broadcastPayload(
    kind: "update" | "replace",
    docName: string,
    generation: string,
    payload: Uint8Array,
    force = false,
  ): void {
    if (payload.length <= MAX_YJS_SYNC_PAYLOAD_BYTES) {
      const frame = this.encodeLegacyFrame(kind, docName, generation, payload);
      if (frame === null) return;
      this.recordFrameMetric(docName, frame.length);
      this.broadcastMessage(docName, frame, force, kind === "replace");
      return;
    }
    const send = (entry: { ws: WsConnection; syncOnly?: boolean }) => {
      if (entry.syncOnly) return;
      if (kind === "replace") this.fragments.cancelDocument(entry.ws, docName);
      const delivery = this.deliverPayload(entry.ws, kind, docName, generation, payload);
      const settle = (result: LegacyFrameDelivery) => {
        if (!result.ok && entry.ws.readyState === 1) this.markLagging(entry.ws, docName);
      };
      if (delivery.completion) void delivery.completion.then(settle);
      else settle(delivery);
    };
    const key = this.getRcsSessionId(docName);
    if (key) this.registry.forEachByRcsSession(key, send);
    else this.registry.forEachClient(send);
  }

  /** 同会话广播共享一份已编码小帧，避免逐连接序列化。 */
  private broadcastMessage(docName: string, frame: Uint8Array, force = false, replace = false): void {
    const rcsSessionId = this.getRcsSessionId(docName);

    // sync-only 连接由新协议 DOC_BASE/DOC_UPDATE 驱动，旧 Doc 增量必须跳过；
    // 同一会话可能同时存在旧标签页，因此按连接而非按会话整体裁剪。
    const send = (entry: { ws: WsConnection; syncOnly?: boolean }) => {
      if (entry.syncOnly) return;
      if (replace) this.fragments.cancelDocument(entry.ws, docName);
      if (!force) {
        this.sendFrameWithBackpressure(entry.ws, docName, frame);
        return;
      }
      try {
        if (entry.ws.readyState === 1) entry.ws.send(frame);
      } catch {
        // 单连接失败不阻塞其他连接；连接自身事件会收敛关闭。
      }
    };

    if (rcsSessionId) {
      this.registry.forEachByRcsSession(rcsSessionId, send);
      return;
    }
    this.registry.forEachClient(send);
  }

  /** 拥塞与在途基线期间登记追赶，单连接异常不阻塞其他连接。 */
  private sendFrameWithBackpressure(ws: WsConnection, docName: string, frame: Uint8Array): boolean {
    if (ws.readyState !== 1) {
      this.laggingConnections.delete(ws);
      return false;
    }
    if (this.fragments.hasPending(ws, docName) || this.bufferedAmountOf(ws) > WS_SEND_THRESHOLD) {
      this.markLagging(ws, docName);
      return false;
    }
    try {
      ws.send(frame);
      return true;
    } catch {
      // 单连接失败不阻塞
      return false;
    }
  }

  private markLagging(ws: WsConnection, docName: string): void {
    const existing = this.laggingConnections.get(ws);
    if (existing) {
      existing.docNames.add(docName);
      return;
    }
    this.laggingConnections.set(ws, { since: Date.now(), docNames: new Set([docName]) });
    this.reportLog?.(`[YJS-BROADCAST] connection lagging: prefix=${docPrefix(docName)} threshold=${WS_SEND_THRESHOLD}`);
  }

  /** 排水后定向补齐丢帧文档；30s 时限从首次丢帧计，避免慢连接无限占用资源。 */
  private reconcileLagging(now = Date.now()): void {
    if (this.laggingConnections.size === 0) return;
    for (const [ws, state] of this.laggingConnections) {
      if (ws.readyState !== 1) {
        this.laggingConnections.delete(ws);
        continue;
      }
      if (now - state.since > LAGGING_CLOSE_TIMEOUT_MS) {
        this.laggingConnections.delete(ws);
        this.reportLog?.(
          `[YJS-BROADCAST] closing slow consumer: prefix=${[...state.docNames].map(docPrefix).join(",")} ` +
            `laggedMs=${now - state.since}`,
        );
        try {
          ws.close(1013, SLOW_CONSUMER_RESYNC_TIMEOUT_REASON);
        } catch {
          // 连接关闭失败不阻塞其他连接的追赶
        }
        continue;
      }
      if (this.bufferedAmountOf(ws) > WS_SEND_THRESHOLD) continue;
      const pending = [...state.docNames];
      while (pending.length > 0) {
        if (this.bufferedAmountOf(ws) > WS_SEND_THRESHOLD) break;
        const docName = pending.shift();
        if (docName === undefined) break;
        if (this.fragments.hasPending(ws, docName) || this.fragments.hasWaiter(ws, docName)) {
          pending.push(docName);
          break;
        }
        const registered = this.registeredDocs.get(docName);
        if (!registered) continue; // Doc 已注销，无内容可追赶
        let update: Uint8Array;
        try {
          update = Y.encodeStateAsUpdate(registered.ydoc);
        } catch (error) {
          this.reportLog?.(
            `[YJS-BROADCAST] dropped unencodable resync: prefix=${docPrefix(docName)} ` +
              `error=${error instanceof Error ? error.name : "unknown"}`,
          );
          continue;
        }
        const delivery = this.deliverPayload(ws, "update", docName, registered.generation, update);
        if (delivery.completion) {
          void delivery.completion.then((result) => {
            if (!result.ok && ws.readyState === 1) this.markLagging(ws, docName);
          });
        } else if (!delivery.ok) pending.push(docName);
        if (!delivery.ok && !delivery.completion) break;
      }
      if (pending.length === 0) {
        this.laggingConnections.delete(ws);
        this.reportLog?.("[YJS-BROADCAST] lagging connection resynced with targeted snapshots");
      } else {
        state.docNames = new Set(pending);
      }
    }
  }

  /** 按文档前缀聚合帧计量，不记录完整标识或会话内容。 */
  private recordFrameMetric(docName: string, bytes: number): void {
    if (!this.frameStats || !this.reportLog) return;
    const now = Date.now();
    if (now - this.frameStatsWindowStart >= FRAME_METRICS_WINDOW_MS) {
      for (const [prefix, stats] of this.frameStats) {
        if (stats.count > 0) {
          this.reportLog(`[YJS-BROADCAST] frame stats: prefix=${prefix} frames=${stats.count} bytes=${stats.bytes}`);
        }
        this.frameStats.set(prefix, { count: 0, bytes: 0 });
      }
      this.frameStatsWindowStart = now;
    }
    const prefix = docPrefix(docName);
    const stats = this.frameStats.get(prefix) ?? { count: 0, bytes: 0 };
    stats.count += 1;
    stats.bytes += bytes;
    this.frameStats.set(prefix, stats);
  }

  private bufferedAmountOf(ws: WsConnection): number {
    // bufferedAmount 不在最小 WsConnection 接口中，但 Bun/浏览器 WS 原生支持；
    // 用最小类型收窄访问，避免 as any
    const bufferedAmount = (ws as WsConnection & { bufferedAmount?: number }).bufferedAmount;
    return typeof bufferedAmount === "number" ? bufferedAmount : 0;
  }

  private getRcsSessionId(docName: string): string | null {
    if (docName.startsWith("chat:")) return docName.slice(5);
    if (docName.startsWith("session:")) return docName.slice(8);
    return null;
  }
}

/** docName 的前缀标识（chat:/session:），用于日志与打点分组；不含 rcsSessionId */
function docPrefix(docName: string): string {
  return docName.split(":")[0];
}
