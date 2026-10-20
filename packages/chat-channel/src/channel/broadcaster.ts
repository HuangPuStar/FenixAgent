// packages/chat-channel/src/channel/broadcaster.ts
// YjsBroadcaster：Y.Doc 更新的批处理、按 rcsSessionId 隔离的路由与 WebSocket 发送。
//
// 迁移自 src/transport/relay/yjs-frontend/yjs-broadcaster.ts，C3 切片（SP-A4/SP-A7/SP-0）改造：
// - 同 tick 内同一 Doc 的多次更新合并为一帧（Y.mergeUpdates），chat/session 保持独立帧；
// - 广播只发给同一 rcsSessionId 的客户端（禁止全局广播会话数据，CLAUDE.md YJS 不变量 5）；
// - yjs:update 走 0x01 二进制帧且每帧只编码一次（多客户端共享同一帧对象），
//   控制消息（keep_alive/pong/error/action ack）保持 JSON 文本帧；
// - 慢消费者背压（SP-A7）：bufferedAmount 超过 64 KB 跳帧时登记 lagging，
//   缓冲回落后定向发送全量快照追赶（非广播），持续 lagging 超 30s 则 close(1013)
//   交给客户端重连走全量同步——不再依赖"下次重连"这个不确定事件静默恢复；
// - 帧打点（SP-0）：按 docName 前缀聚合每秒帧数与字节数，经 reportLog 输出，
//   仅含前缀与尺寸计量，不含任何会话内容。

import * as Y from "yjs";
import { encodeYjsReplaceFrame, encodeYjsUpdateFrame, MAX_YJS_SYNC_PAYLOAD_BYTES } from "../protocol/update-frame";
import { SLOW_CONSUMER_RESYNC_TIMEOUT_REASON } from "../transport/ws-close-codes";
import type { ConnectionRegistry } from "./connection-registry";
import type { WsConnection } from "./connection-types";

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

/** legacy 帧未送达的原因；none 表示已写入 socket。 */
export type LegacyFrameRejection = "too_large" | "backpressure" | "encode_failed";

/** legacy 单帧投递结果：调用方不得把 ok=false 当作已同步完成。 */
export interface LegacyFrameDelivery {
  readonly ok: boolean;
  readonly bytes: number;
  readonly limitBytes: number;
  readonly reason: LegacyFrameRejection | null;
}

const DELIVERED: (bytes: number) => LegacyFrameDelivery = (bytes) => ({
  ok: true,
  bytes,
  limitBytes: MAX_YJS_SYNC_PAYLOAD_BYTES,
  reason: null,
});

const REJECTED: (bytes: number, reason: LegacyFrameRejection) => LegacyFrameDelivery = (bytes, reason) => ({
  ok: false,
  bytes,
  limitBytes: MAX_YJS_SYNC_PAYLOAD_BYTES,
  reason,
});

/** 单个 lagging 连接的追赶状态：起始时间 + 被丢帧涉及的 doc 集合 */
interface LaggingState {
  since: number;
  docNames: Set<string>;
}

/** 负责 Y.Doc 更新的批处理、路由与 WebSocket 发送。 */
export class YjsBroadcaster {
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

  /**
   * 发送单条 JSON 控制消息（keep_alive/pong/error/action ack）到指定连接。
   * 缓冲超过 64 KB 时跳过发送；控制帧不承载 Yjs 状态，跳过不登记 lagging，
   * 但借本次发送触发 lagging 连接的惰性 reconcile（keepalive 30s 周期是 doc
   * 静默期间唯一的恢复检查点）。
   */
  sendToYjsWs(ws: WsConnection, data: unknown): void {
    if (ws.readyState !== 1) return;
    this.reconcileLagging();
    if (this.bufferedAmountOf(ws) > WS_SEND_THRESHOLD) return;
    try {
      ws.send(JSON.stringify(data));
    } catch {
      // 单个连接的发送失败不得冒泡到 keepalive / message 事件循环；连接关闭由 socket 自身事件收敛。
    }
  }

  /**
   * legacy 帧编码的唯一安全入口：超限或编码失败只丢该帧并留诊断，不把异常抛回
   * `handleMessage` / `queueMicrotask`。旧通道与新的同步协议共用同一条 socket，
   * 因此不能为了一个过大的 legacy 帧关闭整条连接。
   */
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

  /** 向单个连接发送当前世代快照；返回值必须为 true 才算该文档完成同步。 */
  sendSnapshot(
    ws: WsConnection,
    ydoc: Y.Doc,
    docName: string,
    generation = this.generationOf(ydoc),
  ): LegacyFrameDelivery {
    const payload = Y.encodeStateAsUpdate(ydoc);
    if (payload.length > MAX_YJS_SYNC_PAYLOAD_BYTES) {
      this.reportLog?.(
        `[YJS-BROADCAST] dropped oversized legacy update: prefix=${docPrefix(docName)} ` +
          `bytes=${payload.length} limit=${MAX_YJS_SYNC_PAYLOAD_BYTES}`,
      );
      return REJECTED(payload.length, "too_large");
    }
    const frame = this.encodeLegacyFrame("update", docName, generation, payload);
    if (frame === null) return REJECTED(payload.length, "encode_failed");
    this.recordFrameMetric(docName, frame.length);
    return this.sendFrameWithBackpressure(ws, docName, frame)
      ? DELIVERED(payload.length)
      : REJECTED(payload.length, "backpressure");
  }

