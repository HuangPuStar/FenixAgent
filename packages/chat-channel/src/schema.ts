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

import type { PublicError } from "./public-error";

export type { PublicError, PublicErrorType } from "./public-error";

// ── 版本 ──

/** Chat Doc 结构版本（schemaVersion，描述结构而非投影进度） */
export const CHAT_DOC_SCHEMA_VERSION = 2;
/**
 * Session Doc 结构版本。3：新增根级 sessions 投影位（agent 级会话列表）；
 * 4：新增根级 tasks / taskOrder 投影位（Peri Subagent / Background Task 轻量视图）。
 * loadSessionDoc 会幂等补齐旧快照缺失的 subtree；YJS 并发键冲突可能使
 * schemaVersion 暂时保留旧值，因此结构存在性而非版本号才是运行时能力信号。
 */
export const SESSION_DOC_SCHEMA_VERSION = 4;
/** Chat Doc 初始投影版本（每次成功投影后 +1，见 bumpProjectionVersion） */
export const INITIAL_PROJECTION_VERSION = 1;

// ── Chat Doc schema（5.2）──

export type ChatEntryKind = "message" | "tool" | "system";
export type ChatEntryRole = "user" | "assistant" | "system";
export type ChatEntryStatus = "pending" | "streaming" | "completed" | "cancelled" | "error";

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
/** AskUserQuestion 交互问题的生命周期状态（与 PermissionStatus 平行：expired 由 60s 超时 CAS 迁移） */
export type QuestionStatus = "pending" | "resolved" | "expired";

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

/** AskUserQuestion 单个问题的选项投影（label 即回传答案，与 acp-link handleControlResponse 对齐） */
export interface QuestionOptionProjection {
  label: string;
  description: string | null;
}

/** AskUserQuestion 单个问题投影（来自 acp-link interactive_question 帧的 questions[] 元素） */
export interface QuestionItemProjection {
  question: string;
  header: string | null;
  options: QuestionOptionProjection[];
}

/**
 * AskUserQuestion 交互问题投影（Session Doc 根 map pendingQuestions，按 questionId 键控）。
 * 生命周期：question_requested → pending（60s expiresAt）→ 用户回传 respondQuestion CAS
 * → resolved；超时定时器（控制面持有）→ expired。与 acp-link 侧 60s 自动空答案对齐。
 */
