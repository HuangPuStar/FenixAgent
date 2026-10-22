// packages/agent-runtime/web/yjs/sync-hydration-tracker.ts
// 新协议首批基线的完成判定：MANIFEST 后等待入口 Doc + 目录发现的内容块的 DOC_BASE，
// 且对应投递必须收到 processed APPLY_ACK（客户端唯一 apply 入口的真实结果）。
//
// 为什么不能只看 DOC_BASE 到达：帧到达只说明入站，真正的基线可能被 DocHub 拒绝
// （base-not-ready / sequence-gap / apply-failed），随后由 RESYNC 重建。ACK 才是
// 「这块基线已被客户端接受」的确定性事实。
//
// 超时是兜底：某个 base/ACK 丢失时不能让展示层永久停在 hydrating。transport 的
// base 超时与展示层 maxWait 相互独立。

import { recordBrowserEvent } from "@fenix/web-runtime/telemetry/events";

/** 基线等待上限（兜底）：base/ACK 丢失或延迟时按「已尽力送达」解除。 */
export const SYNC_BASE_TIMEOUT_MS = 5_000;

export interface SyncHydrationTrackerOptions {
  readonly onHydratingChange: (hydrating: boolean) => void;
  readonly timeoutMs?: number;
}

export interface SyncHydrationTracker {
  /** MANIFEST 到达：重新开始等待给定 Doc 集合的 base + ACK。 */
  begin(docIds: Iterable<string>): void;
  /** 目录发现新的内容块：首批 hydrate 期间纳入等待集合。 */
  addPending(docIds: Iterable<string>): void;
  /**
   * 目录基线晚于入口 Doc ACK 时重新打开首批等待（只用于首次窗口内的内容块）：
   * 否则入口 Doc 先完成动作会让 UI 在内容块到达前放行，首屏出现“先空/半截再补齐”。
   */
  extendInitial(docIds: Iterable<string>): void;
  /** 收到某个 Doc 的 DOC_BASE；deliveryId 缺失时按到达即完成（防御性降级）。 */
  noteBase(docId: string, deliveryId: string | null): void;
  /** 收到 processed APPLY_ACK：只有与当前 base delivery 匹配才推进。 */
  noteAck(deliveryId: string): void;
  /** 清理（重连/关闭）：取消计时并遗忘本轮基线。 */
  reset(): void;
  /** 首批基线是否已完成（后续目录新增块不再阻塞展示）。 */
  isDone(): boolean;
  dispose(): void;
}

export function createSyncHydrationTracker(options: SyncHydrationTrackerOptions): SyncHydrationTracker {
  const timeoutMs = options.timeoutMs ?? SYNC_BASE_TIMEOUT_MS;
  let pendingDocs = new Set<string>();
  /** docId → 当前等待 ACK 的 base deliveryId。 */
  let pendingDelivery = new Map<string, string>();
  /** deliveryId → docId（ACK 只携带 deliveryId）。 */
  let deliveryDoc = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  let hydrating = false;
  let startedAt = 0;

  function setHydrating(next: boolean): void {
    if (hydrating === next) return;
    if (next) startedAt = performance.now();
    hydrating = next;
    options.onHydratingChange(next);
  }

  function cancelTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function clearDeliveries(): void {
    pendingDelivery = new Map();
    deliveryDoc = new Map();
  }

  function finish(success = true): void {
    if (hydrating) recordBrowserEvent(success ? "history_ready" : "history_failure", performance.now() - startedAt);
    cancelTimer();
    pendingDocs.clear();
    clearDeliveries();
    done = true;
    setHydrating(false);
  }

  function scheduleTimeout(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      // 超时按「基线已尽力送达」处理：展示层还有 maxWait 兜底，宁可显示已有内容。
      finish(false);
    }, timeoutMs);
  }

  function settleDoc(docId: string): void {
    pendingDocs.delete(docId);
    const deliveryId = pendingDelivery.get(docId);
    if (deliveryId !== undefined) {
      pendingDelivery.delete(docId);
      deliveryDoc.delete(deliveryId);
    }
    if (pendingDocs.size === 0) finish();
  }

  return {
    begin(docIds: Iterable<string>): void {
      cancelTimer();
      pendingDocs = new Set(docIds);
      clearDeliveries();
      done = false;
      if (pendingDocs.size === 0) {
        finish();
        return;
      }
      setHydrating(true);
      scheduleTimeout();
    },
    addPending(docIds: Iterable<string>): void {
      if (done) return;
      for (const docId of docIds) pendingDocs.add(docId);
    },
    extendInitial(docIds: Iterable<string>): void {
      const ids = [...docIds];
      if (ids.length === 0) return;
      if (done) {
        done = false;
        pendingDocs = new Set();
        clearDeliveries();
        setHydrating(true);
        scheduleTimeout();
      }
      for (const docId of ids) pendingDocs.add(docId);
    },
    noteBase(docId: string, deliveryId: string | null): void {
      if (done || !pendingDocs.has(docId)) return;
      if (deliveryId === null) {
        // 帧结构异常时退化为「到达即完成」，避免展示层被单帧永久卡住。
        settleDoc(docId);
        return;
      }
      const previous = pendingDelivery.get(docId);
      if (previous !== undefined) deliveryDoc.delete(previous);
      pendingDelivery.set(docId, deliveryId);
      deliveryDoc.set(deliveryId, docId);
    },
    noteAck(deliveryId: string): void {
      if (done) return;
      const docId = deliveryDoc.get(deliveryId);
      if (docId === undefined || pendingDelivery.get(docId) !== deliveryId) return;
      settleDoc(docId);
    },
    reset(): void {
      cancelTimer();
      pendingDocs.clear();
      clearDeliveries();
      done = false;
      // 与 transport 的显式 `hydrating:false` 对齐；下一轮 begin 必须重新通知 true。
      hydrating = false;
    },
    isDone(): boolean {
      return done;
    },
    dispose(): void {
      cancelTimer();
      pendingDocs.clear();
      clearDeliveries();
      done = true;
    },
  };
}
