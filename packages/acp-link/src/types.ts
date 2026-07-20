// ============================================================================
// Permission Types
// ============================================================================

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface PermissionRequestPayload {
  requestId: string;
  sessionId: string;
  options: PermissionOption[];
  toolCall: {
    toolCallId: string;
    title?: string;
    content?: ToolCallContent[];
  };
}

export interface InteractiveQuestionPayload {
  sessionId: string;
  questionId: string;
  toolId: string;
  toolName: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
  description: string;
}

export interface PermissionResponsePayload {
  requestId: string;
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
}

// ============================================================================
// Browser Tool Types
// ============================================================================

export interface BrowserToolParams {
  action: "tabs" | "read" | "execute";
  tabId?: number;
  script?: string;
}

export interface BrowserTabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserTabsResult {
  action: "tabs";
  tabs: BrowserTabInfo[];
}

export interface BrowserReadResult {
  action: "read";
  tabId: number;
  url: string;
  title: string;
  dom: string;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  selection: string | null;
}

export interface BrowserExecuteResult {
  action: "execute";
  tabId: number;
  url: string;
  result?: unknown;
  error?: string;
}

export type BrowserToolResult = BrowserTabsResult | BrowserReadResult | BrowserExecuteResult;

// ============================================================================
// Proxy Messages (Client → Server)
// ============================================================================

export type ProxyMessage =
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "new_session"; payload?: { cwd?: string; permissionMode?: string } }
  | { type: "prompt"; payload: { content: ContentBlock[] } }
  | { type: "cancel" }
  | { type: "permission_response"; payload: PermissionResponsePayload }
  | { type: "browser_tool_result"; callId: string; result: BrowserToolResult | { error: string } }
  | { type: "set_session_model"; payload: { modelId: string } }
  | { type: "set_session_mode"; payload: { modeId: string } }
  | { type: "list_sessions"; payload?: ListSessionsRequest }
  | { type: "load_session"; payload: LoadSessionRequest }
  | { type: "resume_session"; payload: ResumeSessionRequest }
  | { type: "delete_session"; payload: DeleteSessionRequest }
  | { type: "rename_session"; payload: RenameSessionRequest }
  | { type: "ping" };

// ============================================================================
// Proxy Response Messages (Server → Client)
// ============================================================================

export interface ProxyStatusMessage {
  type: "status";
  payload: {
    connected: boolean;
    agentInfo?: { name?: string; version?: string };
    capabilities?: AgentCapabilities;
  };
}

export interface ProxyErrorMessage {
  type: "error";
  payload: { message: string };
}

export interface ProxySessionCreatedMessage {
  type: "session_created";
  payload: {
    sessionId: string;
    promptCapabilities?: PromptCapabilities;
    models?: SessionModelState | null;
    modes?: SessionModeState | null;
  };
}

export interface ProxySessionUpdateMessage {
  type: "session_update";
  payload: {
    sessionId: string;
    update: SessionUpdate;
  };
}

export interface PromptUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ProxyPromptCompleteMessage {
  type: "prompt_complete";
  payload: {
    stopReason: string;
    usage?: PromptUsage;
  };
}

export interface ProxyPermissionRequestMessage {
  type: "permission_request";
  payload: PermissionRequestPayload;
}

export interface ProxyBrowserToolCallMessage {
  type: "browser_tool_call";
  callId: string;
  params: BrowserToolParams;
}

export interface ProxyPongMessage {
  type: "pong";
}

export interface ProxyModelChangedMessage {
  type: "model_changed";
  payload: {
    modelId: string;
  };
}

export interface ProxySessionListMessage {
  type: "session_list";
  payload: ListSessionsResponse;
}

export interface ProxySessionLoadedMessage {
  type: "session_loaded";
  payload: {
    sessionId: string;
    promptCapabilities?: PromptCapabilities;
    models?: SessionModelState | null;
    modes?: SessionModeState | null;
  };
}

export interface ProxySessionResumedMessage {
  type: "session_resumed";
  payload: {
    sessionId: string;
    promptCapabilities?: PromptCapabilities;
    models?: SessionModelState | null;
    modes?: SessionModeState | null;
  };
}

