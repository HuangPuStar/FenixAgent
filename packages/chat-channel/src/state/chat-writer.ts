// packages/chat-channel/src/state/chat-writer.ts
// 新 schema（文档 5.2/5.3）的 Y.Doc 写入原语。
//
// 物理映射：根对象、entries、blocks、toolCalls、session、agent、pendingPermissions
// 使用 Y.Map；顺序索引 entryOrder 使用 Y.Array<string>；流式文本使用 Y.Text
// （避免逐 token 替换完整字符串）。所有写入必须在 ydoc.transact 内执行，
// 幂等性由调用方（aggregator）按 entryId / toolCallId / permissionId 保证。

import * as Y from "yjs";
import {
  CHAT_DOC_SCHEMA_VERSION,
  type ChatEntryKind,
  type ChatEntryRole,
  type ChatEntryStatus,
  INITIAL_PROJECTION_VERSION,
  PERI_TASK_FALLBACK_TITLE,
  PERI_TASK_VIEW_MAX,
  type PeriTaskViewProjection,
  type PermissionProjection,
  type QuestionProjection,
  SESSION_DOC_SCHEMA_VERSION,
  type SessionSummaryProjection,
  type TurnStatus,
} from "../schema";
import type { LoadingState, SessionStatus } from "../types";

// ── 物理访问辅助 ──

/** Chat Doc 根对象（schemaVersion / projectionVersion / entryOrder / entries / toolCalls） */
export function getChatRoot(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap("root");
}

/** Session Doc 根对象（schemaVersion / projectionVersion / session / agent / pendingPermissions） */
export function getSessionRoot(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap("root");
}

export function getEntryOrder(ydoc: Y.Doc): Y.Array<string> {
  return getChatRoot(ydoc).get("entryOrder") as Y.Array<string>;
}

export function getEntriesMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return getChatRoot(ydoc).get("entries") as Y.Map<Y.Map<unknown>>;
}

export function getToolCallsMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return getChatRoot(ydoc).get("toolCalls") as Y.Map<Y.Map<unknown>>;
}

export function getSessionInfo(ydoc: Y.Doc): Y.Map<unknown> {
  return getSessionRoot(ydoc).get("session") as Y.Map<unknown>;
}

export function getAgentStatus(ydoc: Y.Doc): Y.Map<unknown> {
  return getSessionRoot(ydoc).get("agent") as Y.Map<unknown>;
}

/**
 * CAS 解析与收敛的权威实现位于 state/permission.ts（applyPermissionResolution /
 * applyPermissionExpiration），聚合层与控制面共用同一入口；
 * 本文件只保留权限投影的写入原语（upsertPendingPermission）与读取辅助。
 */
export function getPendingPermissions(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return getSessionRoot(ydoc).get("pendingPermissions") as Y.Map<Y.Map<unknown>>;
}

/**
 * AskUserQuestion 交互问题投影（Session Doc 根 map pendingQuestions）。
 * CAS 迁移（pending → resolved/expired）权威实现见 state/question.ts，
 * 聚合层与控制面共用；本文件只保留投影的写入原语与读取辅助。
 */
export function getPendingQuestions(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return getSessionRoot(ydoc).get("pendingQuestions") as Y.Map<Y.Map<unknown>>;
}

/** Session Doc 根级会话列表投影（agent 级会话摘要，随 list_sessions 响应全量同步） */
export function getSessionsMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return getSessionRoot(ydoc).get("sessions") as Y.Map<Y.Map<unknown>>;
}

/** Session Doc 根级 Peri Task 投影（按 taskId 键控；结构见 schema.ts PeriTaskViewProjection） */
export function getPeriTasksMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return getSessionRoot(ydoc).get("tasks") as Y.Map<Y.Map<unknown>>;
}

/** Session Doc 根级 Peri Task 顺序索引（首次创建 append，更新不重排） */
export function getPeriTaskOrder(ydoc: Y.Doc): Y.Array<string> {
  return getSessionRoot(ydoc).get("taskOrder") as Y.Array<string>;
}

// ── 结构初始化（幂等：重复初始化不破坏已有内容）──

