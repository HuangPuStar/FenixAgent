// packages/chat-channel/src/schema.ts
// Chat 域新 Y.Doc schema（文档 5.2/5.3）与规范化事件类型。
//
// 职责错位纠正：Chat Doc `chat:{rcsSessionId}` = 消息时间线（高频），
// Session Doc `session:{rcsSessionId}` = 会话元信息 / Agent 状态（低频）。
// 旧字段（agentInfo/sessions/chatMeta/connection/permissions/capabilities/
// tokenUsage/messages/streaming/tools/artifacts/structuredMessages）全部删除，
// 无兼容窗口；modelState/modeState/availableCommands 以新结构恢复为 Session Doc
// session map 的会话级元数据投影（session/new、load 响应与 available_commands_update
// 通知经聚合层写入，见 state/aggregator.ts applySessionControl）。

// ── 版本 ──

/** Chat Doc 结构版本（schemaVersion，描述结构而非投影进度） */
export const CHAT_DOC_SCHEMA_VERSION = 2;
/**
 * Session Doc 结构版本。3：新增根级 sessions 投影位（agent 级会话列表）。
 * loadSessionDoc 以 schemaVersion 判空触发 initSessionDocStructure 幂等补结构，
 * Redis 旧快照（v2）恢复后自动补齐 sessions map。
 */
export const SESSION_DOC_SCHEMA_VERSION = 3;
/** Chat Doc 初始投影版本（每次成功投影后 +1，见 bumpProjectionVersion） */
export const INITIAL_PROJECTION_VERSION = 1;

// ── Chat Doc schema（5.2）──

export type ChatEntryKind = "message" | "tool" | "system";
export type ChatEntryRole = "user" | "assistant" | "system";
export type ChatEntryStatus = "pending" | "streaming" | "completed" | "cancelled" | "error";

/** 对外暴露的公开错误（不含内部实现细节与敏感信息） */
export interface PublicError {
  code: string;
  message: string;
}

/** ContentBlock 逻辑类型（物理存储为 Y.Map，流式文本用 Y.Text） */
export type ContentBlock =
  | { blockId: string; type: "text"; text: string }
  | {
      blockId: string;
      type: "reasoning";
      text: string;
      visibility: "summary" | "hidden";
    }
  | { blockId: string; type: "tool_call"; toolCallId: string }
  | {
      blockId: string;
      type: "resource";
      resourceId: string;
      mediaType: string;
      name: string;
    };

/** Chat Entry 逻辑类型（物理存储为 Y.Map，blocks 为 Y.Map<Y.Map>，blockOrder 为 Y.Array<string>） */
export interface ChatEntry {
  entryId: string;
  turnId: string | null;
  kind: ChatEntryKind;
  role: ChatEntryRole;
  status: ChatEntryStatus;
  authorUserId: string | null;
  createdAt: string;
  completedAt: string | null;
  blockOrder: string[];
  blocks: ContentBlock[];
  error: PublicError | null;
}

/** 工具调用投影（tool_call block 通过 toolCallId 引用，状态收敛在 Chat Doc 根的 toolCalls） */
export type ToolCallStatus = "pending" | "awaiting_permission" | "running" | "completed" | "error" | "cancelled";

export interface ToolCallProjection {
  toolCallId: string;
  turnId: string;
  name: string;
  status: ToolCallStatus;
  arguments: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  publicError: PublicError | null;
  permissionId: string | null;
}

// ── Session Doc schema（5.3）──

export type SessionDocStatus = "initializing" | "ready" | "running" | "degraded" | "closed";
/** Agent 运行时状态：initializing 为未就绪 status（capabilities 为空）投影值，就绪后为 ready */
export type AgentRuntimeStatus = "offline" | "starting" | "initializing" | "ready" | "busy" | "error";
export type PermissionStatus = "pending" | "resolved" | "expired";
export type PermissionOptionKind = "allow_once" | "allow_session" | "deny";

/** Turn 状态机（8.1）：终态不可逆；恢复执行必须创建新 turn */
export type TurnStatus =
  | "accepting"
  | "running"
  | "awaiting_permission"
  | "cancelling"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "completed";

