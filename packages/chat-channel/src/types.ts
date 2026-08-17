// packages/chat-channel/src/types.ts
import type * as Y from "yjs";
import type { SessionDocStatus } from "./schema";

/** ACP 事件应用选项（聚合层状态变更的附加控制） */
export interface ACPApplyOptions {
  /**
   * 抑制 user_message_chunk 的 loading 设置。session/load 历史回放窗口内为 true：
   * 回放的历史用户消息是数据重建，不是新的 turn，不应触发 loading（否则切换会话
   * 后 loading 残留、刷新恢复时覆盖真实进行中的 loading）。
   */
  suppressLoading?: boolean;
}

// ── Session 级别状态 ──

/**
 * 前端展示状态（派生自 Session Doc 的 session.activeTurnStatus 平铺键，见 web/src/hooks/use-session-state.ts）。
 * 旧扁平 10 态枚举（thinking/tool-calling/ready/plan 等）已随 Turn 状态机删除，
 * 此类型只保留映射表实际产出的展示值，不再承载执行状态。
 */
export type SessionStatus = "idle" | "loading" | "responding" | "waiting-user" | "done" | "error";

export interface LoadingState {
  kind: "session/bootstrap" | "session/respond" | "tool/executing" | "permission/pending";
  label?: string;
  since: number;
}

export interface ToolRun {
  name: string;
  status: "running" | "done" | "error";
  input: unknown;
  output?: unknown;
  startedAt: number;
}

export interface ArtifactRef {
  kind: "file" | "image" | "url";
  url: string;
  title: string;
  seq: number;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  seq: number;
  ts: number;
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
  provider: RedisProvider;
  destroy(): Promise<void>;
}

export interface SessionDoc {
  ydoc: Y.Doc;
  provider: RedisProvider;
  destroy(): Promise<void>;
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
  status: SessionStatus;
  loading: LoadingState | null;
  /** turn 处于可中断状态（accepting/running/awaiting_permission）——仅驱动停止按钮；
   *  running 正文流式输出期间 loading 保持非空（session/respond），输出中指示器不消失，
   *  停止按钮同样可用，与 loading 正交。历史回放 turn（turn_replay_*，load/resume 投影）
   *  视为静态历史：loading 与 canCancel 均不派生（回放期间无伪"输出中"指示与停止按钮） */
  canCancel: boolean;
  messages: SessionMessage[];
  structuredMessages: StructuredMessage[];
  streaming: { text: string; reasoning: string } | null;
  tools: Map<string, ToolRun>;
  artifacts: ArtifactRef[];
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
}

export interface AssistantMessage {
  type: "assistant_message";
  id: string;
  chunks: AssistantChunk[];
  seq: number;
  ts: number;
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
  entries: PlanEntryData[];
}

export type StructuredMessage = AssistantMessage | UserMessage | ToolCallMessage | PlanMessage;
