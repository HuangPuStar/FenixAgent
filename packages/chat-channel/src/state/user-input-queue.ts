// packages/chat-channel/src/state/user-input-queue.ts
// Peri 待发送队列（steer）投影：把三个规范化事件收敛到 Session Doc 的
// root.userInputQueue 子树，并向前端提供浏览器安全读取辅助。
//
// 收敛规则（乱序 / 重放 / 换代的唯一防线）：
// - queue_changed 以 snapshot 整体替换 items；generation 变化即整体清空重建
//   ——peri 队列不跨进程持久，旧代号的待发送项绝不能留成幽灵项；
// - 同 generation 下 revision <= 当前值一律丢弃（乱序或重放快照不得回退 UI）；
// - run_started 只记录 activeRequestId，不推进 generation：generation 只由快照
//   推进，否则"快照晚于 run_started 到达"的顺序差异会被误判成换代而清空队列；
// - delivered 负责从队列摘除该项；用户消息写入 Chat Doc 由聚合层完成
//   （aggregator.ts 的 applyUserInputDeliveredMessage，entryId = input_id）。
//
// 依赖方向：本模块只依赖 schema / chat-writer 与 yjs，属浏览器安全面（根入口导出），
// 因此不得反向导入 aggregator 等服务端模块（守护测试 chat-channel-browser-surface.test.ts）。

import * as Y from "yjs";
import {
  type NormalizedEvent,
  type NormalizedUserInputQueueEvent,
  PERI_USER_INPUT_QUEUE_CAPABILITY,
  USER_INPUT_QUEUE_EVENT_TYPES,
  USER_INPUT_QUEUE_MAX_ITEMS,
  USER_INPUT_STATES,
  type UserInputQueueItemProjection,
  type UserInputQueueProjection,
  type UserInputQueueSnapshot,
} from "../schema";
import {
  getSessionRoot,
  initSessionDocStructure,
  removeUserInputQueueItem,
  replaceUserInputQueueItems,
  setUserInputQueueState,
} from "./chat-writer";

/**
 * 投影结果。与 aggregator.ApplyResult 结构一致但不复用其类型：
 * 本模块是浏览器安全面，导入服务端聚合层会被边界守护测试判为越界。
 */
export interface UserInputQueueApplyResult {
  applied: boolean;
  reason?: string;
}

/** 未初始化 / 未协商会话的读取结果（enabled=false 让前端回退旧路径） */
function emptyProjection(): UserInputQueueProjection {
  return { enabled: false, generation: null, revision: 0, activeRequestId: null, items: [] };
}

/** 读取显式协商结果；未写入时回退 agent.capabilities（结构补建/回放路径可能没有该键） */
function readEnabled(ydoc: Y.Doc, queue: Y.Map<unknown>): boolean {
  const explicit = queue.get("enabled");
  if (typeof explicit === "boolean") return explicit;
  const agent = getSessionRoot(ydoc).get("agent");
  const capabilities = agent instanceof Y.Map ? agent.get("capabilities") : undefined;
  return capabilities instanceof Y.Map && capabilities.get(PERI_USER_INPUT_QUEUE_CAPABILITY) === true;
}

/** 队列项状态读取：Y.Doc 内的值只可能来自 normalizer，越界仍收敛为 unknown（防御纵深） */
function readState(raw: unknown): UserInputQueueItemProjection["state"] {
  return typeof raw === "string" && (USER_INPUT_STATES as ReadonlySet<string>).has(raw)
    ? (raw as UserInputQueueItemProjection["state"])
    : "unknown";
}

/** 读取队列项数组（物理结构不可用时返回空数组，不抛错） */
function readItems(queue: Y.Map<unknown>): UserInputQueueItemProjection[] {
  const array = queue.get("items");
  if (!(array instanceof Y.Array)) return [];
  const items: UserInputQueueItemProjection[] = [];
  for (const entry of array.toArray()) {
    if (!(entry instanceof Y.Map)) continue;
    const inputId = entry.get("inputId");
    if (typeof inputId !== "string" || inputId.length === 0) continue;
    items.push({
      inputId,
      content: String(entry.get("content") ?? ""),
      originalDraft: String(entry.get("originalDraft") ?? ""),
      state: readState(entry.get("state")),
    });
  }
  return items;
}

/**
 * 读取待发送队列投影（浏览器安全：只读 Y.Doc，前端 store 每次快照计算时调用）。
 * 结构缺失（旧快照 / 未装配）按「能力未协商」返回，不抛错。
 */
export function readUserInputQueue(ydoc: Y.Doc): UserInputQueueProjection {
  const root = getSessionRoot(ydoc);
  const queue = root.get("userInputQueue");
  if (!(queue instanceof Y.Map)) return emptyProjection();
  const generation = queue.get("generation");
  const revision = queue.get("revision");
  const activeRequestId = queue.get("activeRequestId");
  return {
    enabled: readEnabled(ydoc, queue),
    generation: typeof generation === "string" ? generation : null,
    revision: typeof revision === "number" && Number.isFinite(revision) ? revision : 0,
    activeRequestId: typeof activeRequestId === "string" ? activeRequestId : null,
    items: readItems(queue),
  };
}