export interface ProxyModeChangedMessage {
  type: "mode_changed";
  payload: {
    modeId: string;
  };
}

export interface ProxySessionDeletedMessage {
  type: "session_deleted";
  payload: {
    sessionId: string;
  };
}

export interface ProxySessionRenamedMessage {
  type: "session_renamed";
  payload: {
    sessionId: string;
    title: string;
  };
}

export type ProxyResponse =
  | ProxyStatusMessage
  | ProxyErrorMessage
  | ProxySessionCreatedMessage
  | ProxySessionUpdateMessage
  | ProxyPromptCompleteMessage
  | ProxyPermissionRequestMessage
  | ProxyBrowserToolCallMessage
  | ProxyModelChangedMessage
  | ProxyModeChangedMessage
  | ProxyPongMessage
  | ProxySessionListMessage
  | ProxySessionLoadedMessage
  | ProxySessionResumedMessage
  | ProxySessionDeletedMessage
  | ProxySessionRenamedMessage;

// ============================================================================
// Content Block Types
// ============================================================================

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  mimeType: string;
  data: string;
  uri?: string;
}

export interface ResourceLinkContent {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export type ContentBlock = TextContent | ImageContent | ResourceLinkContent | { type: string; text?: string };

// ============================================================================
// Session Update Types
// ============================================================================

export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
  _meta?: Record<string, unknown> | null;
}

export interface ToolCallContentBlock {
  type: "content";
  content: ContentBlock;
}

export interface ToolCallDiffContent {
  type: "diff";
  path: string;
  oldText?: string | null;
  newText: string;
}

export interface ToolCallTerminalContent {
  type: "terminal";
  terminalId: string;
}

export type ToolCallContent = ToolCallContentBlock | ToolCallDiffContent | ToolCallTerminalContent;

export interface ToolCallUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  status: string;
  content?: ToolCallContent[];
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  kind?: string;
  _meta?: Record<string, unknown> | null;
}

export interface ToolCallStatusUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: string;
  title?: string;
  content?: ToolCallContent[];
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  _meta?: Record<string, unknown> | null;
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
  _meta?: Record<string, unknown> | null;
}

export type PlanEntryPriority = "high" | "medium" | "low";
export type PlanEntryStatus = "pending" | "in_progress" | "completed";

export interface PlanEntry {
  _meta?: Record<string, unknown> | null;
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
}

export interface PlanUpdate {
  sessionUpdate: "plan";
  _meta?: Record<string, unknown> | null;
  entries: PlanEntry[];
}

export interface UserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: AvailableCommand[];
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | ToolCallUpdate
  | ToolCallStatusUpdate
  | AgentThoughtChunkUpdate
  | PlanUpdate
  | UserMessageChunkUpdate
  | AvailableCommandsUpdate;

// ============================================================================
// Sub-Agent Helpers
// ============================================================================

/** 从 SessionUpdate 的 _meta 中提取 parentToolUseId（Claude Code 子 agent 关联） */
export function getParentToolUseId(update: SessionUpdate): string | undefined {
  const meta = "_meta" in update ? (update._meta as Record<string, unknown> | null | undefined) : undefined;
  if (!meta || typeof meta !== "object") return;
  const claudeCode = meta.claudeCode as Record<string, unknown> | undefined;
  if (!claudeCode || typeof claudeCode !== "object") return;
  const id = claudeCode.parentToolUseId;
  return typeof id === "string" ? id : undefined;
}

/** 从 SessionUpdate 的 _meta 中提取 Claude Code 子 agent 工具名 */
export function getSubAgentToolName(update: SessionUpdate): string | undefined {
  const meta = "_meta" in update ? (update._meta as Record<string, unknown> | null | undefined) : undefined;
  if (!meta || typeof meta !== "object") return;
  const claudeCode = meta.claudeCode as Record<string, unknown> | undefined;
  if (!claudeCode || typeof claudeCode !== "object") return;
  const name = claudeCode.toolName;
  return typeof name === "string" ? name : undefined;
}

