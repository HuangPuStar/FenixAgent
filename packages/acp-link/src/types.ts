// ============================================================================
// JSON-RPC 2.0 Types
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && !("method" in msg);
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

// ============================================================================
// ACP Initialization Types
// ============================================================================

export interface InitializeParams {
  protocolVersion: string;
  clientInfo: {
    name: string;
    version: string;
  };
  capabilities?: ClientCapabilities;
}

export interface ClientCapabilities {
  streaming?: boolean;
  toolApproval?: boolean;
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities?: ServerCapabilities;
}

export interface ServerCapabilities {
  streaming?: boolean;
  tools?: boolean;
}

export interface SessionSetupParams {
  sessionId?: string;
  context?: SessionContext;
}

export interface SessionContext {
  workingDirectory?: string;
  files?: string[];
}

export interface PromptParams {
  sessionId: string;
  messages: PromptMessage[];
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

export interface ContentPart {
  type: "text" | "image" | "file";
  text?: string;
  data?: string;
  mimeType?: string;
  path?: string;
}

export interface ContentNotification {
  sessionId: string;
  content: string;
  done?: boolean;
}

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
  | ProxySessionResumedMessage;

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
}

export interface ToolCallStatusUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: string;
  title?: string;
  content?: ToolCallContent[];
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
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

export interface SessionCapabilities {
  _meta?: Record<string, unknown> | null;
  fork?: SessionForkCapabilities | null;
  list?: SessionListCapabilities | null;
  resume?: SessionResumeCapabilities | null;
}

export interface AgentCapabilities {
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

// ============================================================================
// Model Selection Types
// ============================================================================

export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string | null;
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
  proxyUrl: string;
  token?: string;
  cwd?: string;
}

export const DEFAULT_SETTINGS: ACPSettings = {
  proxyUrl: "ws://localhost:9315/ws",
};
