/**
 * Chat 类型契约的内部实现：Chat / Session 快照与投影类型。
 *
 * 仅供 `../types.ts` re-export，不属于公开面（消费方一律从 `../types` 导入）。
 * 拆分原因：类型契约按职责分文件，避免单文件超过 500 行红线。
 *
 * 来源：`@fenix/chat-channel`（`src/types.ts` / `src/schema.ts` / `src/public-error.ts`）。
 * 纯化改动点：
 * - 不 import 任何 `@fenix/*` 依赖，全部逐字内联；`PublicErrorType` 由源的常量数组内联为其取值集合。
 * - 源 `ToolCallContentBlock`（Yjs 时间线版）与 acp-link 协议同名，此处重命名为
 *   `StructuredToolCallContentBlock`，字段未改。
 */

import type { AvailableCommand, PermissionOption, PlanEntryData } from "./types-acp-protocol";
import type { AssistantChunk } from "./types-chat-model";

// =============================================================================
// 公开错误 DTO（源：packages/chat-channel/src/public-error.ts）
// =============================================================================

/** 公开错误类型注册表（逐字内联源的 `PUBLIC_ERROR_TYPES` 取值集合）。 */
export type PublicErrorType =
  | "AGENT_RUNTIME.REQUEST_FAILED"
  | "AGENT_RUNTIME.SESSION_FAILED"
  | "AGENT_RUNTIME.PROMPT_REJECTED"
  | "AGENT_RUNTIME.PROMPT_TIMEOUT"
  | "AGENT_RUNTIME.LLM_API_ERROR"
  | "AGENT_RUNTIME.LLM_API_CONFIGURATION_ERROR"
  | "AGENT_RUNTIME.LLM_API_RATE_LIMITED"
  | "AGENT_RUNTIME.DISCONNECTED"
  | "SYNC_RELAY.CONNECTION_LOST"
  | "SYNC_RELAY.CAPACITY_EXCEEDED"
  | "SYNC_RELAY.KEEPALIVE_TIMEOUT"
  | "SYNC_RELAY.SYNC_FAILED"
  | "CONTROL_PLANE.ENVIRONMENT_UNAVAILABLE"
  | "CONTROL_PLANE.MACHINE_UNAVAILABLE"
  | "CONTROL_PLANE.INSTANCE_RECLAIMED"
  | "CONTROL_PLANE.INSTANCE_START_FAILED"
  | "CONTROL_PLANE.INSTANCE_LIMIT_REACHED"
  | "CONTROL_PLANE.CONFIGURATION_INVALID"
  | "ACTION.UNAUTHENTICATED"
  | "ACTION.FORBIDDEN"
  | "ACTION.SESSION_NOT_FOUND"
  | "ACTION.VERSION_CONFLICT"
  | "ACTION.INVALID_STATE"
  | "ACTION.RATE_LIMITED"
  | "ACTION.PAYLOAD_TOO_LARGE"
  | "ACTION.AGENT_UNAVAILABLE"
  | "ACTION.FAILED"
  | "INTERNAL.UNCLASSIFIED";

/** 展示层公开错误（稳定类型 + 诊断 id + 安全摘要）。复制自 `packages/chat-channel/src/public-error.ts`。 */
export interface PublicError {
  /** 稳定、有限、下游不得改写的公开错误类型。 */
  type: PublicErrorType;
  /** 至少包含 128 bit CSPRNG 随机性的公开诊断标识。 */
  id: string;
  /** 由错误注册表产生的安全摘要，不得使用原始异常文本。 */
  message: string;
}

/** 前端展示直接使用公开错误 DTO，不重新分类。复制自 `apps/web/src/lib/types.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）。 */
export type PublicErrorInfo = PublicError;

// =============================================================================
// Chat / Session 快照（源：@fenix/chat-channel 的 src/types.ts）
// =============================================================================

/** 前端展示状态（由后端聚合层投影）。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export type SessionStatus = "idle" | "loading" | "responding" | "replaying" | "waiting-user" | "done" | "error";

/** 会话/工具加载指示状态。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface LoadingState {
  kind: "session/bootstrap" | "session/respond" | "tool/executing" | "permission/pending";
  label?: string;
  since: number;
}

/** 会话摘要（Chat 级会话列表条目）。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface SessionSummary {
  sessionId: string;
  title: string;
  preview: string;
  status: "idle" | "active" | "done";
  lastMsgTs: number;
  cwd?: string;
  updatedAt?: string;
}

/** 权限请求（Session Doc 投影，含可用选项）。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface PermissionRequest {
  id: string;
  tool: string;
  args: unknown;
  level: "ask";
  status: "pending" | "approved" | "denied";
  ts: number;
  /** 可用选项（统一面板透传给权限面板） */
  options: PermissionOption[];
}