/** 初始化 Chat Doc 结构（新建或旧 schema 升级路径） */
export function initChatDocStructure(ydoc: Y.Doc): void {
  ydoc.transact(() => {
    const root = getChatRoot(ydoc);
    if (root.get("schemaVersion") !== CHAT_DOC_SCHEMA_VERSION) {
      root.set("schemaVersion", CHAT_DOC_SCHEMA_VERSION);
    }
    if (typeof root.get("projectionVersion") !== "number") {
      root.set("projectionVersion", INITIAL_PROJECTION_VERSION);
    }
    if (!(root.get("entryOrder") instanceof Y.Array)) {
      root.set("entryOrder", new Y.Array<string>());
    }
    if (!(root.get("entries") instanceof Y.Map)) {
      root.set("entries", new Y.Map<Y.Map<unknown>>());
    }
    if (!(root.get("toolCalls") instanceof Y.Map)) {
      root.set("toolCalls", new Y.Map<Y.Map<unknown>>());
    }
  });
}

/** 初始化 Session Doc 结构（新建或旧 schema 升级路径） */
export function initSessionDocStructure(ydoc: Y.Doc): void {
  ydoc.transact(() => {
    const root = getSessionRoot(ydoc);
    if (root.get("schemaVersion") !== SESSION_DOC_SCHEMA_VERSION) {
      root.set("schemaVersion", SESSION_DOC_SCHEMA_VERSION);
    }
    if (typeof root.get("projectionVersion") !== "number") {
      root.set("projectionVersion", INITIAL_PROJECTION_VERSION);
    }
    if (!(root.get("session") instanceof Y.Map)) {
      root.set("session", new Y.Map<unknown>());
    }
    if (!(root.get("agent") instanceof Y.Map)) {
      root.set("agent", new Y.Map<unknown>());
    }
    if (!(root.get("pendingPermissions") instanceof Y.Map)) {
      root.set("pendingPermissions", new Y.Map<Y.Map<unknown>>());
    }
    if (!(root.get("pendingQuestions") instanceof Y.Map)) {
      root.set("pendingQuestions", new Y.Map<Y.Map<unknown>>());
    }
    if (!(root.get("sessions") instanceof Y.Map)) {
      root.set("sessions", new Y.Map<Y.Map<unknown>>());
    }
    // v4：Peri Task View 投影位（幂等补结构，旧 v3 快照恢复后自动补齐）
    if (!(root.get("tasks") instanceof Y.Map)) {
      root.set("tasks", new Y.Map<Y.Map<unknown>>());
    }
    if (!(root.get("taskOrder") instanceof Y.Array)) {
      root.set("taskOrder", new Y.Array<string>());
    }
  });
}

/** projectionVersion +1 并返回新值（描述 ACP 数据已镜像进度，与 schemaVersion 不可混用） */
export function bumpProjectionVersion(root: Y.Map<unknown>): number {
  const next = ((root.get("projectionVersion") as number | undefined) ?? INITIAL_PROJECTION_VERSION) + 1;
  root.set("projectionVersion", next);
  return next;
}

// ── Chat Entry ──

export interface EntryInit {
  entryId: string;
  turnId: string | null;
  kind: ChatEntryKind;
  role: ChatEntryRole;
  authorUserId?: string | null;
}

/**
 * 幂等创建 Entry：entryId 已存在则返回现有对象（不重复创建、不改变顺序），
 * 否则追加到 entryOrder 末尾并初始化 blockOrder/blocks。
 */
export function ensureEntry(ydoc: Y.Doc, init: EntryInit): Y.Map<unknown> {
  const entries = getEntriesMap(ydoc);
  const existing = entries.get(init.entryId);
  if (existing) return existing;

  const entry = new Y.Map<unknown>();
  entry.set("entryId", init.entryId);
  entry.set("turnId", init.turnId);
  entry.set("kind", init.kind);
  entry.set("role", init.role);
  entry.set("status", "pending");
  entry.set("authorUserId", init.authorUserId ?? null);
  entry.set("createdAt", new Date().toISOString());
  entry.set("completedAt", null);
  entry.set("blockOrder", new Y.Array<string>());
  entry.set("blocks", new Y.Map<Y.Map<unknown>>());
  entry.set("error", null);

  entries.set(init.entryId, entry);
  getEntryOrder(ydoc).push([init.entryId]);
  return entry;
}

export function getEntry(ydoc: Y.Doc, entryId: string): Y.Map<unknown> | null {
  return getEntriesMap(ydoc).get(entryId) ?? null;
}

