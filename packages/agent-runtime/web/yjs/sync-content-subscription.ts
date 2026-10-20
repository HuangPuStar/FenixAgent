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
  /** 释放已不驻留的块：由宿主导出 Y.Doc / 投影镜像，订阅侧已先将其移出 `retainedDocs`。 */
  readonly releaseDoc: (docId: string) => void;
  /** 已订阅块驻留上限；缺省沿用窗口模块的 `SYNC_HISTORY_MAX_RETAINED_BLOCKS`。 */
  readonly maxRetainedBlocks?: number;
  /** 首屏订阅块数；缺省沿用窗口模块的 `SYNC_HISTORY_INITIAL_BLOCKS`。 */
  readonly initialBlocks?: number;
  readonly onSubscribed: (docIds: readonly string[]) => void;
  readonly onHistoryState: (state: {
    readonly hasEarlier: boolean;
    readonly hasLater: boolean;
    readonly loading: boolean;
  }) => void;
  readonly hiddenMessageCount: () => number;
  readonly growProjectionWindow: () => void;
  /** 页目录中是否还有更早的页尚未订阅；与内容窗口共同决定“显示更早”入口。 */
  readonly hasEarlierPages?: () => boolean;
  /** 订阅上一页目录；返回 false 表示无法发出请求。 */
  readonly requestEarlierPage?: () => boolean;
  readonly fail: (code: string, message: string) => void;
}

export interface SyncContentSubscription {
  reset(): void;
  /** 目录更新：initial=true 表示本轮是目录基线（用于首次窗口裁决）。 */
  applyDirectory(docIds: readonly string[], initial: boolean): void;
  /** 用户显式加载更早历史；返回是否产生了新工作。 */
  loadEarlier(docIds: readonly string[]): boolean;
  /** 用户向下阅读、补齐中间缺口；返回是否产生了新工作。 */
  loadLater(docIds: readonly string[]): boolean;
  /**
   * 回到最新位置：有界定位目录末尾窗口并等待基线完成。
   * 返回 true 表示最新区间已就绪（或本来就已驻留），false 表示超时/无法定位。
   */
  returnToLatest(docIds: readonly string[]): Promise<boolean>;
  /**
   * 更早页的 DOC_BASE 到达：若上一批 `loadEarlier` 在等页目录，自动续订这批更早块。
   * 返回是否继续产生了订阅请求。
   */
  notePageLoaded(docIds: readonly string[]): boolean;
  /** 内容 DOC_BASE 到达；清除该块的等待状态。 */
  noteBase(docId: string): void;
  /** 投影变化后刷新“是否还有更早”状态（不触发订阅）。 */
  refreshHistoryState(hiddenMessageCount?: number): void;
  hasEarlier(): boolean;
  hasLater(): boolean;
}

