// web/src/hooks/yjs-store.ts
// Yjs 外部 store 抽象 — 将 Y.Doc 包装为 subscribe/getSnapshot 模式，供 useSyncExternalStore 使用

import * as Y from "yjs";

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
type UpdateHandler = (update: Uint8Array, origin: unknown, doc: Y.Doc) => void;

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
      if (docSid && docSid !== sessionId) return;
    }

    // Y.applyUpdate 在内部 transaction 中完成，结束后 update 事件同步触发
    Y.applyUpdate(ydoc, update);
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
    //    Y.applyUpdate 在 transaction 完成后同步触发 update 事件，
    //    即 recompute → notify → React 通过 useSyncExternalStore 调度重渲染
    const handler: UpdateHandler = () => recompute();
    ydoc.on("update", handler);
    updateHandler = handler;

    // 4. 立即计算初始快照
    snapshot = computeSnapshot(ydoc);
    prevSnapshotKey = "";
    notify();
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