/**
 * 设置 Entry 状态（终态由调用方状态机保证不可逆）。
 * 同值短路（SP-A3）：流式期间聚合层对每帧 message_delta/reasoning_delta 重复
 * 设置 "streaming"，yjs 同值 set 无相等性检查、仍产生新 op（Item + tombstone），
 * 必须在此短路消除冗余 op。终态例外：completedAt 首次补写语义必须保留
 * （历史数据可能终态但缺 completedAt，短路不得吞掉补写）。
 */
export function setEntryStatus(ydoc: Y.Doc, entryId: string, status: ChatEntryStatus): void {
  const entry = getEntry(ydoc, entryId);
  if (!entry) return;
  const isTerminal = status === "completed" || status === "cancelled" || status === "error";
  if (entry.get("status") === status) {
    // 同值：非终态直接跳过；终态仅补写缺失的 completedAt（不重写 status）
    if (!isTerminal || entry.get("completedAt")) return;
    entry.set("completedAt", new Date().toISOString());
    return;
  }
  entry.set("status", status);
  if (isTerminal && !entry.get("completedAt")) entry.set("completedAt", new Date().toISOString());
}

/** 在 Entry 上写入 turn 完成摘要（token 用量等，仅终态写入） */
export function setEntryTokenUsage(
  ydoc: Y.Doc,
  entryId: string,
  usage: Record<string, unknown> | null | undefined,
): void {
  const entry = getEntry(ydoc, entryId);
  if (!entry || !usage) return;
  entry.set("tokenUsage", usage);
}

/**
 * 顺序感知的文本追加：目标块按「顺序相邻」聚合而非 blockId 存在性——
 * 末尾块为同类型时流式追加（保持单块聚合），否则新建唯一编号的文本块
 * （text:1 / reasoning:1 …）。文本流被工具调用打断后再次输出文本时必须
 * 新建块，否则 "ai → tool×N → ai" 两段文本会错误合并到同一块。
 */
export function appendEntryText(
  ydoc: Y.Doc,
  entryId: string,
  blockId: string,
  blockType: "text" | "reasoning",
  text: string,
  visibility?: "summary" | "hidden",
): Y.Map<unknown> {
  const entry = getEntry(ydoc, entryId);
  if (!entry) return new Y.Map<unknown>();

  const blocks = entry.get("blocks") as Y.Map<Y.Map<unknown>>;
  const blockOrder = entry.get("blockOrder") as Y.Array<string>;

  const lastBlockId = blockOrder.get(blockOrder.length - 1) ?? "";
  const lastBlock = lastBlockId ? blocks.get(lastBlockId) : undefined;
  let targetId: string;
  if (lastBlock?.get("type") === blockType) {
    // 末尾相邻同类型块：直接追加（连续文本流保持单块）
    targetId = lastBlockId;
  } else if (blocks.has(blockId)) {
    // 目标 ID 已被占用（文本流被工具/其他类型块打断）→ 新建顺序编号块
    targetId = nextTextBlockId(blocks, blockType);
  } else {
    // 首个文本块：沿用调用方 blockId（兼容既有数据与调用方语义）
    targetId = blockId;
  }

  let block = blocks.get(targetId);
  if (!block) {
    block = new Y.Map<unknown>();
    block.set("blockId", targetId);
    block.set("type", blockType);
    const ytext = new Y.Text();
    block.set("text", ytext);
    if (blockType === "reasoning" && visibility) block.set("visibility", visibility);
    blocks.set(targetId, block);
    blockOrder.push([targetId]);
  }
  const ytext = block.get("text") as Y.Text;
  ytext.insert(ytext.length, text);
  return block;
}

/** 生成 entry 内不冲突的顺序编号文本块 ID（text:1 / reasoning:1 …） */
function nextTextBlockId(blocks: Y.Map<Y.Map<unknown>>, blockType: "text" | "reasoning"): string {
  let seq = 1;
  while (blocks.has(`${blockType}:${seq}`)) seq++;
  return `${blockType}:${seq}`;
}

/** 幂等添加 tool_call 块（blockId = tool:{toolCallId}），已存在返回 false */
export function addToolCallBlock(ydoc: Y.Doc, entryId: string, toolCallId: string): boolean {
  const entry = getEntry(ydoc, entryId);
  if (!entry) return false;
  const blockId = `tool:${toolCallId}`;
  const blocks = entry.get("blocks") as Y.Map<Y.Map<unknown>>;
  if (blocks.has(blockId)) return false;
  const block = new Y.Map<unknown>();
  block.set("blockId", blockId);
  block.set("type", "tool_call");
  block.set("toolCallId", toolCallId);
  blocks.set(blockId, block);
  (entry.get("blockOrder") as Y.Array<string>).push([blockId]);
  return true;
}

