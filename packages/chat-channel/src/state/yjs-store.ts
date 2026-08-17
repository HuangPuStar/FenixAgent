// packages/chat-channel/src/state/yjs-store.ts
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
// - 变更通知去重使用 O(1) 变更票据 `${projectionVersion}:${docUpdateSeq}`，
//   不再全量序列化快照内容（stableKey，根因 B3）：票据变化 ⇔ doc 有 update
//   ⇒ 允许通知。牺牲"内容未变 update 的误报"换取每次 recompute O(1) 的
//   票据成本；computeSnapshot 为 doc 的纯函数，票据未变时直接跳过重算。

import * as Y from "yjs";

/** applyUpdate 显式事务 origin：区分 WS 应用与本地事务（本地事务保持同步重算） */
const APPLY_UPDATE_ORIGIN = Symbol("yjs-store:apply-update");
/** 重算耗时超过该预算（毫秒）时切换到慢路径降频，避免持续阻塞主线程 */
const RECOMPUTE_BUDGET_MS = 12;
/** 慢路径重算间隔（毫秒）：回放/流式高峰且重算成本高时使用 */
const SLOW_RECOMPUTE_INTERVAL_MS = 50;

// ── DEV 打点（SP-0 前端度量基线）──
// 仅统计 recompute 次数 / 单次耗时直方图 / 票据去重命中数，不含 doc 内容
// 或会话标识（防泄露）。生产构建时 Vite 将 process.env.NODE_ENV 静态替换为
// "production"，门控条件被折叠为 false 后经 DCE 移除，不进产物。
const DEV_METRICS_ENABLED = process.env.NODE_ENV === "development";
/** DEV 打点聚合上报间隔：低频输出，避免打点本身制造流式期间的控制台噪声 */
const DEV_METRICS_REPORT_INTERVAL_MS = 5_000;
/** 耗时直方图分桶上界（毫秒），与分桶标签一一对应 */
const DEV_METRICS_BUCKET_BOUNDS_MS = [1, 4, 12, 50];
const DEV_METRICS_BUCKET_LABELS = ["<1ms", "1-4ms", "4-12ms", "12-50ms", ">=50ms"];

const devMetrics = {
  recomputeCount: 0,
  ticketSkipCount: 0,
  bucketCounts: [0, 0, 0, 0, 0],
  lastReportAt: 0,
};

/** 记录一次 recompute 的耗时与票据去重结果，聚合窗口到期时 console.debug 上报 */
function recordDevMetrics(durationMs: number, ticketSkipped: boolean): void {
  devMetrics.recomputeCount++;
  if (ticketSkipped) devMetrics.ticketSkipCount++;
  let bucket = DEV_METRICS_BUCKET_BOUNDS_MS.length;
  for (let i = 0; i < DEV_METRICS_BUCKET_BOUNDS_MS.length; i++) {
    if (durationMs < DEV_METRICS_BUCKET_BOUNDS_MS[i]) {
      bucket = i;
      break;
    }
  }
  devMetrics.bucketCounts[bucket]++;
  const now = performance.now();
  if (now - devMetrics.lastReportAt < DEV_METRICS_REPORT_INTERVAL_MS) return;
  devMetrics.lastReportAt = now;
  console.debug("[yjs-store] recompute metrics", {
    recomputeCount: devMetrics.recomputeCount,
    ticketSkipCount: devMetrics.ticketSkipCount,
    histogramMs: DEV_METRICS_BUCKET_LABELS.map((label, i) => `${label}:${devMetrics.bucketCounts[i]}`).join(" "),
  });
  // 上报后清零，窗口间数据独立可比（基线对比用）
  devMetrics.recomputeCount = 0;
  devMetrics.ticketSkipCount = 0;
  devMetrics.bucketCounts = [0, 0, 0, 0, 0];
}

/**
 * switchDoc 的 doc 工厂返回契约。
 *
 * ownsDoc（默认 true）：store 是否持有该 doc 的生命周期。共享 doc 场景
 * （web 端 DocHub，根因 B1/SP-B1）多个 store 绑定同一 Y.Doc 实例，生命周期
 * 由外部引用计数统一管理，须传 false——store 切换/销毁时只注销监听并执行
 * cleanup（释放引用），不得调用 ydoc.destroy()（会摧毁其他绑定方的副本）。
 */
export interface SwitchDocBinding {
  ydoc: Y.Doc;
  cleanup?: () => void;
  ownsDoc?: boolean;
}

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
  switchDoc: (key: string, createDoc: () => SwitchDocBinding) => void;
  destroy: () => void;
}

/**
 * 对（可能被多个 store 共享监听的）Y.Doc 应用远端 update。
 *
 * DocHub 单写入口专用：使用与 store.applyUpdate 相同的显式 origin，使绑定该
 * doc 的所有 store 走"合并 + 宏任务重算"路径——对共享 doc 只需 apply 一次，
 * 全部监听 store 即可见（替换原先"每个 hook 各自 applyUpdate"的双写）。
 */
