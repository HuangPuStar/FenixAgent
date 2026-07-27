// packages/acp-server/src/types.ts
import type * as Y from "yjs";

// ── ACP 事件（来自 relay 消息流）──

export interface ACPEvent {
  type: string;
  payload?: Record<string, unknown>;
  sessionId?: string;
}

// ── Session 级别状态 ──

export type SessionStatus =
  | "idle"
  | "loading"
  | "thinking"
  | "responding"
  | "tool-calling"
  | "waiting-user"
  | "error"
  | "done";

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

export interface ConnectionStatus {
  status: "disconnected" | "connecting" | "connected";
  since: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  avatar?: string;
  model?: { id: string; name: string };
}

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
  agentInfo: AgentInfo;
  sessions: SessionSummary[];
  activeSessionId: string;
  connection: ConnectionStatus;
  permissions: PermissionRequest[];
  isSwitchingSession: boolean;
  /** 从 agent status 消息获取的 Agent 能力集 */
  capabilities: CapabilitiesInfo | null;
  /** 当前 Session 的 Model 状态（来自 session/new 或 session/load 响应） */
  modelState: ModelState | null;
  /** 当前 Session 的 Mode 状态 */
  modeState: ModeState | null;
  /** 可用命令列表 */
  availableCommands: Array<{ name: string; description: string }>;
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
  status: SessionStatus;
  loading: LoadingState | null;
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

export interface PermissionOption {
  optionId: string;
  label: string;
}

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