// ── ToolCall ──

export interface ToolCallInit {
  toolCallId: string;
  turnId: string;
  name: string;
  status: "pending" | "awaiting_permission" | "running" | "completed" | "error" | "cancelled";
  arguments?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  /** 工具失败的脱敏错误（error 状态由聚合层传 extractPublicError，其余状态不携带） */
  publicError?: { code: string; message: string } | null;
  permissionId?: string | null;
}

/** 幂等 upsert 工具调用：以 toolCallId 为键，重放同一帧只覆盖不重复创建 */
export function upsertToolCall(ydoc: Y.Doc, init: ToolCallInit): Y.Map<unknown> {
  const toolCalls = getToolCallsMap(ydoc);
  const existing = toolCalls.get(init.toolCallId);
  if (existing) {
    if (init.name) existing.set("name", init.name);
    if (init.status) existing.set("status", init.status);
    if (init.arguments != null) existing.set("arguments", init.arguments);
    if (init.result != null) existing.set("result", init.result);
    if (init.publicError !== undefined) existing.set("publicError", init.publicError ?? null);
    if (init.permissionId != null) existing.set("permissionId", init.permissionId);
    return existing;
  }
  const projection = new Y.Map<unknown>();
  projection.set("toolCallId", init.toolCallId);
  projection.set("turnId", init.turnId);
  projection.set("name", init.name);
  projection.set("status", init.status);
  projection.set("arguments", init.arguments ?? null);
  projection.set("result", init.result ?? null);
  projection.set("publicError", init.publicError ?? null);
  projection.set("permissionId", init.permissionId ?? null);
  toolCalls.set(init.toolCallId, projection);
  return projection;
}

/** 更新工具调用状态（终态后调用方不得再回退） */
export function setToolCallStatus(ydoc: Y.Doc, toolCallId: string, status: ToolCallInit["status"]): void {
  const tool = getToolCallsMap(ydoc).get(toolCallId);
  if (tool) tool.set("status", status);
}

// ── Session Doc 写入 ──

/**
 * 覆盖式写入会话元信息（缺失字段不清除，用于跨帧累积）。
 * 字段级短路（SP-A3）：仅写入与现值不同的字段；全部字段未变时不写 updatedAt，
 * 避免 session_updated 重复帧（重连重放/轮询）持续产生 Session Doc op。
 */
export function setSessionInfo(ydoc: Y.Doc, patch: Record<string, unknown>): void {
  const session = getSessionInfo(ydoc);
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (session.get(key) !== value) {
      session.set(key, value);
      changed = true;
    }
  }
  if (changed) session.set("updatedAt", new Date().toISOString());
}

/** 覆盖式写入会话 Model 状态（session/new、load 响应的 models 提取结果，会话级元数据） */
export function setSessionModelState(
  ydoc: Y.Doc,
  state: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> },
): void {
  const session = getSessionInfo(ydoc);
  const models = new Y.Array<Y.Map<unknown>>();
  for (const m of state.availableModels) {
    const entry = new Y.Map<unknown>();
    entry.set("modelId", m.modelId);
    entry.set("name", m.name);
    models.push([entry]);
  }
  const modelState = new Y.Map<unknown>();
  modelState.set("currentModelId", state.currentModelId);
  modelState.set("availableModels", models);
  session.set("modelState", modelState);
  session.set("updatedAt", new Date().toISOString());
}

/** 覆盖式写入会话 Mode 状态（session/new、load 响应的 modes 提取结果，会话级元数据） */
export function setSessionModeState(
  ydoc: Y.Doc,
  state: { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string | null }> },
): void {
  const session = getSessionInfo(ydoc);
  const modes = new Y.Array<Y.Map<unknown>>();
  for (const m of state.availableModes) {
    const entry = new Y.Map<unknown>();
    entry.set("id", m.id);
    entry.set("name", m.name);
    entry.set("description", m.description ?? null);
    modes.push([entry]);
  }
  const modeState = new Y.Map<unknown>();
  modeState.set("currentModeId", state.currentModeId);
  modeState.set("availableModes", modes);
  session.set("modeState", modeState);
  session.set("updatedAt", new Date().toISOString());
}