export function applyRemoteDocUpdate(ydoc: Y.Doc, update: Uint8Array): void {
  Y.applyUpdate(ydoc, update, APPLY_UPDATE_ORIGIN);
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
 *
 * 变更通知去重由 store 内部的 O(1) 变更票据承担（见文件头注释），
 * 调用方无需再提供快照序列化 key 函数（原 stableKey 路径已删除）。
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
export function createYjsStore<T>(computeSnapshot: (ydoc: Y.Doc) => T, initialSnapshot: T): YjsStore<T> {
  // 内部状态
  let ydoc: Y.Doc | null = null; // 当前活跃的 Y.Doc
  let snapshot: T = initialSnapshot; // 最新计算的快照
  let updateHandler: UpdateHandler | null = null; // 当前 update 事件处理器（用于 off 注销）
  const listeners = new Set<() => void>(); // React 注册的 listener 集合
  let activeKey = ""; // 当前活跃的 key（幂等保护：相同 key 重复 switchDoc 是 no-op）
  let cleanupFn: (() => void) | null = null; // createDoc 返回的可选清理函数
  // 当前绑定 doc 是否归 store 所有（共享 doc 为 false：destroy 责任在外部引用计数）
  let ownsCurrentDoc = true;

  // snapshot 去重：仅当变更票据变化时才重算快照并通知 React
  let prevSnapshotKey = "";
  // doc update 事件计数（O(1) 自增）：兜底本地事务不 bump projectionVersion
  // 的场景（如测试直写 doc），保证任何 update 都能推进票据
  let docUpdateSeq = 0;

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

  /**
   * 计算 O(1) 变更票据：`${projectionVersion}:${docUpdateSeq}`。
   *
   * - projectionVersion 读 doc root 的聚合层版本号（SP-A2 后只按实际触碰的
   *   doc 递增，语义精确）；非数值/缺失（如测试自建 doc）按 0 处理；
   * - docUpdateSeq 由 store 在 update 事件里自增，覆盖本地事务不 bump
   *   projectionVersion 的场景——两段组合保证"doc 有 update ⇒ 票据必变"。
   */
  function computeTicket(): string {
    if (!ydoc) return "";
    const version = ydoc.getMap("root").get("projectionVersion");
    return `${typeof version === "number" ? version : 0}:${docUpdateSeq}`;
  }

  /** 在 update 事件回调中重算快照并通知 React */
  function recompute() {
    if (!ydoc) return;
    // 票据未变 ⇔ 自上次接受的重算后 doc 无任何 update ⇒ computeSnapshot
    // （doc 的纯函数）输出必然不变，直接跳过全量重算
    const nextKey = computeTicket();
    if (nextKey === prevSnapshotKey) {
      if (DEV_METRICS_ENABLED) recordDevMetrics(0, true);
      return;
    }
    const start = DEV_METRICS_ENABLED ? performance.now() : 0;
    prevSnapshotKey = nextKey;
    snapshot = computeSnapshot(ydoc);
    notify();
    if (DEV_METRICS_ENABLED) recordDevMetrics(performance.now() - start, false);
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
  function switchDoc(key: string, createDoc: () => SwitchDocBinding) {
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
    if (ydoc && ownsCurrentDoc) {
      ydoc.destroy();
    }
    ydoc = null;

    // 2. 创建新 Y.Doc（共享 doc 由外部持有生命周期，store 只登记所有权标记）
    const { ydoc: newDoc, cleanup, ownsDoc } = createDoc();
    ydoc = newDoc;
    cleanupFn = cleanup ?? null;
    ownsCurrentDoc = ownsDoc !== false;

    // 3. 注册 update 事件监听（每次 switchDoc 创建新的回调，避免闭包捕获过期引用）
    //    WS 应用（origin = APPLY_UPDATE_ORIGIN）走合并 + 宏任务重算，避免回放高峰
    //    逐条同步全量计算阻塞主线程；本地事务（测试/内部写入）保持同步语义。
    //    docUpdateSeq 在此 O(1) 自增（票据兜底段），任何 update 都推进票据。
    const handler: UpdateHandler = (_update, origin) => {
      docUpdateSeq++;
      if (origin === APPLY_UPDATE_ORIGIN) scheduleRecompute();
      else recompute();
    };
    ydoc.on("update", handler);
    updateHandler = handler;

    // 4. 立即计算初始快照（渲染期同步，保证首次渲染即正确）
    cancelScheduledRecompute();
    // 新 doc 通常内容少、重算便宜，重置降频状态避免继承旧 doc 的慢路径；
    // 票据段（seq 与 prevSnapshotKey）同步重置，新 doc 首次重算必然通知
    slowRecompute = false;
    docUpdateSeq = 0;
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
    if (ydoc && ownsCurrentDoc) {
      ydoc.destroy();
    }
    ydoc = null;
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
