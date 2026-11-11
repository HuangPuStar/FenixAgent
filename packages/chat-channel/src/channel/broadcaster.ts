import * as Y from "yjs";
import {
  encodeYjsReplaceFrame,
  encodeYjsUpdateFrame,
  MAX_YJS_SYNC_PAYLOAD_BYTES,
  MAX_YJS_TRANSFER_BYTES,
} from "../protocol/update-frame";
import { SLOW_CONSUMER_RESYNC_TIMEOUT_REASON } from "../transport/ws-close-codes";
import { BroadcastRecovery } from "./broadcast-recovery";
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
/** 帧打点聚合窗口：每秒输出一次各 docName 前缀的帧数与字节数 */
const FRAME_METRICS_WINDOW_MS = 1_000;

/** broadcaster 可观测性注入（lagging/resync 生命周期日志与 SP-0 帧打点） */
export interface YjsBroadcasterOptions {
  /** 诊断日志；消息只允许包含标识前缀、尺寸与耗时，禁止会话内容 */
  reportLog?: (message: string) => void;
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
  private readonly recovery: BroadcastRecovery;
  private readonly frameStats: Map<string, { count: number; bytes: number }> | null;
  private frameStatsWindowStart = Date.now();

  constructor(
    private readonly registry: ConnectionRegistry,
    options: YjsBroadcasterOptions = {},
  ) {
    this.reportLog = options.reportLog;
    this.frameStats = this.reportLog ? new Map() : null;
    this.recovery = new BroadcastRecovery({
      document: (name) => this.registeredDocs.get(name),
      deliver: (ws, name, generation, update) => this.deliverPayload(ws, "update", name, generation, update),
      pending: (ws, name) => this.fragments.hasPending(ws, name) || this.fragments.hasWaiter(ws, name),
      buffered: (ws) => this.bufferedAmountOf(ws),
      reportLog: this.reportLog,
    });
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
    let deferredVector: Uint8Array | undefined = stateVector;
    const waiting = this.waitForPending(
      ws,
      docName,
      () => {
        const vector = deferredVector!;
        // 归还 waiter 预算后不再由闭包持有旧向量，后续传输只保留新编码的差量。
        deferredVector = undefined;
        return this.sendDiff(ws, ydoc, docName, generation, vector);
      },
      stateVector.byteLength,
    );
    if (waiting) return waiting;
    const update = stateVector.length === 0 ? Y.encodeStateAsUpdate(ydoc) : Y.encodeStateAsUpdate(ydoc, stateVector);
    return this.deliverPayload(ws, "update", docName, generation, update);
  }

  /** 权威换代；小 replace 可强制发送，大 replace 保留逐片背压。 */
  broadcastReplacement(ydoc: Y.Doc, docName: string, generation: string, force = false): void {
    this.recovery.forgetDocument(docName);
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
    this.recovery.forgetDocument(docName);
  }

  /** 注册当前代文档的批量广播，替换时先撤销旧监听与在途传输。 */
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

  /** 同一事件循环内合并文档更新，再按会话隔离发送。 */
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
    this.recovery.forgetConnection(ws);
    this.fragmentPeers.delete(ws);
  }

  /** 握手明确支持后才发送分片，旧标签页不能忽略新帧后误收成功通知。 */
  enableFragmentSupport(ws: WsConnection): void {
    this.fragmentPeers.add(ws);
    this.recovery.increaseBudget(ws, MAX_YJS_TRANSFER_BYTES);
  }

  /** 普通帧与分片共用预算和交付语义；排队不构成同步成功。 */
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

  /** 握手优先等待在途基线，并为整条等待链保留总时限。 */
  private waitForPending(
    ws: WsConnection,
    docName: string,
    retry: () => LegacyFrameDelivery,
    retainedBytes = 0,
  ): LegacyFrameDelivery | null {
    const completion = this.fragments.afterPending(
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
      (error: unknown) => {
        this.reportLog?.(
          `[YJS-BROADCAST] deferred sync failed: prefix=${docPrefix(docName)} error=${error instanceof Error ? error.name : "unknown"}`,
        );
        ws.close(1011, "deferred sync failed");
        this.cancelConnection(ws);
        return REJECTED(0, "encode_failed");
      },
      retainedBytes,
    );
    if (!completion) return null;
    return {
      ok: false,
      bytes: 0,
      limitBytes: MAX_YJS_TRANSFER_BYTES,
      reason: null,
      completion,
    };
  }

  /** 小帧共享编码，大更新按连接能力分片，确定性超限不进入无限追赶。 */
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
      if (kind !== "replace" && this.recovery.retryBlocked(entry.ws, docName)) return;
      if (kind === "replace") this.fragments.cancelDocument(entry.ws, docName);
      const delivery = this.deliverPayload(entry.ws, kind, docName, generation, payload);
      const settle = (result: LegacyFrameDelivery) => {
        if (kind === "replace" && !result.ok) {
          const current = this.registeredDocs.get(docName);
          if (current && current.generation !== generation) return;
          this.closeFailedReplacement(entry.ws);
          return;
        }
        this.recovery.rejected(entry.ws, docName, generation, result);
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
      if (!replace && this.recovery.retryBlocked(entry.ws, docName)) return;
      if (replace) this.fragments.cancelDocument(entry.ws, docName);
      if (!force) {
        const sent = this.sendFrameWithBackpressure(entry.ws, docName, frame);
        if (replace && !sent) this.closeFailedReplacement(entry.ws);
        return;
      }
      try {
        if (entry.ws.readyState === 1) entry.ws.send(frame);
      } catch {
        if (replace) this.closeFailedReplacement(entry.ws);
        // 单连接失败不阻塞其他连接；连接自身事件会收敛关闭。
      }
    };

    if (rcsSessionId) {
      this.registry.forEachByRcsSession(rcsSessionId, send);
      return;
    }
    this.registry.forEachClient(send);
  }

  /** 换代信号不可丢失；失败后用新连接清理接收端旧组装并重新绑定当前投影。 */
  private closeFailedReplacement(ws: WsConnection): void {
    if (ws.readyState !== 1) return;
    try {
      ws.close(1013, SLOW_CONSUMER_RESYNC_TIMEOUT_REASON);
    } catch (error) {
      this.reportLog?.(
        `[YJS-BROADCAST] replacement close failed: error=${error instanceof Error ? error.name : "unknown"}`,
      );
    }
    this.cancelConnection(ws);
  }

  /** 拥塞与在途基线期间登记追赶，单连接异常不阻塞其他连接。 */
  private sendFrameWithBackpressure(ws: WsConnection, docName: string, frame: Uint8Array): boolean {
    if (ws.readyState !== 1) {
      this.recovery.forgetConnection(ws);
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
    this.recovery.mark(ws, docName);
  }

  /** 排水后定向补齐丢帧文档；30s 时限从首次丢帧计，避免慢连接无限占用资源。 */
  private reconcileLagging(): void {
    this.recovery.reconcile();
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