/** 覆盖式写入会话可用命令列表（available_commands_update 投影，会话级元数据，slash 命令菜单数据源） */
export function setSessionAvailableCommands(
  ydoc: Y.Doc,
  commands: Array<{ name: string; description: string; input?: { hint: string } | null }>,
): void {
  const session = getSessionInfo(ydoc);
  const cmdArray = new Y.Array<Y.Map<unknown>>();
  for (const c of commands) {
    const entry = new Y.Map<unknown>();
    entry.set("name", c.name);
    entry.set("description", c.description);
    entry.set("input", c.input ?? null);
    cmdArray.push([entry]);
  }
  session.set("availableCommands", cmdArray);
  session.set("updatedAt", new Date().toISOString());
}

/** 覆盖式写入 Agent 状态（capabilities 为 Y.Map<boolean>） */
export function setAgentStatus(
  ydoc: Y.Doc,
  patch: {
    instanceId?: string | null;
    acpSessionId?: string | null;
    status?: string;
    capabilities?: Record<string, boolean>;
    lastActivityAt?: string | null;
    publicError?: unknown;
  },
): void {
  const agent = getAgentStatus(ydoc);
  if (patch.instanceId !== undefined) agent.set("instanceId", patch.instanceId);
  if (patch.acpSessionId !== undefined) agent.set("acpSessionId", patch.acpSessionId);
  if (patch.status !== undefined) agent.set("status", patch.status);
  if (patch.capabilities !== undefined) {
    const caps = new Y.Map<boolean>();
    for (const [key, value] of Object.entries(patch.capabilities)) caps.set(key, Boolean(value));
    agent.set("capabilities", caps);
  }
  if (patch.lastActivityAt !== undefined) agent.set("lastActivityAt", patch.lastActivityAt);
  if (patch.publicError !== undefined) agent.set("publicError", patch.publicError);
}

/** 读取活动 turn（session.activeTurn* 为权威；聚合层与权限 CAS 共用） */
export function readActiveTurn(ydoc: Y.Doc): { turnId: string | null; turnStatus: TurnStatus | null } {
  const session = getSessionInfo(ydoc);
  const turnId = session.get("activeTurnId") as string | null | undefined;
  const turnStatus = session.get("activeTurnStatus") as TurnStatus | null | undefined;
  return { turnId: turnId ?? null, turnStatus: turnStatus ?? null };
}

/**
 * 写入活动 turn（session.activeTurn* 平铺键为权威；终态由状态机保证不可逆）。
 * 同步投影前端展示态三字段（presenting / loading / canCancel，见
 * projectActiveTurnPresentation）：本函数是 turn 状态变更的唯一权威写入点，
 * 任何 activeTurn* 变更都必须经此投影，前端只读投影结果。
 */
export function setActiveTurn(ydoc: Y.Doc, turnId: string | null, turnStatus: TurnStatus | null): void {
  const session = getSessionInfo(ydoc);
  // 同值短路（SP-A3）：流式增量期间聚合层每帧重复调用（turnId/turnStatus 均
  // 未变），yjs 同值 set 仍产生新 op，不短路会每帧重写 activeTurnUpdatedAt/
  // updatedAt/展示态三字段。activeTurnUpdatedAt 语义为「turn 状态最近一次
  // 变更时刻」（loading.since 消费），非心跳（无 liveness 消费方），短路后
  // since 稳定在状态迁移时刻，语义更准确。
  if (session.get("activeTurnId") === turnId && session.get("activeTurnStatus") === turnStatus) return;
  session.set("activeTurnId", turnId);
  if (turnStatus === null) {
    session.set("activeTurnStatus", null);
  } else {
    session.set("activeTurnStatus", turnStatus);
  }
  const now = Date.now();
  session.set("activeTurnUpdatedAt", now);
  projectActiveTurnPresentation(session, turnId, turnStatus, now);
  session.set("updatedAt", new Date().toISOString());
}