export interface QuestionProjection {
  questionId: string;
  status: QuestionStatus;
  questions: QuestionItemProjection[];
  description: string | null;
  expiresAt: string;
  /**
   * 决议结果：CAS 迁移成功后写入用户选择的选项 label（translator 以 outcome.optionId
   * 回传，acp-link 直接作为答案注入）；upsert 创建时为 null；expired 不写（保持 null）。
   */
  answer: string | null;
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
  | "question_requested"
  | "question_resolved"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancel_requested"
  | "turn_cancelled"
  | "turn_interrupted"
  | "plan"
  | "session_updated"
  | "agent_status"
  | "session_list"
  // Peri Task 生命周期（protocol/acp-channel.ts 从 peri/agent_event 与
  // peri/unstable_event 规范化而来，聚合层经 applyPeriTaskEvent 投影）
  | "peri_task_started"
  | "peri_task_completed"
  | "peri_task_cancelled";

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
  /** Peri 子 Agent 事件来源身份；存在时不得投影到主 Agent assistant entry。 */
  sourceAgentId?: string | null;
  turnId?: string | null;
  /** callback 流本地关联键，仅用于隔离无 turnId 的 Peri callback 历史输出。 */
  callbackEntryId?: string | null;
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

/**
 * AskUserQuestion 默认超时：pending 超时后迁移 expired（CAS）。
 * 与 acp-link 侧 60s 自动 resolve 空答案对齐（claude-acp-adapter.ts:469）：
 * 投影的 expiresAt 必须 ≤ 60s 且控制面定时器按同一值失效，否则 acp-link 已
 * 回空答案、agent 继续执行，前端弹窗仍悬挂 60s 以上。
 */
export const DEFAULT_QUESTION_TIMEOUT_MS = 60_000;

// ── Peri Task View schema（Session Doc root.tasks / root.taskOrder，切片 1）──
// Peri Subagent / Background Task 的轻量会话级投影。代码命名使用「Peri task」
// 前缀避免与既有 task-v2 定时任务域混淆；Y.Doc 内位于 Session Doc 私有 subtree，
// 可继续使用短键 tasks / taskOrder。
//
// 安全约束（规格 §二.2）：明确禁止进入 Y.Doc 的数据——event_json、完整 Subagent
// result、完整 output/log、locator、raw cancellation reason、tool arguments/result、
// stack/path/URL/token/env、descriptor。summary 只允许有界截断的脱敏文本。

export type PeriTaskKind = "subagent" | "background";
export type PeriTaskStatus = "running" | "completed" | "failed" | "cancelled";
export type PeriTaskDetailAvailability = "preview" | "unavailable" | "expired";
export type PeriTaskSubtype = "agent" | "shell" | "workflow" | null;

/**
 * Task View 投影（物理结构为 Session Doc root.tasks 下按 taskId 键控的 Y.Map）。
 * 排序不在 Doc 层：taskOrder 仅在首次创建时 append，更新不重排（避免 Y.Array
 * 高频冲突）；前端派生排序为「非终态在前 → updatedAt 降序 → taskOrder 稳定」。
 */
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

/**
 * Peri 通知 wire method。权威名称为下划线版本 `peri/unstable_event`
 * （Peri 发射：peri-acp event_sink.rs push_unstable_event），不是计划中的
 * `peri/unstable-event`——实现、fixture、日志与测试一律使用下划线版本。
 */
export const PERI_AGENT_EVENT_METHOD = "peri/agent_event";
export const PERI_UNSTABLE_EVENT_METHOD = "peri/unstable_event";

/** initialize clientCapabilities._meta 中的 capability key（PeriCaps::from_client_meta 解析键） */
export const PERI_AGENT_EVENT_CAPABILITY = "peri.agentEvent";
export const PERI_UNSTABLE_EVENT_CAPABILITY = "peri.unstableEvent";

/** peri/agent_event 的 event_json（AcpEvent DTO，serde tag/content 结构）只接收的 event type */
export const PERI_AGENT_EVENT_TYPES: ReadonlySet<string> = new Set(["subagent_started", "subagent_stopped"]);
/** peri/unstable_event 只接收的 event 名 */
export const PERI_UNSTABLE_EVENT_NAMES: ReadonlySet<string> = new Set([
  "bg-task-started",
  "bg-task-completed",
  "bg-task-cancelled",
]);
/** bg-task-* 的 kind allowlist（BgTaskKind snake_case） */
export const PERI_TASK_SUBTYPE_ALLOWLIST: ReadonlySet<string> = new Set(["shell", "agent", "workflow"]);

/** 规范化 Task 事件类型集合（DocManager 分支使用） */
export const PERI_TASK_EVENT_TYPES: ReadonlySet<NormalizedEventType> = new Set([
  "peri_task_started",
  "peri_task_completed",
  "peri_task_cancelled",
]);

/**
 * 携带 params.sessionId 的 session-bound notification method 集合。
 * relay binding 校验（relay-event-handler）统一检查这些 method：与 active ACP
 * session 不一致时丢弃，防止旧 session 的 Peri 事件写入当前 rcsSessionId。
 */
export const SESSION_BOUND_NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
  "session/update",
  PERI_AGENT_EVENT_METHOD,
  PERI_UNSTABLE_EVENT_METHOD,
]);

/** Session Doc 中保留的 Task View 上限，防止快照与首帧同步无界增长。 */
export const PERI_TASK_VIEW_MAX = 200;
/** Task title 上限（code point 数） */
export const PERI_TASK_TITLE_MAX = 120;
/** Task summary 上限（code point 数） */
export const PERI_TASK_SUMMARY_MAX = 500;
/** background started 的 title 安全 fallback（summary 缺失/为空时） */
export const PERI_TASK_FALLBACK_TITLE = "Background task";

/**
 * UTF-8 安全截断：按 code point 截断，不切断多字节字符。
 * 字符串可能来自 Peri result/output_preview（外部输入不可信），长度必须在此收敛。
 */
export function truncateUtf8Safe(value: string, max: number): string {
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max).join("");
}

/**
 * Peri Task 规范化事件（规格 §二.1）：不再把 Task 字段塞进通用 update 载荷，
 * 使用 discriminated union 携带扁平身份字段。它是 NormalizedEvent 的 subtype
 * （保留 update/content/acpSessionId/turnId 以便穿透现有 relay pipeline），
 * 聚合层 switch 后经最小范围类型收窄读取扁平字段。
 */
export type NormalizedPeriTaskEvent =
  | (NormalizedEvent & {
      type: "peri_task_started";
      taskId: string;
      kind: PeriTaskKind;
      taskSubtype: PeriTaskSubtype;
      title: string;
      summary: string | null;
      sourceStartedAt: string | null;
      receivedAt: string;
      isBackground: boolean;
      detailAvailability: "preview" | "unavailable";
    })
  | (NormalizedEvent & {
      type: "peri_task_completed";
      taskId: string;
      kind: PeriTaskKind;
      success: boolean;
      summary: string | null;
      durationMs: number | null;
      receivedAt: string;
      detailAvailability: "preview" | "unavailable";
    })
  | (NormalizedEvent & {
      type: "peri_task_cancelled";
      taskId: string;
      kind: "background";
      reasonCode: "cancelled";
      receivedAt: string;
      detailAvailability: "unavailable";
    });