/**
 * Session Doc session map 投影（物理结构为平铺键：
 * activeTurnId / activeTurnStatus / activeTurnUpdatedAt，
 * 与 chat-writer.ts setActiveTurn 写入保持一致；无嵌套 activeTurn 对象）。
 * 展示态三字段（presenting / loading / canCancel）由 setActiveTurn 同步投影：
 * 前端只读投影结果，不再自行从 activeTurnStatus 派生（见 types.ts SessionStatus；
 * 回放 turn turn_replay_* 投影为 "replaying" 且 loading=null / canCancel=false）。
 */
export interface SessionInfoProjection {
  sessionId: string;
  title: string | null;
  status: SessionDocStatus;
  environmentId: string;
  agentConfigId: string;
  activeTurnId: string | null;
  activeTurnStatus: TurnStatus | null;
  activeTurnUpdatedAt: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentStatusProjection {
  instanceId: string | null;
  acpSessionId: string | null;
  status: AgentRuntimeStatus;
  capabilities: Record<string, boolean>;
  lastActivityAt: string | null;
  publicError: PublicError | null;
}

export interface PermissionProjection {
  permissionId: string;
  turnId: string;
  toolCallId: string | null;
  title: string;
  description: string | null;
  options: PermissionOptionKind[];
  status: PermissionStatus;
  expiresAt: string;
  /**
   * 决议结果：CAS 迁移成功后写入（allow/deny）；upsert 创建时为 null；
   * expired 不写（保持 null）。前端按此展示 approved/denied。
   */
  decision: "allow" | "deny" | null;
}

/** 会话列表投影条目（agent 级会话摘要，随 list_sessions 响应全量同步；按 sessionId 键控） */
export interface SessionSummaryProjection {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  updatedAt: string | null;
}

// ── 规范化事件（ACPChannel 输出，聚合层唯一消费输入）──

/**
 * 规范化事件类型。ACPChannel 把 acp-link 私有帧
 * （agent_message_chunk / agent_thought_chunk / prompt_complete 等）
 * 翻译为 session/update 语义的统一事件；聚合层只消费这些类型。
 */
export type NormalizedEventType =
  | "message_delta"
  | "reasoning_delta"
  | "user_message"
  | "tool_call_started"
  | "tool_call_updated"
  | "tool_call_completed"
  | "tool_call_failed"
  | "permission_requested"
  | "permission_resolved"
  | "permission_expired"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancel_requested"
  | "turn_cancelled"
  | "turn_interrupted"
  | "plan"
  | "session_updated"
  | "agent_status"
  | "session_list";

/**
 * 规范化事件：聚合层唯一允许消费的 ACP 入站形态。
 * - update：原 session/update 语义载荷（含 sessionUpdate 与结构化字段）
 * - content：update.content（文本增量/内容块）
 * - turnId：宿主在用户消息写入时生成；聚合层以此做映射幂等
 */
export interface NormalizedEvent {
  type: NormalizedEventType;
  update: Record<string, unknown>;
  content: Record<string, unknown> | null;
  /** 帧携带的 ACP sessionId，仅用于 binding 校验，不得用于 Y.Doc 寻址 */
  acpSessionId?: string | null;
  turnId?: string | null;
}

/** Turn 终态集合：终态后到达的同 turn 增量一律丢弃 */
export const TURN_TERMINAL_STATUSES: ReadonlySet<TurnStatus> = new Set([
  "cancelled",
  "interrupted",
  "failed",
  "completed",
]);

/** 工具调用终态集合：终态后不得回退（tool_call_updated 重放/乱序时拒绝状态覆盖） */
export const TOOL_TERMINAL_STATUSES: ReadonlySet<ToolCallStatus> = new Set(["completed", "error", "cancelled"]);

/**
 * 权限请求默认超时：pending 超时后迁移 expired（CAS）。
 * 单一真相：聚合层（permission_requested 投影 expiresAt）与超时定时器
 * （session-channel / doc-manager）必须一致，否则定时器按一个超时、投影按
 * 另一个超时，前端倒计时与后端失效时刻漂移。
 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