/**
 * 投影前端展示态三字段（session.presenting / loading / canCancel 平铺键）。
 * 行为与前端旧派生逻辑完全一致（web/src/hooks/use-session-state.ts 的
 * mapTurnStatus / deriveCanCancel，含 loading.since = activeTurnUpdatedAt）：
 * - presenting：turn 为 null → "idle"；accepting/cancelling → "loading"；
 *   running → 回放 turn 为 "replaying"、实时为 "responding"；
 *   awaiting_permission → "waiting-user"；终态 → "done"/"error"
 * - loading：非回放 turn 且 turnStatus ∈ {accepting, running, cancelling}
 *   → { kind: "session/respond", since: <activeTurnUpdatedAt> }，其余为 null
 * - canCancel：非回放 turn 且 turnStatus ∈ {accepting, running, awaiting_permission}
 * 回放 turn（turn_replay_* 前缀，见 relay-event-handler 的 createReplayTurnId）
 * 视为静态历史：不派生 loading 与 canCancel，避免切换会话后出现持续数秒的
 * 伪"输出中"指示。
 */
function projectActiveTurnPresentation(
  session: Y.Map<unknown>,
  turnId: string | null,
  turnStatus: TurnStatus | null,
  since: number,
): void {
  const isReplayTurn = turnId?.startsWith("turn_replay_") ?? false;
  let presenting: SessionStatus = "idle";
  switch (turnStatus) {
    case "accepting":
      presenting = "loading";
      break;
    case "running":
      presenting = isReplayTurn ? "replaying" : "responding";
      break;
    case "awaiting_permission":
      presenting = "waiting-user";
      break;
    case "cancelling":
      presenting = "loading";
      break;
    case "completed":
    case "cancelled":
    case "interrupted":
      presenting = "done";
      break;
    case "failed":
      presenting = "error";
      break;
  }
  const loading: LoadingState | null =
    !isReplayTurn && (turnStatus === "accepting" || turnStatus === "running" || turnStatus === "cancelling")
      ? { kind: "session/respond", since }
      : null;
  const canCancel =
    !isReplayTurn && (turnStatus === "accepting" || turnStatus === "running" || turnStatus === "awaiting_permission");
  session.set("presenting", presenting);
  session.set("loading", loading);
  session.set("canCancel", canCancel);
}

/** 是否仍有 pending 权限（决定 turn 是否可离开 awaiting_permission） */
export function hasPendingPermission(ydoc: Y.Doc): boolean {
  return Array.from(getPendingPermissions(ydoc).values()).some((p) => p.get("status") === "pending");
}

/**
 * 幂等 upsert 权限投影：以 permissionId 为键。
 * 注意：CAS 迁移（pending → resolved/expired）权威实现见 state/permission.ts，
 * 这里只负责请求落地，不承载迁移语义。
 */
export function upsertPendingPermission(ydoc: Y.Doc, projection: PermissionProjection): void {
  const pending = getPendingPermissions(ydoc);
  if (pending.has(projection.permissionId)) return;
  const map = new Y.Map<unknown>();
  map.set("permissionId", projection.permissionId);
  map.set("turnId", projection.turnId);
  map.set("toolCallId", projection.toolCallId ?? null);
  map.set("title", projection.title);
  map.set("description", projection.description ?? null);
  map.set("options", projection.options);
  map.set("status", projection.status);
  map.set("decision", projection.decision);
  map.set("expiresAt", projection.expiresAt);
  pending.set(projection.permissionId, map);
}

/**
 * 幂等 upsert AskUserQuestion 投影：以 questionId 为键。
 * 注意：CAS 迁移（pending → resolved/expired）权威实现见 state/question.ts，
 * 这里只负责请求落地，不承载迁移语义。
 */
export function upsertPendingQuestion(ydoc: Y.Doc, projection: QuestionProjection): void {
  const pending = getPendingQuestions(ydoc);
  if (pending.has(projection.questionId)) return;
  const map = new Y.Map<unknown>();
  map.set("questionId", projection.questionId);
  map.set("questions", projection.questions);
  map.set("description", projection.description ?? null);
  map.set("status", projection.status);
  map.set("answer", projection.answer);
  map.set("expiresAt", projection.expiresAt);
  pending.set(projection.questionId, map);
}

// ── Peri Task View（Session Doc root.tasks / root.taskOrder，切片 1）──
// writer 只负责物理写入原语，不做状态机（状态收敛规则在 aggregator 的
// applyPeriTaskEvent）与 I/O；禁止把 event_json / 完整 result / locator 写入。

