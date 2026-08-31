// packages/chat-channel/src/types.ts
import type * as Y from "yjs";
import type { NormalizedEvent, QuestionProjection, SessionDocStatus } from "./schema";

// ── Session 级别状态 ──

/**
 * 前端展示状态（由后端聚合层在 setActiveTurn 投影到 Session Doc 的 session.presenting
 * 平铺键，前端只读该投影字段，不再自行从 activeTurnStatus 派生，见
 * web/src/hooks/use-session-state.ts）。旧扁平 10 态枚举（thinking/tool-calling/ready/plan
 * 等）已随 Turn 状态机删除，此类型只保留映射表实际产出的展示值。
 */
export type SessionStatus = "idle" | "loading" | "responding" | "replaying" | "waiting-user" | "done" | "error";

export interface LoadingState {
  kind: "session/bootstrap" | "session/respond" | "tool/executing" | "permission/pending";
  label?: string;
  since: number;
}

// ── Chat 级别状态 ──

export interface SessionSummary {
  sessionId: string;
  title: string;
  preview: string;
  status: "idle" | "active" | "done";
  lastMsgTs: number;
  cwd?: string;
  updatedAt?: string;
}

export interface PermissionRequest {
  id: string;
  tool: string;
  args: unknown;
  level: "ask";
  status: "pending" | "approved" | "denied";
  ts: number;
  /** 可用选项（统一面板透传给 PermissionPanel；行内按钮路径见 use-session-state 的 permissionOptions 合并） */
  options: PermissionOption[];
}

// ── Doc 包装类型 ──

export interface ChatDoc {
  ydoc: Y.Doc;
  generation: string;
  provider: RedisProvider;
  /** 隐藏候选投影在 generation CAS 成功后才激活 Redis provider。 */
  activateProvider(): void;
  destroy(): Promise<void>;
}

export interface SessionDoc {
  ydoc: Y.Doc;
  generation: string;
  provider: RedisProvider;
  /** 隐藏候选投影在 generation CAS 成功后才激活 Redis provider。 */
  activateProvider(): void;
  destroy(): Promise<void>;
}

/** 同一 ACP 会话投影的 Chat/Session 原子世代。 */
export interface ProjectionDocs {
  rcsSessionId: string;
  generation: string;
  targetAcpSessionId: string | null;
  chat: ChatDoc;
  session: SessionDoc;
}

export type ProjectionRollback = () => Promise<void> | void;

/** 激活步骤必须在产生副作用前登记补偿；DocManager 在失败时按逆序执行。 */
export type RegisterProjectionRollback = (rollback: ProjectionRollback) => void;

export interface ProjectionCommitHooks {
  /** 在候选仍不可见、provider 与广播监听器均未激活时投影的过渡期事件。 */
  stagedEvents?: readonly NormalizedEvent[];
  /** 候选成为内存权威后执行可逆的 binding/listener/publication 激活。 */
  activate?: (registerRollback: RegisterProjectionRollback) => void;
}

/**
 * 隐藏候选投影换代事务。prepare 不改变活动 Doc 或 Redis generation；commit 仅在
 * isCurrent 仍成立时发布并激活候选，rollback 只销毁自己的候选。
 */
export interface ProjectionReplacement {
  readonly projection: ProjectionDocs;
  readonly previousProjection: ProjectionDocs | null;
  /**
   * 原子提交候选。stagedEvents 只修改隐藏候选；activate 的每个外部副作用都必须预先登记
   * 补偿，commit 后续失败或 owner 丢失时由 DocManager 逆序恢复。
   */
  commit(isCurrent: () => boolean, hooks?: ProjectionCommitHooks): Promise<boolean>;
  rollback(): Promise<boolean>;
}

// ── Redis Provider 接口 ──

export interface RedisProvider {
  destroy(): Promise<void>;
}

// ── Agent Capabilities / Model / Mode 类型（acp-server 本地定义，不依赖 @fenix/acp-link）──

export interface CapabilitiesInfo {
  [key: string]: unknown;
  promptCapabilities?: { image?: boolean; embeddedContext?: boolean; [key: string]: unknown };
  sessionCapabilities?: Record<string, unknown>;
  mcpCapabilities?: Record<string, unknown>;
  loadSession?: boolean;
}

export interface ModelState {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string }>;
}

export interface ModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description?: string | null }>;
}

// ── React Hook 消费类型 ──

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
  availableCommands: Array<{ name: string; description: string; input?: { hint: string } }>;
  /**
   * agent 会话列表是否已权威确认（session_list 响应投影过）。
   * false = 列表尚未到达，此时空列表不代表"无会话"（bootstrap 不得据空列表自动创建，
   * 否则有历史会话时制造"假空"会话）；true = 列表已确认，空列表可安全触发自动创建。
   */
  sessionListLoaded: boolean;
  /** ACP prompt_complete 返回的真实 token 用量 */
  tokenUsage: TokenUsage | null;
}