// ============================================================================
// Connection State
// ============================================================================

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

// ============================================================================
// Capabilities Types
// ============================================================================

export interface PromptCapabilities {
  audio?: boolean;
  embeddedContext?: boolean;
  image?: boolean;
}

export interface McpCapabilities {
  clientServers?: boolean;
  _meta?: Record<string, unknown> | null;
}

export interface SessionListCapabilities {
  _meta?: Record<string, unknown> | null;
}

export interface SessionResumeCapabilities {
  _meta?: Record<string, unknown> | null;
}

export interface SessionForkCapabilities {
  _meta?: Record<string, unknown> | null;
}

export interface SessionDeleteCapabilities {
  _meta?: Record<string, unknown> | null;
}

export interface SessionRenameCapabilities {
  _meta?: Record<string, unknown> | null;
}

export interface SessionCapabilities {
  _meta?: Record<string, unknown> | null;
  fork?: SessionForkCapabilities | null;
  list?: SessionListCapabilities | null;
  resume?: SessionResumeCapabilities | null;
  delete?: SessionDeleteCapabilities | null;
  rename?: SessionRenameCapabilities | null;
}

export interface AgentCapabilities {
  [key: string]: unknown;
  _meta?: Record<string, unknown> | null;
  loadSession?: boolean;
  mcpCapabilities?: McpCapabilities;
  promptCapabilities?: PromptCapabilities;
  sessionCapabilities?: SessionCapabilities;
}

// ============================================================================
// Session History Types
// ============================================================================

export interface AgentSessionInfo {
  _meta?: Record<string, unknown> | null;
  cwd: string;
  sessionId: string;
  title?: string | null;
  updatedAt?: string | null;
}

export interface ListSessionsRequest {
  _meta?: Record<string, unknown> | null;
  cwd?: string;
  cursor?: string;
}

export interface ListSessionsResponse {
  _meta?: Record<string, unknown> | null;
  nextCursor?: string | null;
  sessions: AgentSessionInfo[];
}

export interface LoadSessionRequest {
  _meta?: Record<string, unknown> | null;
  sessionId: string;
  cwd?: string;
}

export interface ResumeSessionRequest {
  _meta?: Record<string, unknown> | null;
  sessionId: string;
  cwd?: string;
}

export interface DeleteSessionRequest {
  _meta?: Record<string, unknown> | null;
  sessionId: string;
}

export interface DeleteSessionResponse {
  _meta?: Record<string, unknown> | null;
  deleted: boolean;
  sessionId: string;
}

export interface RenameSessionRequest {
  _meta?: Record<string, unknown> | null;
  sessionId: string;
  title: string;
}

export interface RenameSessionResponse {
  _meta?: Record<string, unknown> | null;
  sessionId: string;
  title: string;
}

// ============================================================================
// Model Selection Types
// ============================================================================

/** 模型输入/输出模态。兼容后端 ModelModalities 类型。 */
export type ModelModalities =
  | {
      input?: ("text" | "image")[];
      output?: ("text" | "image")[];
    }
  | string[];

export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string | null;
  /** 模型支持的输入/输出模态（text, image 等） */
  modalities?: ModelModalities | null;
}

export interface SessionModelState {
  availableModels: ModelInfo[];
  currentModelId: string;
}

// ============================================================================
// Session Mode Types
// ============================================================================

export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

export interface SessionModeState {
  availableModes: SessionMode[];
  currentModeId: string;
}

// ============================================================================
// Settings
// ============================================================================

export interface ACPSettings {
  proxyUrl?: string;
  token?: string;
  cwd?: string;
  /** socket.io namespace（如 "/acp"） */
  namespace?: string;
  /** Agent 实例 ID，作为 socket.io query 参数传递 */
  agentId?: string;
  /** Session ID，作为 socket.io query 参数传递 */
  sessionId?: string;
  /** 当前活跃组织 ID，作为 socket.io query 参数传递 */
  activeOrganizationId?: string;
}

export const DEFAULT_SETTINGS: ACPSettings = {
  proxyUrl: "ws://localhost:9315/ws",
};
