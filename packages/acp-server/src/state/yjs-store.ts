// web/src/hooks/yjs-store.ts
// Yjs 外部 store 抽象 — 将 Y.Doc 包装为 subscribe/getSnapshot 模式，供 useSyncExternalStore 使用
//
// 性能语义（回放/流式高峰保护）：
// - applyUpdate（WS 路径）不再同步重算快照，改为宏任务调度：
//   重算移出 WS 消息接收栈，避免 load_session 历史回放时逐条全量重算
//   阻塞主线程（O(n²)）。快路径（setTimeout 0）仅合并同一同步栈内的
//   多次 applyUpdate（WS 每条消息是独立宏任务，跨消息不合并）；
//   真正降频的是慢路径：单次重算耗时超过一帧预算（12ms）后切换为
//   50ms 窗口合并重算，回放/流式高峰期间每秒至多约 20 次全量计算。
// - 本地事务（origin !== APPLY_UPDATE_ORIGIN，如测试直接 ydoc.transact）
//   保持同步重算语义，快照立即可见。

import * as Y from "yjs";

/** applyUpdate 显式事务 origin：区分 WS 应用与本地事务（本地事务保持同步重算） */
const APPLY_UPDATE_ORIGIN = Symbol("yjs-store:apply-update");
/** 重算耗时超过该预算（毫秒）时切换到慢路径降频，避免持续阻塞主线程 */
const RECOMPUTE_BUDGET_MS = 12;
/** 慢路径重算间隔（毫秒）：回放/流式高峰且重算成本高时使用 */
const SLOW_RECOMPUTE_INTERVAL_MS = 50;

/**
 * YjsStore 接口 — 外部 store 的契约
 *
 * 设计要点：
 * - subscribe: 注册 listener，Y.Doc 变化时（update 事件）统一通知
 * - getSnapshot: 同步返回最新快照（存储在闭包变量中），供 React 渲染期间调用
 * - applyUpdate: 应用 WebSocket 传来的 update bytes，触发 update 事件 → snapshot 重算 → 通知 React
 * - switchDoc: 同步切换 Y.Doc（销毁旧的、创建新的、计算初始快照、通知 listeners）
 * - destroy: 清理所有资源
 */
export interface YjsStore<T> {
  subscribe: (callback: () => void) => () => void;
  getSnapshot: () => T;
  applyUpdate: (update: Uint8Array, sessionId?: string) => void;
  switchDoc: (key: string, createDoc: () => { ydoc: Y.Doc; cleanup?: () => void }) => void;
  destroy: () => void;
}

/**
 * 监听 Y.Doc 的 update 事件的回调类型
 */
export type UpdateHandler = (update: Uint8Array, origin: unknown, doc: Y.Doc) => void;

/**
 * 创建 Yjs 外部 store
 *
 * @param computeSnapshot - 纯函数，从给定 Y.Doc 计算业务快照
 * @param initialSnapshot - 在首次 switchDoc 之前 getSnapshot 返回的占位快照
 * @param getSnapshotKey - 调用方提供的领域去重函数，从快照提取稳定 key。
 *                         仅当 key 变化时才通知 React 重渲染。
 *                         类型为 (snapshot: T) => string，调用方负责覆盖全部 UI 字段。
 *
 * 使用模式（在 hook 渲染期间）：
 *
 *   const store = useRef(createYjsStore(...)).current;
 *   if (prevKey.current !== key) {
 *     prevKey.current = key;
 *     store.switchDoc(key, () => ({ ydoc: new Y.Doc() }));
 *   }
 *   const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
 */