/** Agent 能力集（agent status 消息投影）。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface CapabilitiesInfo {
  [key: string]: unknown;
  promptCapabilities?: { image?: boolean; embeddedContext?: boolean; [key: string]: unknown };
  sessionCapabilities?: Record<string, unknown>;
  mcpCapabilities?: Record<string, unknown>;
  loadSession?: boolean;
}

/** 当前 Session 的 Model 状态。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface ModelState {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string }>;
}

/** 当前 Session 的 Mode 状态。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface ModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string | null }>;
}

/** ACP 报告的当前上下文用量与窗口容量。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface TokenUsage {
  /** 最近一次模型请求时的上下文占用。 */
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** 当前模型上下文窗口容量（ACP usage_update.size）。 */
  contextWindow?: number;
}

/** Chat Doc 级状态快照（Chat 面板只读消费）。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface ChatStateSnapshot {
  sessions: SessionSummary[];
  activeSessionId: string;
  permissions: PermissionRequest[];
  /** 从 agent status 消息获取的 Agent 能力集 */
  capabilities: CapabilitiesInfo | null;
  /** 当前 Session 的 Model 状态（来自 session/new 或 session/load 响应） */
  modelState: ModelState | null;
  /** 当前 Session 的 Mode 状态 */
  modeState: ModeState | null;
  /** 可用命令列表（available_commands_update 投影到 Session Doc，slash 命令菜单数据源） */
  availableCommands: AvailableCommand[];
  /**
   * agent 会话列表是否已权威确认（session_list 响应投影过）。
   * false = 列表尚未到达，此时空列表不代表"无会话"；true = 列表已确认。
   */
  sessionListLoaded: boolean;
  /** ACP usage_update 或 prompt_complete 返回的当前上下文用量 */
  tokenUsage: TokenUsage | null;
}

/** 会话文档级状态。复制自 `@fenix/chat-channel`（`src/schema.ts`）。 */
export type SessionDocStatus = "initializing" | "ready" | "running" | "degraded" | "closed";

// =============================================================================
// AskUserQuestion 投影（源：@fenix/chat-channel 的 src/schema.ts）
// =============================================================================

/** 交互问题的生命周期状态（60s 超时 CAS 迁移）。复制自 `@fenix/chat-channel`（`src/schema.ts`）。 */
export type QuestionStatus = "pending" | "resolved" | "expired";

/** AskUserQuestion 单个问题的选项投影。复制自 `@fenix/chat-channel`（`src/schema.ts`）。 */
export interface QuestionOptionProjection {
  label: string;
  description: string | null;
}

/** AskUserQuestion 单个问题的答案；多选题保留数组。复制自 `@fenix/chat-channel`（`src/schema.ts`）。 */
export type QuestionAnswer = string | string[];

/** AskUserQuestion 单个问题投影。复制自 `@fenix/chat-channel`（`src/schema.ts`）。 */
export interface QuestionItemProjection {
  question: string;
  header: string | null;
  options: QuestionOptionProjection[];
  multiSelect: boolean;
}

/** AskUserQuestion 交互问题投影（Session Doc 根 pendingQuestions）。复制自 `@fenix/chat-channel`（`src/schema.ts`）。 */
export interface QuestionProjection {
  questionId: string;
  status: QuestionStatus;
  questions: QuestionItemProjection[];
  description: string | null;
  expiresAt: string;
  /** 决议结果：按问题顺序排列的答案（单选 string，多选 string[]）的 JSON 序列化；未决时为 null。 */
  answer: string | null;
}

// =============================================================================
// Peri 任务投影（源：@fenix/chat-channel 的 src/schema.ts）
// =============================================================================

/** Peri 子任务/后台任务种类。复制自 `@fenix/chat-channel`（`src/schema.ts`）。 */
export type PeriTaskKind = "subagent" | "background";

/** Peri 任务状态。复制自 `@fenix/chat-channel`（`src/schema.ts`）。 */
export type PeriTaskStatus = "running" | "completed" | "failed" | "cancelled";

/** Peri 任务详情可用性。复制自 `@fenix/chat-channel`（`src/schema.ts`）。 */
export type PeriTaskDetailAvailability = "preview" | "unavailable" | "expired";

/** Peri 任务来源子类型。复制自 `@fenix/chat-channel`（`src/schema.ts`）。 */
export type PeriTaskSubtype = "agent" | "shell" | "workflow" | null;