/**
 * 幂等 upsert Peri Task 投影：以 taskId 为键。
 * - 首次创建时 append 一次 taskOrder（创建顺序），更新不重排；
 * - 身份性/展示字段选择性覆盖：title 只在非空时覆盖（started 提供的标题不被
 *   completed 的 fallback 顶掉）；taskSubtype 只在非 null 时覆盖（completed 事件
 *   无合法 subtype 时保留 started 值）；startedAt / isBackground / turnId 仅首次
 *   创建写入——终态事件没有源开始时间（规格：不用 duration_ms 反推 startedAt），
 *   不得用 receivedAt 覆盖 started 事件写入的合法 started_at；
 * - 状态机（终态保护 / terminal-first / 冲突保留）由 aggregator 保证，
 *   本原语不校验状态，调用方不得越权回退终态。
 * 返回是否首次创建（created=true 时调用方无需再处理 taskOrder）。
 */
export function upsertPeriTaskView(ydoc: Y.Doc, view: PeriTaskViewProjection): { created: boolean } {
  const tasks = getPeriTasksMap(ydoc);
  const existing = tasks.get(view.taskId);
  if (existing) {
    if (view.title) existing.set("title", view.title);
    if (view.taskSubtype) existing.set("taskSubtype", view.taskSubtype);
    existing.set("summary", view.summary);
    existing.set("status", view.status);
    existing.set("completedAt", view.completedAt);
    existing.set("updatedAt", view.updatedAt);
    existing.set("detailAvailability", view.detailAvailability);
    return { created: false };
  }
  const map = new Y.Map<unknown>();
  map.set("taskId", view.taskId);
  map.set("kind", view.kind);
  map.set("taskSubtype", view.taskSubtype);
  map.set("title", view.title || PERI_TASK_FALLBACK_TITLE);
  map.set("summary", view.summary);
  map.set("status", view.status);
  map.set("turnId", view.turnId);
  map.set("isBackground", view.isBackground);
  map.set("startedAt", view.startedAt);
  map.set("completedAt", view.completedAt);
  map.set("updatedAt", view.updatedAt);
  map.set("detailAvailability", view.detailAvailability);
  tasks.set(view.taskId, map);
  const order = getPeriTaskOrder(ydoc);
  order.push([view.taskId]);

  // Session Doc 首帧会完整同步，必须硬性有界。优先淘汰最早的终态任务；
  // 极端情况下全部任务都在运行，则淘汰最早任务以守住资源上限。
  while (order.length > PERI_TASK_VIEW_MAX) {
    const taskIds = order.toArray();
    const terminalIndex = taskIds.findIndex((taskId) => {
      const status = tasks.get(taskId)?.get("status");
      return status === "completed" || status === "failed" || status === "cancelled";
    });
    const evictedIndex = terminalIndex >= 0 ? terminalIndex : 0;
    const evictedTaskId = taskIds[evictedIndex];
    if (evictedTaskId) tasks.delete(evictedTaskId);
    order.delete(evictedIndex, 1);
  }
  return { created: true };
}

/** 清空 Peri Task 投影（tasks + taskOrder；随 clearSessionDocContent 一起调用） */
export function clearPeriTaskViews(ydoc: Y.Doc): void {
  const root = getSessionRoot(ydoc);
  const tasks = root.get("tasks");
  if (tasks instanceof Y.Map) {
    tasks.clear();
  } else {
    root.set("tasks", new Y.Map<Y.Map<unknown>>());
  }
  const taskOrder = root.get("taskOrder");
  if (taskOrder instanceof Y.Array) {
    taskOrder.delete(0, taskOrder.length);
  } else {
    root.set("taskOrder", new Y.Array<string>());
  }
}

// ── 清理（领域 tombstone：不物理删除权威记录，切换会话时整 Doc 清空）──

/** 清空 Chat Doc 时间线内容（entryOrder/entries/toolCalls），保留 schema 骨架并移除历史 planSeq。 */
export function clearChatDocContent(ydoc: Y.Doc): void {
  ydoc.transact(() => {
    const root = getChatRoot(ydoc);
    getEntryOrder(ydoc).delete(0, getEntryOrder(ydoc).length);
    getEntriesMap(ydoc).clear();
    getToolCallsMap(ydoc).clear();
    root.delete("planSeq");
    bumpProjectionVersion(root);
  });
}