export function createYjsStore<T>(
  computeSnapshot: (ydoc: Y.Doc) => T,
  initialSnapshot: T,
  getSnapshotKey: (snapshot: T) => string,
): YjsStore<T> {
  // 内部状态
  let ydoc: Y.Doc | null = null; // 当前活跃的 Y.Doc
  let snapshot: T = initialSnapshot; // 最新计算的快照
  let updateHandler: UpdateHandler | null = null; // 当前 update 事件处理器（用于 off 注销）
  const listeners = new Set<() => void>(); // React 注册的 listener 集合
  let activeKey = ""; // 当前活跃的 key（幂等保护：相同 key 重复 switchDoc 是 no-op）
  let cleanupFn: (() => void) | null = null; // createDoc 返回的可选清理函数

  // snapshot 去重：仅当计算出的 snapshot key 变化时才通知 React
  let prevSnapshotKey = "";

  // 合并重算调度状态（仅 applyUpdate 路径使用）：
  // - recomputeScheduled：已调度未执行（同一 tick 多次 update 只调度一次）
  // - slowRecompute：上次重算耗时超预算 → 下次调度用慢路径间隔
  let recomputeScheduled = false;
  let slowRecompute = false;
  let scheduleToken: ReturnType<typeof setTimeout> | null = null;

  function notify() {
    // 遍历 listeners 通知 React（React 会批量处理重渲染）
    for (const listener of listeners) {
      listener();
    }
  }

  /** 在 update 事件回调中重算快照并通知 React */
  function recompute() {
    if (!ydoc) return;
    const next = computeSnapshot(ydoc);
    const nextKey = getSnapshotKey(next);
    if (nextKey === prevSnapshotKey) return; // 未变，跳过通知
    prevSnapshotKey = nextKey;
    snapshot = next;
    notify();
  }

  /** 取消已调度的合并重算（switchDoc/destroy 时调用，避免悬空回调） */
  function cancelScheduledRecompute() {
    if (scheduleToken !== null) {
      clearTimeout(scheduleToken);
      scheduleToken = null;
    }
    recomputeScheduled = false;
  }

  /**
   * 调度合并重算：同一 tick 的多次 applyUpdate 合并为一次重算。
   * 快路径（setTimeout 0，宏任务）保证同批 update 合并且不阻塞 WS 接收栈；
   * 重算成本超预算时切换慢路径（50ms）降频，回放/流式高峰不持续卡主线程。
   */
  function scheduleRecompute() {
    if (recomputeScheduled || !ydoc) return;
    recomputeScheduled = true;
    scheduleToken = setTimeout(runScheduledRecompute, slowRecompute ? SLOW_RECOMPUTE_INTERVAL_MS : 0);
  }

  function runScheduledRecompute() {
    scheduleToken = null;
    recomputeScheduled = false;
    if (!ydoc) return;
    const start = performance.now();
    recompute();
    // 重算成本自适应：超预算 → 慢路径（下次间隔 50ms），未超 → 恢复快路径
    slowRecompute = performance.now() - start > RECOMPUTE_BUDGET_MS;
  }

  function subscribe(callback: () => void) {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }

  function getSnapshot(): T {
    return snapshot;
  }

  function applyUpdate(update: Uint8Array, sessionId?: string) {
    if (!ydoc) return;

    // sessionId guard: 仅当 update 所属 sessionId 匹配当前 Y.Doc 记录的 sessionId 时才应用
    if (sessionId) {
      const docSid = ydoc.getMap("meta").get("acpSessionId") as string | undefined;
      if (docSid && docSid !== sessionId) {
        return;
      }
    }

    // 显式 origin：update 事件据此走合并重算路径（而非同步重算）
    Y.applyUpdate(ydoc, update, APPLY_UPDATE_ORIGIN);
  }

  /**
   * 同步切换 Y.Doc
   *
   * 在渲染期间调用（非 useEffect），React Strict Mode 下可能被双调用，
   * 因此使用 activeKey 做幂等保护：相同 key 重复调用是 no-op。
   */
  function switchDoc(key: string, createDoc: () => { ydoc: Y.Doc; cleanup?: () => void }) {
    // 幂等保护：相同 key 跳过（Strict Mode 安全）
    if (activeKey === key) return;
    activeKey = key;

    // 1. 销毁旧 Y.Doc（先注销 listener 再 destroy）
    if (ydoc && updateHandler) {
      ydoc.off("update", updateHandler);
      updateHandler = null;
    }
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
    if (ydoc) {
      ydoc.destroy();
      ydoc = null;
    }

    // 2. 创建新 Y.Doc
    const { ydoc: newDoc, cleanup } = createDoc();
    ydoc = newDoc;
    cleanupFn = cleanup ?? null;

    // 3. 注册 update 事件监听（每次 switchDoc 创建新的回调，避免闭包捕获过期引用）
    //    WS 应用（origin = APPLY_UPDATE_ORIGIN）走合并 + 宏任务重算，避免回放高峰
    //    逐条同步全量计算阻塞主线程；本地事务（测试/内部写入）保持同步语义。
    const handler: UpdateHandler = (_update, origin) => {
      if (origin === APPLY_UPDATE_ORIGIN) scheduleRecompute();
      else recompute();
    };
    ydoc.on("update", handler);
    updateHandler = handler;

    // 4. 立即计算初始快照（渲染期同步，保证首次渲染即正确）
    cancelScheduledRecompute();
    // 新 doc 通常内容少、重算便宜，重置降频状态避免继承旧 doc 的慢路径
    slowRecompute = false;
    snapshot = computeSnapshot(ydoc);
    prevSnapshotKey = "";
    notify();
    // 注：若 switchDoc 前已有 setTimeout 回调入队（宏任务已触发），clearTimeout
    // 无法取消，迟到回调会对新 doc 重算一次并多通知一次——内容正确（与新 doc
    // 初始快照一致），仅多一次重渲染，属无害行为，非 bug。
  }

  function destroy() {
    if (ydoc && updateHandler) {
      ydoc.off("update", updateHandler);
      updateHandler = null;
    }
    if (cleanupFn) {
      cleanupFn();
      cleanupFn = null;
    }
    if (ydoc) {
      ydoc.destroy();
      ydoc = null;
    }
    cancelScheduledRecompute();
    listeners.clear();
    activeKey = "";
  }

  return {
    subscribe,
    getSnapshot,
    applyUpdate,
    switchDoc,
    destroy,
  };
}
