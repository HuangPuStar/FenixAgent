// web/src/hooks/use-task-views.ts
// 从 Session Doc 单独订阅 Peri Task 投影（root.tasks / root.taskOrder，切片 2）。
//
// 职责与约束：
// - 只绑定 Session Doc（经 DocHub 共享实例），Chat Doc 的任何更新（token 流、
//   消息时间线、工具调用）不会触发本 selector 重算——Task 视图与消息流解耦，
//   流式高峰不会因任务列表重派生而放大渲染成本；
// - 派生排序（规格 §三.3）：非终态在前 → 组内 updatedAt 降序 → taskOrder 稳定
//   （任务创建顺序）。taskOrder 只在首次创建时 append、更新不重排，最终以它为
//   tie-break 保持稳定展示顺序；
// - 引用稳定性：子树未变时复用上次排序结果（=== 稳定），配合 React.memo 让
//   PeriTaskViewCard 只在其自身数据变化时重渲染；
// - 投影本身已在后端收敛为有界展示字段（安全约束见 schema.ts PeriTask 段），
//   前端只读展示形状，不携带 detail/descriptor/raw payload，不发任何请求。
//
// 状态：tasks/taskOrder 子树存在 ⇒ loaded=true（Session Doc 快照已同步）；
// 子树缺失（快照未到达）⇒ loaded=false，调用方展示加载态。

import type {
  PeriTaskDetailAvailability,
  PeriTaskKind,
  PeriTaskStatus,
  PeriTaskSubtype,
  PeriTaskViewProjection,
} from "@fenix/chat-channel";
import { createYjsStore, type YjsStore } from "@fenix/chat-channel";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { createSessionDocBinding, getDocHubReplacementVersion, subscribeDocHubReplacement } from "../yjs/doc-hub";

/** 终态集合：非终态（running）展示在前 */
const PERI_TASK_TERMINAL_STATUSES: ReadonlySet<PeriTaskStatus> = new Set(["completed", "failed", "cancelled"]);

/** kind/subtype/detailAvailability 的 allowlist：Doc 数据可能被篡改或来自旧快照，未知值给安全默认 */
const PERI_TASK_KIND_ALLOWLIST: ReadonlySet<string> = new Set(["subagent", "background"]);
const PERI_TASK_SUBTYPE_ALLOWLIST: ReadonlySet<string> = new Set(["agent", "shell", "workflow"]);
const PERI_TASK_DETAIL_ALLOWLIST: ReadonlySet<string> = new Set(["preview", "unavailable", "expired"]);

/** 共享空数组常量：空任务列表时返回稳定引用（不产生新的 [] 实例） */
const EMPTY_TASKS: readonly PeriTaskViewProjection[] = [];

interface PeriTaskViewsSnapshot {
  /** 已排序的任务视图（非终态在前 → updatedAt 降序 → taskOrder 稳定）；引用稳定 */
  tasks: readonly PeriTaskViewProjection[];
  /** Session Doc 的 tasks/taskOrder 子树是否已同步（未同步时调用方展示加载态） */
  loaded: boolean;
}

/** 派生缓存（挂在 Y.Doc 上的 WeakMap，纯投影、可从后端 doc 全量重建） */
interface PeriTaskDerivationCache {
  tasks: readonly PeriTaskViewProjection[] | null;
  dirty: boolean;
}

const periTaskCaches = new WeakMap<Y.Doc, PeriTaskDerivationCache>();

/** allowlist 收窄：未知 status 保守映射为 running（非终态，避免误判为已完成） */
function safeStatus(raw: unknown): PeriTaskStatus {
  if (typeof raw === "string" && (PERI_TASK_TERMINAL_STATUSES.has(raw as PeriTaskStatus) || raw === "running")) {
    return raw as PeriTaskStatus;
  }
  return "running";
}

/** allowlist 收窄：未知 kind 保守映射为 subagent（仅影响徽标展示） */
function safeKind(raw: unknown): PeriTaskKind {
  return typeof raw === "string" && PERI_TASK_KIND_ALLOWLIST.has(raw) ? (raw as PeriTaskKind) : "subagent";
}

/** allowlist 收窄：未知 subtype 映射为 null（展示通用徽标，不显示错误文本） */
function safeSubtype(raw: unknown): PeriTaskSubtype {
  return typeof raw === "string" && PERI_TASK_SUBTYPE_ALLOWLIST.has(raw) ? (raw as PeriTaskSubtype) : null;
}