export function createSyncContentSubscription(deps: SyncContentSubscriptionDeps): SyncContentSubscription {
  const window = createSyncContentWindow({
    initialBlocks: deps.initialBlocks ?? SYNC_HISTORY_INITIAL_BLOCKS,
    maxRetainedBlocks: deps.maxRetainedBlocks,
  });
  const pendingHistoryDocs = new Set<string>();
  /** 向下补缺口时在途的块；超时必须放回 `later`，否则窗口会永久少一段。 */
  const pendingLaterDocs = new Set<string>();
  /** 已收到 DOC_BASE 的块；“回到最新”据此只等待真正缺失的基线。 */
  const basedDocs = new Set<string>();
  const latestPendingDocs = new Set<string>();
  let latestWaiter: ((ready: boolean) => void) | null = null;
  let loading = false;
  /** 已请求上一页目录、但页 DOC_BASE 尚未到达；此时不能再发页请求。 */
  let pageLoading = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pageTimer: ReturnType<typeof setTimeout> | null = null;
  let laterTimer: ReturnType<typeof setTimeout> | null = null;
  let latestTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function clearPageTimer(): void {
    if (pageTimer !== null) clearTimeout(pageTimer);
    pageTimer = null;
  }

  function clearLatestTimer(): void {
    if (latestTimer !== null) clearTimeout(latestTimer);
    latestTimer = null;
  }

  function clearLaterTimer(): void {
    if (laterTimer !== null) clearTimeout(laterTimer);
    laterTimer = null;
  }

  /** 三类在途批次与页请求共用 `loading`：任何一批未落地都不能让入口误报空闲。 */
  function updateLoading(): void {
    loading = pageLoading || pendingHistoryDocs.size > 0 || pendingLaterDocs.size > 0 || latestPendingDocs.size > 0;
  }

  /** 等待基线的块不进入释放候选；否则后续 DOC_BASE 会被当作未订阅帧丢弃。 */
  function protectedDocs(): ReadonlySet<string> {
    const union = new Set(pendingHistoryDocs);
    for (const docId of pendingLaterDocs) union.add(docId);
    for (const docId of latestPendingDocs) union.add(docId);
    return union;
  }

  function resolveLatest(ready: boolean): void {
    const waiter = latestWaiter;
    latestWaiter = null;
    waiter?.(ready);
  }

  function emitHistoryState(hiddenMessageCount = deps.hiddenMessageCount()): void {
    deps.onHistoryState({
      hasEarlier: window.hasEarlier() || hiddenMessageCount > 0 || pageLoading || (deps.hasEarlierPages?.() ?? false),
      hasLater: window.hasLater() || pendingLaterDocs.size > 0,
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
      updateLoading();
      emitHistoryState();
    }, HISTORY_BASE_TIMEOUT_MS);
  }

  function scheduleLaterTimeout(): void {
    clearLaterTimer();
    laterTimer = setTimeout(() => {
      laterTimer = null;
      if (pendingLaterDocs.size === 0) return;
      window.restoreLater([...pendingLaterDocs]);
      pendingLaterDocs.clear();
      updateLoading();
      emitHistoryState();
    }, HISTORY_BASE_TIMEOUT_MS);
  }

  function endPageWait(): void {
    clearPageTimer();
    pageLoading = false;
    updateLoading();
  }

  function schedulePageTimeout(): void {
    clearPageTimer();
    // 页基线超时只解除等待，不把连接判死：用户可再次点击，页仍可能在后续到达。
    pageTimer = setTimeout(() => {
      pageTimer = null;
      if (!pageLoading) return;
      endPageWait();
      emitHistoryState();
    }, HISTORY_BASE_TIMEOUT_MS);
  }

  function releaseContentDocs(docIds: readonly string[]): void {
    for (const docId of docIds) {
      if (!deps.retainedDocs.delete(docId)) continue;
      basedDocs.delete(docId);
      deps.releaseDoc(docId);
    }
  }

  /** 加载更早内容的单一实现；`loadEarlier` 与页到达后的自动续订共用。 */
  function loadEarlierInternal(docIds: readonly string[]): boolean {
    if (loading) return false;
    // 已订阅块内仍有被投影窗口挡住的条目：先扩大投影窗口，不产生网络请求。
    if (deps.hiddenMessageCount() > 0) {
      deps.growProjectionWindow();
      emitHistoryState();
      return true;
    }
    if (window.hasEarlier()) {
      const plan = window.loadEarlier(docIds, deps.retainedDocs, SYNC_HISTORY_LOAD_BLOCKS);
      if (plan.retain.length === 0) {
        emitHistoryState();
        return false;
      }
      // 双向淘汰：向历史方向扩展时释放最新块，并等新批次基线到达后再结束 loading。
      releaseContentDocs(plan.release);
      for (const docId of plan.retain) pendingHistoryDocs.add(docId);
      updateLoading();
      if (!retainAndSubscribe(plan.retain, "currentHistory", "pending")) {
        window.restoreEarlier(plan.retain);
        pendingHistoryDocs.clear();
        updateLoading();
        emitHistoryState();
        return false;
      }
      // 先扩一档窗口，保证新到的更早块不会被“最近 N 条”再次挡掉；剩余条目由下一次点击继续揭示。
      deps.growProjectionWindow();
      scheduleTimeout();
      emitHistoryState();
      return true;
    }
    // 已知内容块已全部订阅：若页目录还有更早页，先订阅上一页，页基线到达后自动续订内容。
    if (deps.hasEarlierPages?.()) {
      pageLoading = true;
      updateLoading();
      emitHistoryState();
      schedulePageTimeout();
      if (!(deps.requestEarlierPage?.() ?? false)) {
        endPageWait();
        emitHistoryState();
        return false;
      }
      return true;
    }
    emitHistoryState();
    return false;
  }

  /** 向下补中间缺口；与 loadEarlier 对称，只取一批并等待基线。 */
  function loadLaterInternal(docIds: readonly string[]): boolean {
    if (loading) return false;
    const plan = window.loadLater(docIds, deps.retainedDocs, SYNC_HISTORY_LOAD_BLOCKS, protectedDocs());
    if (plan.retain.length === 0) {
      emitHistoryState();
      return false;
    }
    releaseContentDocs(plan.release);
    for (const docId of plan.retain) pendingLaterDocs.add(docId);
    updateLoading();
    if (!retainAndSubscribe(plan.retain, "currentHistory", "pending")) {
      window.restoreLater(plan.retain);
      pendingLaterDocs.clear();
      updateLoading();
      emitHistoryState();
      return false;
    }
    // 缺口块可能落在投影窗口之外；向下补一批的同时扩一档，保证加载结果立即可见。
    deps.growProjectionWindow();
    scheduleLaterTimeout();
    emitHistoryState();
    return true;
  }

  /**
   * 回到最新：只定位目录末尾窗口，释放其余驻留块并等待缺口基线；不在本次恢复全部 later。
   * 最新区间已全部有基线时立即就绪，避免无意义等待。
   */
  function returnToLatestInternal(docIds: readonly string[]): Promise<boolean> {
    const latest = window.latestDocIds(docIds);
    if (latest.length === 0) return Promise.resolve(false);
    clearLatestTimer();
    resolveLatest(false);
    const plan = window.focusLatest(docIds, deps.retainedDocs, protectedDocs());
    latestPendingDocs.clear();
    releaseContentDocs(plan.release);
    const missing = latest.filter((docId) => !basedDocs.has(docId));
    if (missing.length === 0) {
      updateLoading();
      emitHistoryState();
      return Promise.resolve(true);
    }
    const ready = new Promise<boolean>((resolve) => {
      latestWaiter = resolve;
    });
    for (const docId of missing) latestPendingDocs.add(docId);
    updateLoading();
    if (!retainAndSubscribe(missing, "currentHistory", "pending")) {
      latestPendingDocs.clear();
      updateLoading();
      resolveLatest(false);
      emitHistoryState();
      return Promise.resolve(false);
    }
    scheduleLatestTimeout();
    emitHistoryState();
    return ready;
  }

  function scheduleLatestTimeout(): void {
    clearLatestTimer();
    latestTimer = setTimeout(() => {
      latestTimer = null;
      if (latestPendingDocs.size === 0) return;
      latestPendingDocs.clear();
      updateLoading();
      emitHistoryState();
      resolveLatest(false);
    }, HISTORY_BASE_TIMEOUT_MS);
  }

  function applyDirectory(docIds: readonly string[], initial: boolean): void {
    // 等待 DOC_BASE 的历史批次仍在 retainedDocs 中，但此刻释放会让后续基线帧被忽略、
    // 加载只能超时；目录刷新必须把这些块排除在释放候选之外。
    const plan = window.plan(docIds, deps.retainedDocs, initial, protectedDocs());
    // 先释放再订阅：释放只作用于已驻留块，订阅批次不会与释放批次重叠。
    releaseContentDocs(plan.release);
    if (plan.retain.length > 0 && !retainAndSubscribe(plan.retain, "currentHistory", initial ? "initial" : "pending")) {
      return;
    }
    emitHistoryState();
  }

  return {
    reset(): void {
      clearTimer();
      clearPageTimer();
      clearLaterTimer();
      clearLatestTimer();
      pageLoading = false;
      window.reset();
      pendingHistoryDocs.clear();
      pendingLaterDocs.clear();
      basedDocs.clear();
      latestPendingDocs.clear();
      resolveLatest(false);
      loading = false;
      emitHistoryState(0);
    },

    applyDirectory,

    loadEarlier(docIds): boolean {
      return loadEarlierInternal(docIds);
    },

    loadLater(docIds): boolean {
      return loadLaterInternal(docIds);
    },

    returnToLatest(docIds): Promise<boolean> {
      return returnToLatestInternal(docIds);
    },

    notePageLoaded(docIds): boolean {
      // 只有等待页目录的请求才自动续订内容；首屏最新页或迟到页仅刷新入口状态。
      if (!pageLoading) {
        emitHistoryState();
        return false;
      }
      endPageWait();
      emitHistoryState();
      return loadEarlierInternal(docIds);
    },

    noteBase(docId): void {
      const wasEarlier = pendingHistoryDocs.delete(docId);
      const wasLater = pendingLaterDocs.delete(docId);
      const wasLatest = latestPendingDocs.delete(docId);
      basedDocs.add(docId);
      // 超时后迟到的基线也要从更早集合移除，否则按钮会在该块已到达后继续提示可加载。
      window.consumeEarlier([docId]);
      if (wasEarlier && pendingHistoryDocs.size === 0) clearTimer();
      if (wasLater && pendingLaterDocs.size === 0) clearLaterTimer();
      if (wasLatest && latestPendingDocs.size === 0) {
        clearLatestTimer();
        resolveLatest(true);
      }
      updateLoading();
      emitHistoryState();
    },

    refreshHistoryState(hiddenMessageCount): void {
      emitHistoryState(hiddenMessageCount);
    },

    hasEarlier(): boolean {
      return window.hasEarlier() || deps.hiddenMessageCount() > 0 || pageLoading || (deps.hasEarlierPages?.() ?? false);
    },

    hasLater(): boolean {
      return window.hasLater() || pendingLaterDocs.size > 0;
    },
  };
}
