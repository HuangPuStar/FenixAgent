// packages/agent-runtime/web/yjs/sync-content-window.ts
// content Doc 订阅窗口：目录按页发现历史块，首屏只订阅最近 N 块，窗口向两端有界淘汰。
//
// 为什么按目录顺序而不是 blockIndex：目录是 ordinalStart 排序的权威顺序；历史导入块与 live
// 轮换块的 blockIndex 来源不同，不能单独作为全局时间序。窗口只裁决「哪些块先订阅」，不改变
// 目录与投影的排序规则。
//
// 双向淘汰与双向读取：
// - live 追加把窗口向前推，最旧的已订阅块移入 `earlier`（仍可重新加载）；
// - 显式加载更早历史把窗口向后拉，超过驻留预算时释放除最新块外的已订阅块并移入 `later`，
//   避免“加载越早、驻留越多”，也避免下一次目录刷新把它们自动订阅回来；最新块（live tail）
//   始终保留，否则流式回复会随淘汰一并消失；
// - `later` 不是“不存在”：向下阅读可经 `loadLater` 按目录顺序重新加载；`focusLatest` 只定位
//   目录末尾窗口（“回到最新”），不会无界恢复所有缺口。

/** 首屏订阅的最近内容块数。单块目标载荷 128KiB，四块把首屏下行控制在约 512KiB 量级。 */
export const SYNC_HISTORY_INITIAL_BLOCKS = 4;
/** 每次“显示更早”加载的内容块数。 */
export const SYNC_HISTORY_LOAD_BLOCKS = 4;
/**
 * 已 retain 内容块的驻留上限（首屏 + 连续追加 + 显式加载共用）。
 *
 * 只靠首屏窗口无法阻止 live 追加把订阅集合推大；超过此上限时按目录顺序释放窗口边缘的块，
 * 让 Y.Doc / 投影副本可以回收。被释放的块重新进入“更早”集合（或 `later`），仍可再次加载。
 */
export const SYNC_HISTORY_MAX_RETAINED_BLOCKS = 12;

export interface ContentWindowPlan {
  /** 本轮应新订阅的块（按目录顺序）。 */
  readonly retain: readonly string[];
  /** 本轮应释放的已订阅块（按目录顺序，最旧优先）。 */
  readonly release: readonly string[];
  /** 目录中是否还有未订阅的更早块。 */
  readonly hasEarlier: boolean;
}

export interface ContentWindowLoadPlan {
  /** 本轮从 `earlier` 取出的块（按目录顺序，旧 → 新）。 */
  readonly retain: readonly string[];
  /** 为保持驻留预算而释放的已订阅块（不含最新块，按目录顺序，旧 → 新）。 */
  readonly release: readonly string[];
  readonly hasEarlier: boolean;
}

export interface SyncContentWindowOptions {
  readonly initialBlocks?: number;
  /** 已订阅块驻留上限；缺省 `SYNC_HISTORY_MAX_RETAINED_BLOCKS`，且不得小于首屏块数。 */
  readonly maxRetainedBlocks?: number;
}

export interface SyncContentWindow {
  /** 换代/重连：清空窗口裁决状态。 */
  reset(): void;
  /**
   * 根据最新目录与已 retain 集合计算本轮订阅：
   * - 首次（尚无内容块被 retain）保留目录末尾 `initialBlocks` 块，其余进入更早集合；
   * - 后续目录追加按位置分流：位于最旧已 retain 块之前的进入更早集合，之后的立即订阅
   *   （覆盖 live 轮换与迟到的历史导入，避免迟到历史被当成“最新块”全量订阅）。
   * - `later` 只记录被历史加载淘汰的旧块，目录刷新不会自动重新订阅；新出现的块（fresh）
   *   仍会立即订阅，保证回看历史期间实时内容不中断。
   *
   * `protectedDocIds` 中的块即使最旧且超预算也不会进入 `release`（仍在等待 DOC_BASE 的历史批次
   * 一旦被释放，后续基线帧会被忽略、加载只能超时）；它们仍计入驻留预算，因此不会凭空放大窗口。
   */
  plan(
    allDocIds: readonly string[],
    retained: ReadonlySet<string>,
    initial: boolean,
    protectedDocIds?: ReadonlySet<string>,
  ): ContentWindowPlan;
  /**
   * 从更早集合取一批，并按驻留预算释放最新的已订阅块。
   *
   * `release` 中的块进入 `later`，后续目录刷新不会自动重新订阅；释放后仍由页目录保留重新加载入口。
   */
  loadEarlier(allDocIds: readonly string[], retained: ReadonlySet<string>, batchSize?: number): ContentWindowLoadPlan;
  /**
   * 从 `later`（向历史扩展时被淘汰的较新块）按目录顺序取一批，恢复中间缺口。
   *
   * 与 `loadEarlier` 对称：越过驻留预算时释放最旧的已订阅块而不是最新块，保证 live tail
   * 与当前阅读位置仍在窗口内。`protectedDocIds`（等待基线的批次）永不进入 `release`。
   */
  loadLater(
    allDocIds: readonly string[],
    retained: ReadonlySet<string>,
    batchSize?: number,
    protectedDocIds?: ReadonlySet<string>,
  ): ContentWindowLoadPlan;
  /** 当前目录末尾 `initialBlocks` 块；用于“回到最新”的有界定位。 */
  latestDocIds(allDocIds: readonly string[]): readonly string[];
  /**
   * 有界定位最新区间：只保留目录末尾 `initialBlocks` 块，其余已驻留块进入 `earlier`。
   * 被历史加载淘汰的中间块同样回到 `earlier`，由后续“显示更早”按序取回。
   */
  focusLatest(
    allDocIds: readonly string[],
    retained: ReadonlySet<string>,
    protectedDocIds?: ReadonlySet<string>,
  ): ContentWindowLoadPlan;
  /** 订阅失败/超时：把这批 later 块放回缺口集合，允许用户重试。 */
  restoreLater(docIds: readonly string[]): void;
  /** 是否存在“中间缺口”：被 loadEarlier 淘汰到 `later` 的块尚未重新加载。 */
  hasLater(): boolean;
  /** 查看下一批更早块，不改变状态；返回顺序仍是目录顺序。 */
  peekEarlier(allDocIds: readonly string[], batchSize?: number): readonly string[];
  /** 确认这批更早块已进入订阅；从更早集合移除。 */
  consumeEarlier(docIds: readonly string[]): void;
  /** 订阅失败/超时：把这批块放回更早集合，允许用户重试。 */
  restoreEarlier(docIds: readonly string[]): void;
  hasEarlier(): boolean;
  /** 当前更早集合，按目录顺序过滤；空目录参数会丢弃已不存在的块。 */
  earlierDocIds(allDocIds: readonly string[]): readonly string[];
  /** 因向历史方向扩展而被淘汰的最新块；用于测试与诊断。 */
  laterDocIds(allDocIds: readonly string[]): readonly string[];
}