/** allowlist 收窄：未知 detailAvailability 保守映射为 unavailable（不可点详情） */
function safeDetailAvailability(raw: unknown): PeriTaskDetailAvailability {
  return typeof raw === "string" && PERI_TASK_DETAIL_ALLOWLIST.has(raw)
    ? (raw as PeriTaskDetailAvailability)
    : "unavailable";
}

/** 只读字符串字段（null 原样保留） */
function safeStringOrNull(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

/** 有界展示字段读取：缺失/非法值一律安全默认，不向 UI 泄漏原始载荷 */
function readPeriTaskView(taskId: string, task: Y.Map<unknown>): PeriTaskViewProjection {
  const kind = safeKind(task.get("kind"));
  const rawTitle = task.get("title");
  const rawStartedAt = task.get("startedAt");
  const rawUpdatedAt = task.get("updatedAt");
  return {
    taskId,
    kind,
    taskSubtype: safeSubtype(task.get("taskSubtype")),
    title: typeof rawTitle === "string" ? rawTitle : "",
    summary: safeStringOrNull(task.get("summary")),
    status: safeStatus(task.get("status")),
    turnId: safeStringOrNull(task.get("turnId")),
    isBackground: kind === "background",
    startedAt: typeof rawStartedAt === "string" ? rawStartedAt : "",
    completedAt: safeStringOrNull(task.get("completedAt")),
    updatedAt: typeof rawUpdatedAt === "string" ? rawUpdatedAt : "",
    detailAvailability: safeDetailAvailability(task.get("detailAvailability")),
  };
}

/** 时间解析防御：非法时间戳降级为 0（排在该组的末尾） */
function parseTime(value: string): number {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * 派生排序：非终态在前 → 组内 updatedAt 降序 → taskOrder 稳定（保留原相对顺序）。
 * 遍历以 taskOrder（创建顺序）为基线，防御 tasks 中有而 order 缺失的旧快照。
 * 排序是稳定的（ES2019+），比较器返回 0 时保持 taskOrder 相对顺序。
 */
function deriveSortedTasks(tasks: Y.Map<Y.Map<unknown>>, order: Y.Array<string>): PeriTaskViewProjection[] {
  const views: PeriTaskViewProjection[] = [];
  const seen = new Set<string>();
  for (const taskId of order.toArray()) {
    const task = tasks.get(taskId);
    if (!task) continue;
    views.push(readPeriTaskView(taskId, task));
    seen.add(taskId);
  }
  // 旧快照（v4 前迁移异常）可能出现 tasks 有而 order 缺失的条目：补齐尾部，
  // 保证投影不丢失；order 是创建顺序的权威记录，缺失只发生在异常数据上
  for (const [taskId, task] of tasks.entries()) {
    if (seen.has(taskId)) continue;
    views.push(readPeriTaskView(taskId, task));
  }
  views.sort((a, b) => {
    const aTerminal = PERI_TASK_TERMINAL_STATUSES.has(a.status);
    const bTerminal = PERI_TASK_TERMINAL_STATUSES.has(b.status);
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
    const at = parseTime(a.updatedAt);
    const bt = parseTime(b.updatedAt);
    if (at !== bt) return bt - at;
    return 0; // 稳定排序：保持 taskOrder 相对顺序
  });
  return views;
}

/** 单个 observeDeep 事件 → dirty 标记（path 相对 Session Doc root） */
function markPeriTaskEvent(cache: PeriTaskDerivationCache, event: Y.YEvent<Y.AbstractType<unknown>>): void {
  const path = event.path;
  if (path.length === 0) {
    if (event.keys.has("tasks") || event.keys.has("taskOrder")) cache.dirty = true;
    return;
  }
  if (path[0] === "tasks" || path[0] === "taskOrder") cache.dirty = true;
}

function getPeriTaskCache(ydoc: Y.Doc): PeriTaskDerivationCache {
  const existing = periTaskCaches.get(ydoc);
  if (existing) return existing;
  const cache: PeriTaskDerivationCache = { tasks: null, dirty: true };
  // 首次派生必然全量：把观察者挂载前已存在的内容全部纳入基线
  ydoc.getMap("root").observeDeep((events) => {
    for (const event of events) markPeriTaskEvent(cache, event);
  });
  periTaskCaches.set(ydoc, cache);
  return cache;
}

/**
 * 从 Session Doc 派生 Peri Task 视图（纯函数，无副作用）。导出仅供测试。
 * 只订阅 tasks / taskOrder 子树：其余 Session Doc 子树（session/agent/
 * pendingPermissions/pendingQuestions/sessions）的变化不触发重派生。
 */
export function computePeriTaskViews(ydoc: Y.Doc): PeriTaskViewsSnapshot {
  const root = ydoc.getMap("root");
  // Session Doc 尚未同步（快照未到达）时子树缺失：返回未加载态；
  // 不得用 new Y.Map() 占位后读取（Yjs 抛 "Invalid access: Add Yjs type to a document..."）
  const tasks = root.get("tasks") as Y.Map<Y.Map<unknown>> | undefined;
  const order = root.get("taskOrder") as Y.Array<string> | undefined;
  if (!tasks || !order) return { tasks: EMPTY_TASKS, loaded: false };

  const cache = getPeriTaskCache(ydoc);
  if (!cache.dirty && cache.tasks !== null) return { tasks: cache.tasks, loaded: true };
  cache.tasks = deriveSortedTasks(tasks, order);
  cache.dirty = false;
  return { tasks: cache.tasks, loaded: true };
}

/**
 * 订阅指定 RCS 会话的 Peri Task 视图（只绑定 Session Doc）。
 * 内部 store 绑定 DocHub 的共享 doc 实例（ownsDoc=false），WS update 由
 * ChatPanel 经 applyDocHubUpdate 单写，本 hook 只读派生。
 */
export function useTaskViews(rcsSessionId: string) {
  const storeRef = useRef<YjsStore<PeriTaskViewsSnapshot> | null>(null);
  if (!storeRef.current) {
    storeRef.current = createYjsStore<PeriTaskViewsSnapshot>(computePeriTaskViews, {
      tasks: EMPTY_TASKS,
      loaded: false,
    });
  }
  const store = storeRef.current;

  // 绑定工厂：从 DocHub 取共享 Session Doc（ownsDoc=false，生命周期归 hub 引用计数）；
  // useCallback 保持引用稳定，渲染期与 effect 期复用同一工厂
  const bindSessionDoc = useCallback(() => createSessionDocBinding(rcsSessionId), [rcsSessionId]);
  const subscribeReplacement = useCallback(
    (listener: () => void) => subscribeDocHubReplacement(rcsSessionId, listener),
    [rcsSessionId],
  );
  const getReplacementVersion = useCallback(() => getDocHubReplacementVersion(rcsSessionId), [rcsSessionId]);
  const replacementVersion = useSyncExternalStore(subscribeReplacement, getReplacementVersion, getReplacementVersion);

  // 重订阅驱动（bind epoch）：destroy 会清空 store listeners（store 契约），
  // 而 useSyncExternalStore 只在 subscribe 引用变化时重订阅——cleanup destroy
  // 后必须重建订阅，否则切换会话 / StrictMode 双挂载后后续 update 不再触发
  // 渲染（快照永久 stale，SP-B1 回归测试捕获的真实缺陷）。
  const [bindEpoch, setBindEpoch] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: bindEpoch 不在回调体内使用，作为 subscribe 引用变化的驱动依赖（见上注释）
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [bindEpoch]);

  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot);

  useEffect(() => {
    // doc 绑定只在 effect 期执行（不在渲染期 switchDoc）：渲染期 switchDoc 的
    // notify() 会在渲染进行中触发已订阅组件的 setState（React 报错），且本组件
    // 的 listeners 已被 cleanup destroy 清空，必须经 bindEpoch 重订阅兜底。
    // StrictMode 双挂载 / 切换会话：cleanup destroy 已重置 activeKey（""），
    // 此处 switchDoc 重建 hub 绑定；destroy 经 binding.cleanup 释放 hub 引用，
    // 计数归零才销毁共享 doc。绑定完成后推进 epoch 驱动重订阅。
    const bindingKey = `${rcsSessionId}:${replacementVersion}`;
    store.switchDoc(bindingKey, bindSessionDoc);
    setBindEpoch((e) => e + 1);
    return () => {
      store.destroy();
    };
  }, [store, rcsSessionId, bindSessionDoc, replacementVersion]);

  return { state: snapshot };
}
