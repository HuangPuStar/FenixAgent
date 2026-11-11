import * as Y from "yjs";
import { SLOW_CONSUMER_RESYNC_TIMEOUT_REASON } from "../transport/ws-close-codes";
import type { WsConnection } from "./connection-types";
import type { LegacyFrameDelivery } from "./fragment-delivery";

interface RecoveryState {
  since: number;
  active: Set<string>;
  blocked: Set<string>;
}

interface RecoveryOptions {
  document: (name: string) => { ydoc: Y.Doc; generation: string } | undefined;
  deliver: (ws: WsConnection, name: string, generation: string, update: Uint8Array) => LegacyFrameDelivery;
  pending: (ws: WsConnection, name: string) => boolean;
  buffered: (ws: WsConnection) => number;
  reportLog?: (message: string) => void;
}

/** 追赶状态区分临时拥塞与容量阻塞；容量阻塞保留缺失基线，但不定时重试或关闭动作连接。 */
export class BroadcastRecovery {
  private readonly connections = new Map<WsConnection, RecoveryState>();

  constructor(private readonly options: RecoveryOptions) {}

  /** 临时丢帧进入有界追赶；容量阻塞仅在文档变化后重新尝试。 */
  mark(ws: WsConnection, name: string): void {
    const state = this.state(ws);
    if (state.blocked.has(name)) return;
    if (state.active.size === 0) state.since = Date.now();
    state.active.add(name);
  }

  /** 文档变化后重新检查容量；重送完整基线前不能直接发送依赖旧 clock 的增量。 */
  retryBlocked(ws: WsConnection, name: string): boolean {
    const state = this.connections.get(ws);
    if (!state?.blocked.delete(name)) return false;
    this.mark(ws, name);
    this.reconcile();
    return true;
  }

  /** 广播失败时，只有当前投影仍可恢复才登记拥塞追赶。 */
  rejected(ws: WsConnection, name: string, generation: string, result: LegacyFrameDelivery): void {
    if (result.ok || ws.readyState !== 1) return;
    const doc = this.options.document(name);
    if (!doc || doc.generation !== generation) return;
    if (result.reason === "too_large") {
      const snapshot = this.snapshot(name);
      if (!snapshot) return;
      if (snapshot.update.length > result.limitBytes) {
        this.block(ws, name);
        return;
      }
    }
    this.mark(ws, name);
  }

  /** 连接关闭立即回收全部恢复记录。 */
  forgetConnection(ws: WsConnection): void {
    this.connections.delete(ws);
  }

  /** 文档注销与权威替换使旧基线需求失效。 */
  forgetDocument(name: string): void {
    for (const [ws, state] of this.connections) {
      state.active.delete(name);
      state.blocked.delete(name);
      if (state.active.size === 0 && state.blocked.size === 0) this.connections.delete(ws);
    }
  }

  /** 控制帧和广播触发排水追赶；确定性超限不参与 30 秒慢连接超时。 */
  reconcile(): void {
    for (const [ws, state] of this.connections) {
      if (ws.readyState !== 1) {
        this.connections.delete(ws);
        continue;
      }
      if (state.active.size === 0) continue;
      if (Date.now() - state.since > 30_000) {
        this.connections.delete(ws);
        try {
          ws.close(1013, SLOW_CONSUMER_RESYNC_TIMEOUT_REASON);
        } catch (error) {
          this.reportFailure("close", error);
        }
        continue;
      }
      const pending = [...state.active];
      while (pending.length > 0 && this.options.buffered(ws) <= 64 * 1024) {
        const name = pending.shift()!;
        if (this.options.pending(ws, name)) {
          pending.push(name);
          break;
        }
        const snapshot = this.snapshot(name);
        if (!snapshot) continue;
        const delivery = this.options.deliver(ws, name, snapshot.generation, snapshot.update);
        if (delivery.reason === "too_large") {
          this.block(ws, name);
          continue;
        }
        if (delivery.completion) {
          void delivery.completion.then((result) => this.rejected(ws, name, snapshot.generation, result));
        } else if (!delivery.ok) {
          pending.push(name);
          break;
        }
      }
      state.active = new Set(pending);
      if (state.active.size === 0 && state.blocked.size === 0) {
        this.connections.delete(ws);
        this.options.reportLog?.("[YJS-BROADCAST] lagging connection recovery dispatched");
      }
    }
  }

  /** 保存容量阻塞事实，等待数据变化，而非遗忘接收端仍缺少完整基线。 */
  private block(ws: WsConnection, name: string): void {
    const state = this.state(ws);
    state.active.delete(name);
    state.blocked.add(name);
    this.options.reportLog?.(`[YJS-BROADCAST] recovery snapshot exceeds transfer budget: prefix=${name.split(":")[0]}`);
  }

  /** 首次丢帧时建立连接级状态，不保存快照正文。 */
  private state(ws: WsConnection): RecoveryState {
    let state = this.connections.get(ws);
    if (!state) {
      state = { since: Date.now(), active: new Set(), blocked: new Set() };
      this.connections.set(ws, state);
      this.options.reportLog?.("[YJS-BROADCAST] connection lagging: threshold=65536");
    }
    return state;
  }

  /** 每次恢复读取当前投影，编码异常保留诊断且隔离到该文档。 */
  private snapshot(name: string): { generation: string; update: Uint8Array } | null {
    const doc = this.options.document(name);
    if (!doc) return null;
    try {
      return { generation: doc.generation, update: Y.encodeStateAsUpdate(doc.ydoc) };
    } catch (error) {
      this.reportFailure(`snapshot prefix=${name.split(":")[0]}`, error);
      return null;
    }
  }

  /** 日志只记录失败阶段和错误类型，不包含正文或原始异常消息。 */
  private reportFailure(stage: string, error: unknown): void {
    this.options.reportLog?.(
      `[YJS-BROADCAST] recovery ${stage} failed: error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}