/**
 * 清空 Session Doc 内容（session/pendingPermissions/pendingQuestions/tasks），保留 schema 骨架、sessions 投影与 agent 状态。
 * agent 是实例级状态（capabilities/instanceId/status），跨会话切换必须保留：agent 仅在连接/
 * initialize 时发送 status 帧，切换会话（load/create）后不会重新投影；清空会导致 capabilities
 * 永久丢失，前端 supportsLoadSession 变 false，切换会话报 "Loading or resuming sessions is
 * not supported"（会话切换回归）。仅清除会话绑定的 acpSessionId（切换后旧值失效；前端不消费，
 * 权威值在服务端 registry）。
 * Peri Task 是会话级瞬时投影（同 pendingPermissions 语义）：切换会话时随 Doc 清空，
 * 新会话的 Task 从零开始累积（Task 视图不跨会话保留）。
 */
export function clearSessionDocContent(ydoc: Y.Doc): void {
  ydoc.transact(() => {
    const root = getSessionRoot(ydoc);
    root.set("session", new Y.Map<unknown>());
    const agent = root.get("agent");
    if (agent instanceof Y.Map) {
      agent.delete("acpSessionId");
    }
    root.set("pendingPermissions", new Y.Map<Y.Map<unknown>>());
    // AskUserQuestion 交互问题是会话级瞬时状态：切换会话（load/create）时随 Doc 清空，
    // 未回答的问题由 acp-link 侧 60s 超时自动 resolve 空答案兜底（无悬挂风险）
    root.set("pendingQuestions", new Y.Map<Y.Map<unknown>>());
    // Peri Task 视图是会话级瞬时状态（见函数注释），保持共享类型实例稳定，
    // 避免持有 tasks/taskOrder 引用的订阅者在会话切换后与新投影脱钩。
    clearPeriTaskViews(ydoc);
    // sessions 是 agent 级数据（跨会话切换不清空，避免侧边栏闪空），随 list_sessions 轮询刷新
    bumpProjectionVersion(root);
  });
}

/**
 * 全量同步会话列表（幂等）：按 sessionId upsert，删除不在列表中的旧条目。
 * 保证 10s 轮询重复响应不重复追加、agent 侧删除可愈。
 * 返回是否发生实际字段变更（SP-A2）：完全相同的响应返回 false，
 * 供 applySessionList 做「零 op 短路」判定。
 *
 * 空列表保护：summaries 为空（agent 重启后列表尚未恢复、或全部条目被 acp-link
 * 的"空标题/New session"过滤滤掉）时**不清空**已有条目——瞬时空响应会清空
 * 整个 map，叠加当前会话 title 不投影导致侧边栏全部显示"新会话"；
 * 真实删除由非空响应自愈（被删会话不在 incoming 中）。
 */
export function syncSessionsMap(ydoc: Y.Doc, summaries: SessionSummaryProjection[]): boolean {
  const sessions = getSessionsMap(ydoc);
  const incoming = new Set<string>();
  let changed = false;
  for (const s of summaries) {
    incoming.add(s.sessionId);
    const existing = sessions.get(s.sessionId);
    if (existing) {
      if (typeof s.title === "string" && existing.get("title") !== s.title) {
        existing.set("title", s.title);
        changed = true;
      }
      if (typeof s.cwd === "string" && existing.get("cwd") !== s.cwd) {
        existing.set("cwd", s.cwd);
        changed = true;
      }
      if (typeof s.updatedAt === "string" && existing.get("updatedAt") !== s.updatedAt) {
        existing.set("updatedAt", s.updatedAt);
        changed = true;
      }
      continue;
    }
    const entry = new Y.Map<unknown>();
    entry.set("sessionId", s.sessionId);
    entry.set("title", s.title ?? null);
    entry.set("cwd", s.cwd ?? null);
    entry.set("updatedAt", s.updatedAt ?? null);
    sessions.set(s.sessionId, entry);
    changed = true;
  }
  if (summaries.length === 0) return changed; // 空响应不清空（见函数注释）
  for (const sessionId of Array.from(sessions.keys())) {
    if (!incoming.has(sessionId)) {
      sessions.delete(sessionId);
      changed = true;
    }
  }
  return changed;
}

/** Chat Doc 是否包含时间线内容（用于重连时判断是否需要跳过全量回放） */
export function hasChatDocContent(ydoc: Y.Doc): boolean {
  return getEntryOrder(ydoc).length > 0 || getToolCallsMap(ydoc).size > 0;
}
