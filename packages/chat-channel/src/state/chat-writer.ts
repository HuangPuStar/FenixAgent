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
  type PermissionProjection,
  SESSION_DOC_SCHEMA_VERSION,
  type SessionSummaryProjection,
  type TurnStatus,
} from "../schema";

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

/** Session Doc 根级会话列表投影（agent 级会话摘要，随 list_sessions 响应全量同步） */
export function getSessionsMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return getSessionRoot(ydoc).get("sessions") as Y.Map<Y.Map<unknown>>;
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
    if (!(root.get("sessions") instanceof Y.Map)) {
      root.set("sessions", new Y.Map<Y.Map<unknown>>());
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

/** 设置 Entry 状态（终态由调用方状态机保证不可逆） */
export function setEntryStatus(ydoc: Y.Doc, entryId: string, status: ChatEntryStatus): void {
  const entry = getEntry(ydoc, entryId);
  if (!entry) return;
  entry.set("status", status);
  if (status === "completed" || status === "cancelled" || status === "error") {
    if (!entry.get("completedAt")) entry.set("completedAt", new Date().toISOString());
  }
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
 * 幂等追加文本块：blockId 已存在（类型一致）则向 Y.Text 追加 text，
 * 否则新建 text 块。返回块对象。流式文本用 Y.Text 保证增量同步效率。
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
  let block = blocks.get(blockId);
  if (!block) {
    block = new Y.Map<unknown>();
    block.set("blockId", blockId);
    block.set("type", blockType);
    const ytext = new Y.Text();
    block.set("text", ytext);
    if (blockType === "reasoning" && visibility) block.set("visibility", visibility);
    blocks.set(blockId, block);
    blockOrder.push([blockId]);
  }
  const ytext = block.get("text") as Y.Text;
  ytext.insert(ytext.length, text);
  return block;
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
  projection.set("publicError", null);
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

/** 覆盖式写入会话元信息（缺失字段不清除，用于跨帧累积） */
export function setSessionInfo(ydoc: Y.Doc, patch: Record<string, unknown>): void {
  const session = getSessionInfo(ydoc);
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) session.set(key, value);
  }
  session.set("updatedAt", new Date().toISOString());
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

/** 写入活动 turn（session.activeTurn 为权威；终态由状态机保证不可逆） */
export function setActiveTurn(ydoc: Y.Doc, turnId: string | null, turnStatus: TurnStatus | null): void {
  const session = getSessionInfo(ydoc);
  session.set("activeTurnId", turnId);
  if (turnStatus === null) {
    session.set("activeTurnStatus", null);
  } else {
    session.set("activeTurnStatus", turnStatus);
  }
  session.set("activeTurnUpdatedAt", Date.now());
  session.set("updatedAt", new Date().toISOString());
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

// ── 清理（领域 tombstone：不物理删除权威记录，切换会话时整 Doc 清空）──

/** 清空 Chat Doc 时间线内容（entryOrder/entries/toolCalls/planSeq），保留 schema 骨架 */
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
 * 清空 Session Doc 内容（session/pendingPermissions），保留 schema 骨架、sessions 投影与 agent 状态。
 * agent 是实例级状态（capabilities/instanceId/status），跨会话切换必须保留：agent 仅在连接/
 * initialize 时发送 status 帧，切换会话（load/create）后不会重新投影；清空会导致 capabilities
 * 永久丢失，前端 supportsLoadSession 变 false，切换会话报 "Loading or resuming sessions is
 * not supported"（会话切换回归）。仅清除会话绑定的 acpSessionId（切换后旧值失效；前端不消费，
 * 权威值在服务端 registry）。
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
    // sessions 是 agent 级数据（跨会话切换不清空，避免侧边栏闪空），随 list_sessions 轮询刷新
    bumpProjectionVersion(root);
  });
}

/**
 * 全量同步会话列表（幂等）：按 sessionId upsert，删除不在列表中的旧条目。
 * 保证 10s 轮询重复响应不重复追加、agent 侧删除可自愈。
 *
 * 空列表保护：summaries 为空（agent 重启后列表尚未恢复、或全部条目被 acp-link
 * 的"空标题/New session"过滤滤掉）时**不清空**已有条目——瞬时空响应会清空
 * 整个 map，叠加当前会话 title 不投影导致侧边栏全部显示"新会话"；
 * 真实删除由非空响应自愈（被删会话不在 incoming 中）。
 */
export function syncSessionsMap(ydoc: Y.Doc, summaries: SessionSummaryProjection[]): void {
  const sessions = getSessionsMap(ydoc);
  const incoming = new Set<string>();
  for (const s of summaries) {
    incoming.add(s.sessionId);
    const existing = sessions.get(s.sessionId);
    if (existing) {
      if (typeof s.title === "string" && existing.get("title") !== s.title) existing.set("title", s.title);
      if (typeof s.cwd === "string" && existing.get("cwd") !== s.cwd) existing.set("cwd", s.cwd);
      if (typeof s.updatedAt === "string" && existing.get("updatedAt") !== s.updatedAt)
        existing.set("updatedAt", s.updatedAt);
      continue;
    }
    const entry = new Y.Map<unknown>();
    entry.set("sessionId", s.sessionId);
    entry.set("title", s.title ?? null);
    entry.set("cwd", s.cwd ?? null);
    entry.set("updatedAt", s.updatedAt ?? null);
    sessions.set(s.sessionId, entry);
  }
  if (summaries.length === 0) return; // 空响应不清空（见函数注释）
  for (const sessionId of Array.from(sessions.keys())) {
    if (!incoming.has(sessionId)) sessions.delete(sessionId);
  }
}

/** Chat Doc 是否包含时间线内容（用于重连时判断是否需要跳过全量回放） */
export function hasChatDocContent(ydoc: Y.Doc): boolean {
  return getEntryOrder(ydoc).length > 0 || getToolCallsMap(ydoc).size > 0;
}