  /**
   * state-vector 握手的定向差量响应。
   *
   * 客户端 generation 不匹配时以空 payload 表示“没有当前世代状态”。空字节数组
   * 不是合法的 Yjs state vector，必须退化为当前世代全量编码，不能直接交给 lib0 解码。
   */
  sendDiff(
    ws: WsConnection,
    ydoc: Y.Doc,
    docName: string,
    generation: string,
    stateVector: Uint8Array,
  ): LegacyFrameDelivery {
    const update = stateVector.length === 0 ? Y.encodeStateAsUpdate(ydoc) : Y.encodeStateAsUpdate(ydoc, stateVector);
    if (update.length > MAX_YJS_SYNC_PAYLOAD_BYTES) {
      this.reportLog?.(
        `[YJS-BROADCAST] dropped oversized legacy update: prefix=${docPrefix(docName)} ` +
          `bytes=${update.length} limit=${MAX_YJS_SYNC_PAYLOAD_BYTES}`,
      );
      return REJECTED(update.length, "too_large");
    }
    const frame = this.encodeLegacyFrame("update", docName, generation, update);
    if (frame === null) return REJECTED(update.length, "encode_failed");
    this.recordFrameMetric(docName, frame.length);
    return this.sendFrameWithBackpressure(ws, docName, frame)
      ? DELIVERED(update.length)
      : REJECTED(update.length, "backpressure");
  }

  /**
   * replacement 使用 replace frame，客户端据此销毁旧副本并切换世代。
   * `force` 用于服务端权威换代：绕过 64KB 背压门禁，保证 legacy 连接不因丢帧停在旧代次。
   */
  broadcastReplacement(ydoc: Y.Doc, docName: string, generation: string, force = false): void {
    const frame = this.encodeLegacyFrame("replace", docName, generation, Y.encodeStateAsUpdate(ydoc));
    if (frame === null) return;
    this.recordFrameMetric(docName, frame.length);
    this.broadcastMessage(docName, frame, force);
  }

  /** 向同 rcsSessionId 的全部客户端广播当前世代快照。 */
  broadcastSnapshot(ydoc: Y.Doc, docName: string, generation = this.generationOf(ydoc)): void {
    const frame = this.encodeLegacyFrame("update", docName, generation, Y.encodeStateAsUpdate(ydoc));
    if (frame === null) return;
    this.recordFrameMetric(docName, frame.length);
    this.broadcastMessage(docName, frame);
  }

  unregisterYjsDocListener(docName: string): void {
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
      const frame = this.encodeLegacyFrame("update", docName, registered.generation, update);
      if (frame === null) continue;
      this.recordFrameMetric(docName, frame.length);
      this.broadcastMessage(docName, frame);
    }

    if (this.pendingDocNames.size > 0) {
      this.scheduleFlush();
    }
  }

  /**
   * 广播已编码的二进制帧到同 rcsSessionId 的客户端。
   * 帧只构造/编码一次，所有客户端发送同一对象（SP-A4 序列化去重）。
   */
  private broadcastMessage(docName: string, frame: Uint8Array, force = false): void {
    const rcsSessionId = this.getRcsSessionId(docName);

    // sync-only 连接由新协议 DOC_BASE/DOC_UPDATE 驱动，旧 Doc 增量必须跳过；
    // 同一会话可能同时存在旧标签页，因此按连接而非按会话整体裁剪。
    const send = (entry: { ws: WsConnection; syncOnly?: boolean }) => {
      if (entry.syncOnly) return;
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

  /**
   * 单连接二进制帧发送 + 背压语义（SP-A7）：
   * 缓冲超过 64 KB 跳帧并登记 lagging（含 docName 供追赶），发送异常不阻塞其他连接
   * （单连接故障隔离，CLAUDE.md YJS 不变量 9）。
   */
  private sendFrameWithBackpressure(ws: WsConnection, docName: string, frame: Uint8Array): boolean {
    if (ws.readyState !== 1) {
      this.laggingConnections.delete(ws);
      return false;
    }
    if (this.bufferedAmountOf(ws) > WS_SEND_THRESHOLD) {
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

  /**
   * lagging 连接的惰性 reconcile（SP-A7），由每次广播 flush 与控制帧发送触发：
   * - 连接已关闭：清除登记（防止 ws 对象泄漏）；
   * - 持续 lagging 超过 30s：close(1013) 终止，客户端重连后走全量快照同步；
   * - 缓冲已回落：向该连接定向发送其丢帧 doc 的全量快照（只发给 lagging 连接，
   *   非广播——正常连接已持有增量，重复快照纯属浪费带宽）。
   * 追赶快照发送过程中若再次拥塞，保留剩余 doc 登记等下一轮，since 不重置
   * （持续 lagging 的超时判定从首次丢帧起算）。
   */
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
        const frame = this.encodeLegacyFrame("update", docName, registered.generation, update);
        if (frame === null) continue;
        this.recordFrameMetric(docName, frame.length);
        try {
          ws.send(frame);
        } catch {
          // 单连接失败不阻塞
        }
      }
      if (pending.length === 0) {
        this.laggingConnections.delete(ws);
        this.reportLog?.("[YJS-BROADCAST] lagging connection resynced with targeted snapshots");
      } else {
        state.docNames = new Set(pending);
      }
    }
  }

  /**
   * SP-0 帧打点：按 docName 前缀（chat/session）聚合帧数与字节数，
   * 每满 1s 窗口经 reportLog 输出一次。只含前缀与计量，不含 docName 全名
   * 与任何会话内容；未注入 reportLog 时不采集。
   */
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
