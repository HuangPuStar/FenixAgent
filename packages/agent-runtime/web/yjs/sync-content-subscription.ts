// packages/agent-runtime/web/yjs/sync-content-subscription.ts
// 内容块订阅编排：把窗口裁决（sync-content-window）落到 retain / SUBSCRIBE / 基线完成判定。
//
// 三个边界：
// 1. 只订阅窗口给出的块；未订阅块不会 retain，content 旁路会直接忽略它们的帧。
// 2. “加载更早”先消费当前已加载 Doc 内被投影窗口挡住的条目，再请求更早块；两类动作统一为一个入口。
// 3. 请求发出后以 DOC_BASE 到达为完成信号；超时把未到达的块放回更早集合，按钮不会永久消失。

import { createSyncContentWindow, SYNC_HISTORY_INITIAL_BLOCKS, SYNC_HISTORY_LOAD_BLOCKS } from "./sync-content-window";
import type { SyncHydrationTracker } from "./sync-hydration-tracker";

/** 历史块基线等待上限：超时只恢复按钮，不把连接判死（块仍可能在后续到达）。 */
const HISTORY_BASE_TIMEOUT_MS = 5_000;

export type SubscribePriority = "live" | "currentHistory";

export interface SyncContentSubscriptionDeps {
  readonly retainedDocs: Set<string>;
  readonly hydration: Pick<SyncHydrationTracker, "addPending" | "extendInitial">;
  readonly subscribe: (docIds: readonly string[], priority: SubscribePriority) => boolean;
  readonly retainDoc: (docId: string) => void;
  readonly onSubscribed: (docIds: readonly string[]) => void;
  readonly onHistoryState: (state: { readonly hasEarlier: boolean; readonly loading: boolean }) => void;
  readonly hiddenMessageCount: () => number;
  readonly growProjectionWindow: () => void;
  readonly fail: (code: string, message: string) => void;
}

export interface SyncContentSubscription {
  reset(): void;
  /** 目录更新：initial=true 表示本轮是目录基线（用于首次窗口裁决）。 */
  applyDirectory(docIds: readonly string[], initial: boolean): void;
  /** 用户显式加载更早历史；返回是否产生了新工作。 */
  loadEarlier(docIds: readonly string[]): boolean;
  /** 内容 DOC_BASE 到达；清除该块的等待状态。 */
  noteBase(docId: string): void;
  /** 投影变化后刷新“是否还有更早”状态（不触发订阅）。 */
  refreshHistoryState(hiddenMessageCount?: number): void;
  hasEarlier(): boolean;
}

export function createSyncContentSubscription(deps: SyncContentSubscriptionDeps): SyncContentSubscription {
  const window = createSyncContentWindow({ initialBlocks: SYNC_HISTORY_INITIAL_BLOCKS });
  const pendingHistoryDocs = new Set<string>();
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function emitHistoryState(hiddenMessageCount = deps.hiddenMessageCount()): void {
    deps.onHistoryState({
      hasEarlier: window.hasEarlier() || hiddenMessageCount > 0,
      loading,
    });
  }

  function retainAndSubscribe(
    docIds: readonly string[],
    priority: SubscribePriority,
    hydrationMode: "initial" | "pending" | "none",
  ): boolean {
    if (docIds.length === 0) return true;
    for (const docId of docIds) {
      if (!deps.retainedDocs.has(docId)) {
        try {
          deps.retainDoc(docId);
        } catch (error) {
          deps.fail("MALFORMED_FRAME", error instanceof Error ? error.message : "failed to retain sync doc");
          return false;
        }
        deps.retainedDocs.add(docId);
      }
    }
    // 首批窗口内的块即使晚于入口 Doc ACK 到达，也要重新纳入 hydrate 等待，避免首屏半截。
    if (hydrationMode === "initial") deps.hydration.extendInitial(docIds);
    else if (hydrationMode === "pending") deps.hydration.addPending(docIds);
    if (!deps.subscribe(docIds, priority)) {
      deps.fail("CAPACITY_EXCEEDED", "socket is saturated while sending content SUBSCRIBE");
      return false;
    }
    deps.onSubscribed(docIds);
    return true;
  }

  function scheduleTimeout(): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (pendingHistoryDocs.size === 0) return;
      // 未到达的块放回更早集合：已 retain 的 Doc 保留（下一轮只重发 SUBSCRIBE，不重复 retain）。
      window.restoreEarlier([...pendingHistoryDocs]);
      pendingHistoryDocs.clear();
      loading = false;
      emitHistoryState();
    }, HISTORY_BASE_TIMEOUT_MS);
  }

  return {
    reset(): void {
      clearTimer();
      window.reset();
      pendingHistoryDocs.clear();
      loading = false;
      emitHistoryState(0);
    },

    applyDirectory(docIds, initial): void {
      const plan = window.plan(docIds, deps.retainedDocs, initial);
      if (
        plan.retain.length > 0 &&
        !retainAndSubscribe(plan.retain, "currentHistory", initial ? "initial" : "pending")
      ) {
        return;
      }
      emitHistoryState();
    },

    loadEarlier(docIds): boolean {
      if (loading) return false;
      // 已订阅块内仍有被投影窗口挡住的条目：先扩大投影窗口，不产生网络请求。
      if (deps.hiddenMessageCount() > 0) {
        deps.growProjectionWindow();
        emitHistoryState();
        return true;
      }
      if (!window.hasEarlier()) {
        emitHistoryState();
        return false;
      }
      const batch = window.peekEarlier(docIds, SYNC_HISTORY_LOAD_BLOCKS);
      if (batch.length === 0) {
        emitHistoryState();
        return false;
      }
      loading = true;
      for (const docId of batch) pendingHistoryDocs.add(docId);
      if (!retainAndSubscribe(batch, "currentHistory", "pending")) {
        pendingHistoryDocs.clear();
        loading = false;
        emitHistoryState();
        return false;
      }
      window.consumeEarlier(batch);
      // 先扩一档窗口，保证新到的更早块不会被“最近 N 条”再次挡掉；剩余条目由下一次点击继续揭示。
      deps.growProjectionWindow();
      scheduleTimeout();
      emitHistoryState();
      return true;
    },

    noteBase(docId): void {
      const wasPending = pendingHistoryDocs.delete(docId);
      // 超时后迟到的基线也要从更早集合移除，否则按钮会在该块已到达后继续提示可加载。
      window.consumeEarlier([docId]);
      if (wasPending && pendingHistoryDocs.size === 0) {
        clearTimer();
        loading = false;
      }
      emitHistoryState();
    },

    refreshHistoryState(hiddenMessageCount): void {
      emitHistoryState(hiddenMessageCount);
    },

    hasEarlier(): boolean {
      return window.hasEarlier() || deps.hiddenMessageCount() > 0;
    },
  };
}