/**
 * 窗口状态只保存在客户端内存里，不进入协议：服务端仍按订阅逐块发 DOC_BASE，
 * 客户端不订阅的块不会产生下行字节。
 */
export function createSyncContentWindow(options: SyncContentWindowOptions = {}): SyncContentWindow {
  const initialBlocks = Math.max(1, Math.floor(options.initialBlocks ?? SYNC_HISTORY_INITIAL_BLOCKS));
  const maxRetainedBlocks = Math.max(
    initialBlocks,
    Math.floor(options.maxRetainedBlocks ?? SYNC_HISTORY_MAX_RETAINED_BLOCKS),
  );
  let order: string[] = [];
  let earlier = new Set<string>();
  let later = new Set<string>();
  let chosen = false;

  function refreshOrder(allDocIds: readonly string[]): void {
    order = [...new Set(allDocIds)];
    const known = new Set(order);
    for (const docId of [...earlier]) if (!known.has(docId)) earlier.delete(docId);
    for (const docId of [...later]) if (!known.has(docId)) later.delete(docId);
  }

  /**
   * 按驻留预算选择本轮释放块。
   *
   * 预算把受保护的已驻留块一并计入（不能被保护集合悄悄抬高上限）；释放候选只排除受保护块，
   * 候选不足时允许窗口暂时超出预算，与 `loadEarlier` 的既有取舍一致。
   */
  function selectRelease(
    retainedContent: readonly string[],
    incomingCount: number,
    protectedDocIds?: ReadonlySet<string>,
  ): string[] {
    const overflow = Math.max(0, retainedContent.length + incomingCount - maxRetainedBlocks);
    if (overflow === 0) return [];
    const candidates =
      protectedDocIds === undefined || protectedDocIds.size === 0
        ? retainedContent
        : retainedContent.filter((docId) => !protectedDocIds.has(docId));
    return candidates.slice(0, overflow);
  }

  function retainNewest(
    fresh: readonly string[],
    retainedContent: readonly string[],
    protectedDocIds?: ReadonlySet<string>,
  ): ContentWindowPlan {
    const keep = fresh.slice(-initialBlocks);
    earlier = new Set(fresh.slice(0, Math.max(0, fresh.length - keep.length)));
    const release = selectRelease(retainedContent, keep.length, protectedDocIds);
    for (const docId of release) earlier.add(docId);
    return { retain: keep, release, hasEarlier: earlier.size > 0 };
  }

  return {
    reset(): void {
      order = [];
      earlier = new Set();
      later = new Set();
      chosen = false;
    },

    plan(allDocIds, retained, _initial, protectedDocIds): ContentWindowPlan {
      refreshOrder(allDocIds);
      const retainedContent = order.filter((docId) => retained.has(docId));
      const fresh = order.filter((docId) => !retained.has(docId) && !earlier.has(docId) && !later.has(docId));

      if (!chosen || retainedContent.length === 0) {
        if (!chosen) later = new Set();
        chosen = true;
        return retainNewest(fresh, retainedContent, protectedDocIds);
      }

      const oldestRetained = Math.min(...retainedContent.map((docId) => order.indexOf(docId)));
      const older: string[] = [];
      const newer: string[] = [];
      for (const docId of fresh) {
        if (order.indexOf(docId) < oldestRetained) older.push(docId);
        else newer.push(docId);
      }
      for (const docId of older) earlier.add(docId);
      // later 只挡被历史加载淘汰的旧块（已通过 fresh 排除）；新出现的块始终立即订阅，
      // 否则用户回看几次历史后，流式回复与新块会永久停在 later 中不再显示。
      const retain = newer;
      const release = selectRelease(retainedContent, retain.length, protectedDocIds);
      for (const docId of release) earlier.add(docId);
      return { retain, release, hasEarlier: earlier.size > 0 };
    },

    loadEarlier(allDocIds, retained, batchSize = SYNC_HISTORY_LOAD_BLOCKS): ContentWindowLoadPlan {
      refreshOrder(allDocIds);
      const batch = order.filter((docId) => earlier.has(docId)).slice(-Math.max(1, Math.floor(batchSize)));
      if (batch.length === 0) return { retain: [], release: [], hasEarlier: earlier.size > 0 };
      const retainedContent = order.filter((docId) => retained.has(docId));
      const overflow = Math.max(0, retainedContent.length + batch.length - maxRetainedBlocks);
      // 最新 retained 块是 live tail（流式回复所在块），任何情况下都不得淘汰；
      // 可释放集合不足时只释放其余块，允许窗口暂时超出预算。
      const releasable = retainedContent.slice(0, -1);
      const releaseCount = Math.min(overflow, releasable.length);
      const release = releaseCount === 0 ? [] : releasable.slice(-releaseCount);
      for (const docId of release) later.add(docId);
      for (const docId of batch) earlier.delete(docId);
      return { retain: batch, release, hasEarlier: earlier.size > 0 };
    },

    peekEarlier(allDocIds, batchSize = SYNC_HISTORY_LOAD_BLOCKS): readonly string[] {
      refreshOrder(allDocIds);
      return order.filter((docId) => earlier.has(docId)).slice(-Math.max(1, Math.floor(batchSize)));
    },

    consumeEarlier(docIds): void {
      for (const docId of docIds) earlier.delete(docId);
    },

    restoreEarlier(docIds): void {
      for (const docId of docIds) {
        if (order.includes(docId)) {
          later.delete(docId);
          earlier.add(docId);
        }
      }
    },

    loadLater(allDocIds, retained, batchSize = SYNC_HISTORY_LOAD_BLOCKS, protectedDocIds): ContentWindowLoadPlan {
      refreshOrder(allDocIds);
      const batch = order.filter((docId) => later.has(docId)).slice(0, Math.max(1, Math.floor(batchSize)));
      if (batch.length === 0) return { retain: [], release: [], hasEarlier: earlier.size > 0 };
      const retainedContent = order.filter((docId) => retained.has(docId));
      const overflow = Math.max(0, retainedContent.length + batch.length - maxRetainedBlocks);
      // 与 loadEarlier 对称：向下补缺口时释放最旧的已订阅块，live tail（最新 retained）始终保留。
      const releasable = retainedContent
        .slice(0, -1)
        .filter((docId) => !batch.includes(docId) && !(protectedDocIds?.has(docId) ?? false));
      const release = releasable.slice(0, Math.min(overflow, releasable.length));
      for (const docId of release) {
        later.delete(docId);
        earlier.add(docId);
      }
      for (const docId of batch) {
        later.delete(docId);
        earlier.delete(docId);
      }
      return { retain: batch, release, hasEarlier: earlier.size > 0 };
    },

    latestDocIds(allDocIds): readonly string[] {
      refreshOrder(allDocIds);
      return order.slice(-initialBlocks);
    },

    focusLatest(allDocIds, retained, protectedDocIds): ContentWindowLoadPlan {
      refreshOrder(allDocIds);
      const latest = order.slice(-initialBlocks);
      const latestSet = new Set(latest);
      const retain = latest.filter((docId) => !retained.has(docId));
      const release = order.filter(
        (docId) => retained.has(docId) && !latestSet.has(docId) && !(protectedDocIds?.has(docId) ?? false),
      );
      const released = new Set(release);
      // 释放后仍未驻留的块都在最新区间之前：下一次“显示更早”按目录顺序取回。
      earlier = new Set(
        order.filter((docId) => !latestSet.has(docId) && !(retained.has(docId) && !released.has(docId))),
      );
      later = new Set();
      return { retain, release, hasEarlier: earlier.size > 0 };
    },

    restoreLater(docIds): void {
      for (const docId of docIds) {
        if (!order.includes(docId)) continue;
        earlier.delete(docId);
        later.add(docId);
      }
    },

    hasLater(): boolean {
      return later.size > 0;
    },

    hasEarlier(): boolean {
      return earlier.size > 0;
    },

    earlierDocIds(allDocIds): readonly string[] {
      refreshOrder(allDocIds);
      return order.filter((docId) => earlier.has(docId));
    },

    laterDocIds(allDocIds): readonly string[] {
      refreshOrder(allDocIds);
      return order.filter((docId) => later.has(docId));
    },
  };
}