/**
 * 写入能力协商结果（控制面在 initialize 协商回显后调用）。
 * 不调用也能工作：读取侧会回退 agent.capabilities 判定；
 * 显式写入用于"协商失败必须为 false"这类需要压制兜底的场景。
 */
export function setUserInputQueueEnabled(ydoc: Y.Doc, enabled: boolean): void {
  ensureQueueStructure(ydoc);
  setUserInputQueueState(ydoc, { enabled });
}

/**
 * 换代清空（会话切换 / Agent 重启后由控制面调用）：清空 items 与 activeRequestId，
 * generation 置 null 使下一个快照无条件重建。enabled 保留——能力协商与会话进程无关。
 */
export function resetUserInputQueue(ydoc: Y.Doc): void {
  ensureQueueStructure(ydoc);
  ydoc.transact(() => {
    replaceUserInputQueueItems(ydoc, []);
    setUserInputQueueState(ydoc, { generation: null, revision: 0, activeRequestId: null });
  });
}

/** 结构缺失时幂等补建（旧快照 / 裸 Y.Doc 防御），避免投影写入落在 undefined 上 */
function ensureQueueStructure(ydoc: Y.Doc): void {
  if (getSessionRoot(ydoc).get("userInputQueue") instanceof Y.Map) return;
  initSessionDocStructure(ydoc);
}

/** 队列项上限截断（快照来自外部输入；Session Doc 首帧整体同步必须硬性有界） */
function boundedItems(items: UserInputQueueItemProjection[]): UserInputQueueItemProjection[] {
  return items.length > USER_INPUT_QUEUE_MAX_ITEMS ? items.slice(0, USER_INPUT_QUEUE_MAX_ITEMS) : items;
}

/**
 * 应用队列全量快照：generation 变化（含首次快照）→ 清空重建；
 * 同 generation → revision 严格递增才应用，回退/重放快照丢弃。
 */
function applySnapshot(ydoc: Y.Doc, snapshot: UserInputQueueSnapshot): UserInputQueueApplyResult {
  const current = readUserInputQueue(ydoc);
  if (current.generation !== null && current.generation === snapshot.generation) {
    if (snapshot.revision <= current.revision) {
      return { applied: false, reason: "stale revision" };
    }
    replaceUserInputQueueItems(ydoc, boundedItems(snapshot.items));
    setUserInputQueueState(ydoc, {
      revision: snapshot.revision,
      activeRequestId: snapshot.activeRequestId,
    });
    return { applied: true };
  }
  // 换代（或首个快照）：旧代号的待发送项一律丢弃，revision 计数器随新代号重置
  replaceUserInputQueueItems(ydoc, boundedItems(snapshot.items));
  setUserInputQueueState(ydoc, {
    generation: snapshot.generation,
    revision: snapshot.revision,
    activeRequestId: snapshot.activeRequestId,
  });
  return { applied: true };
}

/** 应用 run_started：只更新 activeRequestId；旧代号的迟到事件丢弃（不推进 generation） */
function applyRunStarted(ydoc: Y.Doc, generation: string, requestId: string): UserInputQueueApplyResult {
  const current = readUserInputQueue(ydoc);
  if (current.generation !== null && current.generation !== generation) {
    return { applied: false, reason: "stale generation" };
  }
  if (current.activeRequestId === requestId) {
    return { applied: false, reason: "duplicate run started" };
  }
  setUserInputQueueState(ydoc, { activeRequestId: requestId });
  return { applied: true };
}

/**
 * 待发送队列事件的投影入口（聚合层 switch 调用；无 active turn 也可写入）。
 * delivered 只做队列侧摘除，用户消息写入见 aggregator.applyUserInputDeliveredMessage。
 */
export function applyUserInputQueueEvent(ydoc: Y.Doc, event: NormalizedEvent): UserInputQueueApplyResult {
  if (!USER_INPUT_QUEUE_EVENT_TYPES.has(event.type)) {
    return { applied: false, reason: `not a user input queue event: ${event.type}` };
  }
  ensureQueueStructure(ydoc);
  const queueEvent = event as NormalizedUserInputQueueEvent;
  switch (queueEvent.type) {
    case "user_input_queue_changed":
      return applySnapshot(ydoc, queueEvent.snapshot);
    case "user_input_run_started":
      return applyRunStarted(ydoc, queueEvent.generation, queueEvent.request_id);
    case "user_input_delivered":
      // 用户消息已进入 canonical transcript：待发送气泡必须立即摘除，不等下一次快照
      return removeUserInputQueueItem(ydoc, queueEvent.input_id)
        ? { applied: true }
        : { applied: false, reason: "input not queued" };
    default:
      return { applied: false, reason: "unhandled user input queue event" };
  }
}