/** Task View 投影（Session Doc root.tasks）。复制自 `@fenix/chat-channel`（`src/schema.ts`）。 */
export interface PeriTaskViewProjection {
  taskId: string;
  kind: PeriTaskKind;
  taskSubtype: PeriTaskSubtype;
  title: string;
  summary: string | null;
  status: PeriTaskStatus;
  /** relay 到达时附加的当前 turn；非身份字段（首次创建记录，后续不覆盖） */
  turnId: string | null;
  isBackground: boolean;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  detailAvailability: PeriTaskDetailAvailability;
}

// =============================================================================
// 结构化消息（源：@fenix/chat-channel 的 src/types.ts）
// =============================================================================

/**
 * 工具调用内容块（Yjs 时间线投影版）。
 * 复制自 `@fenix/chat-channel`（`src/types.ts`）；纯化改动：源名与 acp-link 协议
 * `ToolCallContentBlock` 冲突，此处重命名为 `StructuredToolCallContentBlock`，字段未改。
 */
export interface StructuredToolCallContentBlock {
  type: "content" | "diff" | "terminal";
  content?: { type: string; text?: string };
  path?: string;
  oldText?: string;
  newText?: string;
  terminalId?: string;
}

/**
 * 工具调用 display 元数据（Yjs 时间线投影版）。
 * 复制自 `@fenix/chat-channel`（`src/types.ts`）；与 `ToolCallDisplay` 结构一致，两个源各有一份，均予保留。
 */
export interface ToolCallDisplayData {
  type: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  totalLines?: number;
  text?: string;
  truncated?: boolean;
}

/** 工具调用结构化消息。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface ToolCallMessage {
  type: "tool_call";
  id: string;
  title: string;
  status: "running" | "complete" | "error" | "waiting_for_confirmation" | "canceled" | "rejected";
  content: StructuredToolCallContentBlock[];
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  display?: ToolCallDisplayData;
  permissionRequest?: { requestId: string; options: PermissionOption[] };
  isStandalonePermission?: boolean;
  subMessages?: StructuredMessage[];
  /** 工具执行失败的脱敏错误（后端 ToolCallProjection.publicError 投影而来） */
  publicError?: PublicErrorInfo;
}

/** 助手结构化消息。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface AssistantMessage {
  type: "assistant_message";
  id: string;
  chunks: AssistantChunk[];
  seq: number;
  ts: number;
  /** 本 turn 失败的脱敏错误（后端 ChatEntry.error 投影而来，挂在最后一段助手消息） */
  error?: PublicErrorInfo;
}

/** 用户结构化消息。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface UserMessage {
  type: "user_message";
  id: string;
  content: string;
  seq: number;
  ts: number;
}

/** 计划结构化消息。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface PlanMessage {
  type: "plan";
  id: string;
  /** 计划所属 turn；同一 turn 的计划更新在展示层只保留最新快照。 */
  turnId?: string | null;
  entries: PlanEntryData[];
}

/** 时间线结构化消息联合，对应 `SessionStateSnapshot.structuredMessages`。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export type StructuredMessage = AssistantMessage | UserMessage | ToolCallMessage | PlanMessage;

// =============================================================================
// Session Doc 级状态快照（源：@fenix/chat-channel 的 src/types.ts）
// =============================================================================

/** Session Doc 级状态快照（时间线渲染输入）。复制自 `@fenix/chat-channel`（`src/types.ts`）。 */
export interface SessionStateSnapshot {
  /** 当前快照所属的 ACP Session ID，用于在会话切换时识别和丢弃过期状态 */
  acpSessionId: string;
  /**
   * 会话文档级状态（Session Doc session.status，create/load 成功后投影为 "ready"）。
   * 与 status（turn 展示态）正交：输入框可用性判定必须依赖此字段。
   */
  sessionStatus: SessionDocStatus | null;
  /** 展示态（后端投影字段 session.presenting 直接读取，前端零派生）。 */
  status: SessionStatus;
  /** 展示态（后端投影字段 session.loading 直接读取）。 */
  loading: LoadingState | null;
  /** 展示态（后端投影字段 session.canCancel 直接读取）：输出中停止按钮保持可用。 */
  canCancel: boolean;
  /** 时间线消息（ChatInterface 渲染输入）。 */
  structuredMessages: StructuredMessage[];
  /** AskUserQuestion 待应答问题投影（questionId → 投影，60s expiresAt）。 */
  pendingQuestions: Map<string, QuestionProjection>;
  /** Agent 运行时错误（后端 agent.publicError 投影而来）。 */
  agentPublicError?: PublicErrorInfo | null;
}
