import * as Y from "yjs";
import { SLOW_CONSUMER_RESYNC_TIMEOUT_REASON } from "../transport/ws-close-codes";
import type { WsConnection } from "./connection-types";
import type { LegacyFrameDelivery } from "./fragment-delivery";

interface RecoveryState {
  since: number;
  active: Set<string>;
  blocked: Map<string, number>;
}

interface RecoverySnapshot {
  generation: string;
  update: Uint8Array;
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
  private readonly capacityChecks = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: RecoveryOptions) {}

  /** 临时丢帧进入有界追赶；容量阻塞仅在文档变化后重新尝试。 */
  mark(ws: WsConnection, name: string): void {
    const state = this.state(ws);
    if (state.blocked.has(name)) return;
    if (state.active.size === 0) state.since = Date.now();
    state.active.add(name);
  }

  /** 同一文档的流式变化合并为每秒至多一次重查，末次变化也不能漏掉恢复。 */
  retryBlocked(ws: WsConnection, name: string): boolean {
    const state = this.connections.get(ws);
    if (!state?.blocked.has(name)) return false;
    if (!this.capacityChecks.has(name)) {
      this.capacityChecks.set(
        name,
        setTimeout(() => {
          this.capacityChecks.delete(name);
          this.recheckCapacity(name);
        }, 1_000),
      );
    }
    return true;
  }

  /** 能力协商提升预算时重查旧阻塞；保留基线需求，覆盖握手期间尚未交付的增量。 */
  increaseBudget(ws: WsConnection, limitBytes: number): void {
    const state = this.connections.get(ws);
    if (!state) return;
    for (const [name, previous] of state.blocked) {
      if (previous >= limitBytes) continue;
      state.blocked.set(name, limitBytes);
      this.retryBlocked(ws, name);
    }
  }

  /** 广播热路径不编码恢复快照；所有连接共用一次延后容量检查。 */
  rejected(ws: WsConnection, name: string, generation: string, result: LegacyFrameDelivery): void {
    if (result.ok || ws.readyState !== 1) return;
    const doc = this.options.document(name);
    if (!doc || doc.generation !== generation) return;
    if (result.reason === "too_large") {
      this.block(ws, name, result.limitBytes);
      this.retryBlocked(ws, name);
      return;
    }
    this.mark(ws, name);
  }

  /** 连接关闭立即回收全部恢复记录。 */
  forgetConnection(ws: WsConnection): void {
    this.connections.delete(ws);
    for (const name of this.capacityChecks.keys()) {
      if (![...this.connections.values()].some((state) => state.blocked.has(name))) this.clearCapacityCheck(name);
    }
  }

  /** 文档注销与权威替换使旧基线需求失效。 */
  forgetDocument(name: string): void {
    this.clearCapacityCheck(name);
    for (const [ws, state] of this.connections) {
      state.active.delete(name);
      state.blocked.delete(name);
      if (state.active.size === 0 && state.blocked.size === 0) this.connections.delete(ws);
    }
  }

  /** 控制帧和广播触发排水追赶；确定性超限不参与 30 秒慢连接超时。 */
  reconcile(): void {
    this.reconcileSnapshots(new Map());
  }

  /** 一轮排水中所有连接共享同一文档快照，避免按连接重复分配大载荷。 */
  private reconcileSnapshots(snapshots: Map<string, RecoverySnapshot | null>): void {
    for (const [ws, state] of this.connections) {
      if (ws.readyState !== 1) {
        this.forgetConnection(ws);
        continue;
      }
      if (state.active.size === 0) continue;
      if (Date.now() - state.since > 30_000) {
        this.forgetConnection(ws);
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
        if (!snapshots.has(name)) snapshots.set(name, this.snapshot(name));
        const snapshot = snapshots.get(name);
        if (!snapshot) continue;
        const delivery = this.options.deliver(ws, name, snapshot.generation, snapshot.update);
        if (delivery.reason === "too_large") {
          this.block(ws, name, delivery.limitBytes);
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
  private block(ws: WsConnection, name: string, limitBytes: number): void {
    const state = this.state(ws);
    state.active.delete(name);
    state.blocked.set(name, limitBytes);
    this.options.reportLog?.(`[YJS-BROADCAST] recovery snapshot exceeds transfer budget: prefix=${name.split(":")[0]}`);
  }

  /** 首次丢帧时建立连接级状态，不保存快照正文。 */
  private state(ws: WsConnection): RecoveryState {
    let state = this.connections.get(ws);
    if (!state) {
      state = { since: Date.now(), active: new Set(), blocked: new Map() };
      this.connections.set(ws, state);
      this.options.reportLog?.("[YJS-BROADCAST] connection lagging: threshold=65536");
    }
    return state;
  }

  /** 每次恢复读取当前投影，编码异常保留诊断且隔离到该文档。 */
  private snapshot(name: string): RecoverySnapshot | null {
    const doc = this.options.document(name);
    if (!doc) return null;
    try {
      return { generation: doc.generation, update: Y.encodeStateAsUpdate(doc.ydoc) };
    } catch (error) {
      this.reportFailure(`snapshot prefix=${name.split(":")[0]}`, error);
      return null;
    }
  }

  /** 容量尚未恢复时保持 blocked，不能因 socket 背压重新开始慢连接倒计时。 */
  private recheckCapacity(name: string): void {
    const snapshot = this.snapshot(name);
    if (!snapshot) return;
    for (const [ws, state] of this.connections) {
      const limit = state.blocked.get(name);
      if (limit === undefined) continue;
      if (ws.readyState !== 1) {
        this.forgetConnection(ws);
        continue;
      }
      if (snapshot.update.length > limit) continue;
      state.blocked.delete(name);
      this.mark(ws, name);
    }
    this.reconcileSnapshots(new Map([[name, snapshot]]));
  }

  /** 文档换代及最后一个阻塞连接释放时立即取消尾触发任务。 */
  private clearCapacityCheck(name: string): void {
    const timer = this.capacityChecks.get(name);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.capacityChecks.delete(name);
  }

  /** 日志只记录失败阶段和错误类型，不包含正文或原始异常消息。 */
  private reportFailure(stage: string, error: unknown): void {
    this.options.reportLog?.(
      `[YJS-BROADCAST] recovery ${stage} failed: error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}