/** prompt_complete 返回的 Token 用量 */
export interface TokenUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface SessionStateSnapshot {
  /** 当前快照所属的 ACP Session ID，用于在会话切换时识别和丢弃过期状态 */
  acpSessionId: string;
  /**
   * 会话文档级状态（Session Doc session.status，create/load 成功后投影为 "ready"）。
   * 与 status（turn 展示态）正交：会话就绪判定（输入框可用性）必须依赖此字段，
   * 而非 turn 状态——无活动 turn 时 turnStatus 恒为 null，用它判定会产生
   * "新会话永远无法发消息"的死锁。
   */
  sessionStatus: SessionDocStatus | null;
  /**
   * 展示态（后端投影字段 session.presenting 直接读取，前端零派生）。
   * 回放 turn（turn_replay_*，load/resume 历史回放）投影为 "replaying"：
   * 静态历史回显，不触发 loading 指示与停止按钮。
   */
  status: SessionStatus;
  /**
   * 展示态（后端投影字段 session.loading 直接读取）：accepting/running/cancelling 期间
   * 非空 { kind: "session/respond", since }，回放 turn 与 idle/终态为 null。
   */
  loading: LoadingState | null;
  /**
   * 展示态（后端投影字段 session.canCancel 直接读取）：accepting/running/awaiting_permission
   * 期间为 true（输出中停止按钮保持可用），回放 turn 与 idle/终态为 false。
   */
  canCancel: boolean;
  // 注：历史派生字段 messages/streaming/tools/artifacts 已删除（SP-B2 死字段）：
  // 前端唯一消费方是 structuredMessages（ChatInterface 时间线渲染），上述四个
  // 字段全仓零消费且每次流式批次都触发全量派生计算（根因 B2）。
  structuredMessages: StructuredMessage[];
  /**
   * AskUserQuestion 待应答问题投影（questionId → 投影）。
   * 后端聚合层写入 Session Doc root.pendingQuestions（60s expiresAt），
   * 前端只读：pending 过滤 + expiresAt 未过（双保险：后端超时定时器 CAS 迁移
   * 与前端本地剔除都按同一 expiresAt，任何一侧失效面板都不会悬挂）。
   */
  pendingQuestions: Map<string, QuestionProjection>;
  /**
   * Agent 运行时错误（后端 agent.publicError 投影而来，如启动失败/崩溃）。
   * 未发生错误时为空；展示层可在会话顶部呈现。
   */
  agentPublicError?: PublicErrorInfo | null;
}

// ── Structured Messages (Yjs timeline types, Phase C) ──

export type AssistantChunk = { type: "thought"; text: string } | { type: "message"; text: string };

export interface ToolCallContentBlock {
  type: "content" | "diff" | "terminal";
  content?: { type: string; text?: string };
  path?: string;
  oldText?: string;
  newText?: string;
  terminalId?: string;
}

export interface ToolCallDisplayData {
  type: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  totalLines?: number;
  text?: string;
  truncated?: boolean;
}

// 权限选项类型统一为 acp-link 协议定义（kind/label/hint），
// 避免与 Chat 域 schema 权限投影（"allow_once"|"allow_session"|"deny"）混淆。
import type { PermissionOption } from "acp-link/client";

export type { PermissionOption };

/** 展示层公开错误与 Chat Doc 使用同一 DTO；ViewModel 只透明复制字段。 */
export type PublicErrorInfo = import("./public-error").PublicError;

export interface ToolCallMessage {
  type: "tool_call";
  id: string;
  title: string;
  status: "running" | "complete" | "error" | "waiting_for_confirmation" | "canceled" | "rejected";
  content: ToolCallContentBlock[];
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  display?: ToolCallDisplayData;
  permissionRequest?: { requestId: string; options: PermissionOption[] };
  isStandalonePermission?: boolean;
  subMessages?: StructuredMessage[];
  /** 工具执行失败的脱敏错误（后端 ToolCallProjection.publicError 投影而来） */
  publicError?: PublicErrorInfo;
}

export interface AssistantMessage {
  type: "assistant_message";
  id: string;
  chunks: AssistantChunk[];
  seq: number;
  ts: number;
  /** 本 turn 失败的脱敏错误（后端 ChatEntry.error 投影而来，挂在最后一段助手消息） */
  error?: PublicErrorInfo;
}

export interface UserMessage {
  type: "user_message";
  id: string;
  content: string;
  seq: number;
  ts: number;
}

export type PlanEntryPriority = "high" | "medium" | "low";
export type PlanEntryStatus = "pending" | "in_progress" | "completed";

export interface PlanEntryData {
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
}

export interface PlanMessage {
  type: "plan";
  id: string;
  /** 计划所属 turn；同一 turn 的计划更新在展示层只保留最新快照。 */
  turnId?: string | null;
  entries: PlanEntryData[];
}

export type StructuredMessage = AssistantMessage | UserMessage | ToolCallMessage | PlanMessage;
