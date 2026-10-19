// packages/agent-runtime/web/yjs/sync-content-window.ts
// content Doc 订阅窗口：目录持有全部已封口历史块，首屏只订阅最近 N 块，更早块由用户显式加载。
//
// 为什么按目录顺序而不是 blockIndex：目录是 ordinalStart 排序的权威顺序；历史导入块与 live
// 轮换块的 blockIndex 来源不同，不能单独作为全局时间序。窗口只裁决「哪些块先订阅」，不改变
// 目录与投影的排序规则。

/** 首屏订阅的最近内容块数。单块目标载荷 128KiB，四块把首屏下行控制在约 512KiB 量级。 */
export const SYNC_HISTORY_INITIAL_BLOCKS = 4;
/** 每次“显示更早”加载的内容块数。 */
export const SYNC_HISTORY_LOAD_BLOCKS = 4;

export interface ContentWindowPlan {
  /** 本轮应新订阅的块（按目录顺序）。 */
  readonly retain: readonly string[];
  /** 目录中是否还有未订阅的更早块。 */
  readonly hasEarlier: boolean;
}

export interface SyncContentWindowOptions {
  readonly initialBlocks?: number;
}

export interface SyncContentWindow {
  /** 换代/重连：清空窗口裁决状态。 */
  reset(): void;
  /**
   * 根据最新目录与已 retain 集合计算本轮订阅：
   * - 首次（尚无内容块被 retain）保留目录末尾 `initialBlocks` 块，其余进入更早集合；
   * - 后续目录追加按位置分流：位于最旧已 retain 块之前的进入更早集合，之后的立即订阅
   *   （覆盖 live 轮换与迟到的历史导入，避免迟到历史被当成“最新块”全量订阅）。
   */
  plan(allDocIds: readonly string[], retained: ReadonlySet<string>, initial: boolean): ContentWindowPlan;
  /** 查看下一批更早块，不改变状态；返回顺序仍是目录顺序。 */
  peekEarlier(allDocIds: readonly string[], batchSize?: number): readonly string[];
  /** 确认这批更早块已进入订阅；从更早集合移除。 */
  consumeEarlier(docIds: readonly string[]): void;
  /** 订阅失败/超时：把这批块放回更早集合，允许用户重试。 */
  restoreEarlier(docIds: readonly string[]): void;
  hasEarlier(): boolean;
  /** 当前更早集合，按目录顺序过滤；空目录参数会丢弃已不存在的块。 */
  earlierDocIds(allDocIds: readonly string[]): readonly string[];
}

/**
 * 窗口状态只保存在客户端内存里，不进入协议：服务端仍按订阅逐块发 DOC_BASE，
 * 客户端不订阅的块不会产生下行字节。
 */
export function createSyncContentWindow(options: SyncContentWindowOptions = {}): SyncContentWindow {
  const initialBlocks = Math.max(1, Math.floor(options.initialBlocks ?? SYNC_HISTORY_INITIAL_BLOCKS));
  let order: string[] = [];
  let earlier = new Set<string>();
  let chosen = false;

  function refreshOrder(allDocIds: readonly string[]): void {
    order = [...new Set(allDocIds)];
    for (const docId of [...earlier]) {
      if (!order.includes(docId)) earlier.delete(docId);
    }
  }

  return {
    reset(): void {
      order = [];
      earlier = new Set();
      chosen = false;
    },

    plan(allDocIds, retained, _initial): ContentWindowPlan {
      refreshOrder(allDocIds);
      const retainedContent = order.filter((docId) => retained.has(docId));
      const fresh = order.filter((docId) => !retained.has(docId) && !earlier.has(docId));

      if (!chosen || retainedContent.length === 0) {
        chosen = true;
        const keep = fresh.slice(-initialBlocks);
        earlier = new Set(fresh.slice(0, Math.max(0, fresh.length - keep.length)));
        return { retain: keep, hasEarlier: earlier.size > 0 };
      }

      const oldestRetained = Math.min(...retainedContent.map((docId) => order.indexOf(docId)));
      const older: string[] = [];
      const newer: string[] = [];
      for (const docId of fresh) {
        if (order.indexOf(docId) < oldestRetained) older.push(docId);
        else newer.push(docId);
      }
      for (const docId of older) earlier.add(docId);
      return { retain: newer, hasEarlier: earlier.size > 0 };
    },

    peekEarlier(allDocIds, batchSize = SYNC_HISTORY_LOAD_BLOCKS): readonly string[] {
      refreshOrder(allDocIds);
      const candidates = order.filter((docId) => earlier.has(docId));
      return candidates.slice(-Math.max(1, Math.floor(batchSize)));
    },

    consumeEarlier(docIds): void {
      for (const docId of docIds) earlier.delete(docId);
    },

    restoreEarlier(docIds): void {
      for (const docId of docIds) {
        if (order.includes(docId)) earlier.add(docId);
      }
    },

    hasEarlier(): boolean {
      return earlier.size > 0;
    },

    earlierDocIds(allDocIds): readonly string[] {
      refreshOrder(allDocIds);
      return order.filter((docId) => earlier.has(docId));
    },
  };
}
