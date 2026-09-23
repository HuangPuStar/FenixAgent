/**
 * 宿主视图类型。环境契约的唯一来源是 `@fenix/agent-runtime/web/api/environments`：那里已有
 * `EnvironmentDetail` / `Create|UpdateEnvironmentRequest`，本文件只保留宿主仍有引用的
 * `Environment` / `EnvironmentInstance`（`shell/AgentSidebarTree.tsx` 等），重复副本已删除；
 * 后端也不再返回 `maxSessions`（drizzle/0025 已删列），不得在此复活。
 */

export interface Environment {
  id: string;
  name: string;
  description: string | null;
  workspacePath: string;
  agentName: string | null;
  agentConfigId: string | null;
  status: string;
  machineName: string | null;
  branch: string | null;
  autoStart: boolean;
  lastPollAt: number | null;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  instanceStatus?: string | null;
  instanceId?: string | null;
  instances?: EnvironmentInstance[];
  instancesCount?: number;
  workerType?: string;
  channelGroupId?: string;
  directory?: string;
}

export interface EnvironmentInstance {
  instanceUid: string;
  name: string;
  status: "stopped" | "starting" | "running" | "stopping" | "unknown";
  createdAt: string;
}

export type ChannelProviderStatus = "disabled" | "enabled";

export interface ChannelProviderInfo {
  type: "wechat" | "feishu";
  label: string;
  status: ChannelProviderStatus;
}

export interface ChannelInfo {
  id: string;
  type: ChannelProviderInfo["type"];
  label: string;
  status: string;
}

export interface HermesStatus {
  connected: boolean;
  url: string;
  platforms: string[];
  reconnecting: boolean;
  lastConnectedAt: number | null;
}

export interface ChannelBinding {
  id: string;
  platform: string;
  chatId: string | null;
  agentId: string;
  agentName: string | null;
  enabled: boolean;
}

export interface CreateChannelBindingRequest {
  platform: string;
  chatId?: string | null;
  agentId: string;
  enabled?: boolean;
}

export interface Session {
  id: string;
  title?: string;
  status: string;
  environment_id?: string;
  agent_name?: string | null;
  source?: string;
  created_at?: number;
  updated_at?: number;
  automation_state?: unknown;
}

export interface SessionEvent {
  type: string;
  payload?: EventPayload;
  direction?: "inbound" | "outbound";
  seqNum?: number;
  id?: string;
}

export interface EventPayload {
  content?: string;
  message?: unknown;
  status?: string;
  uuid?: string;
  raw?: {
    uuid?: string;
    status?: string;
  };
  request_id?: string;
  request?: PermissionRequest;
  tool_name?: string;
  tool_input?: unknown;
  input?: unknown;
  description?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

export interface PermissionRequest {
  subtype?: string;
  tool_name?: string;
  input?: unknown;
  tool_input?: unknown;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
  metadata?: Record<string, unknown>;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface ControlResponse {
  type: "permission_response";
  approved: boolean;
  request_id: string;
  message?: string;
  updated_input?: Record<string, unknown>;
  updated_permissions?: PermissionUpdate[];
}

export interface PermissionUpdate {
  type: string;
  mode: string;
  destination: string;
}

export type ActivityMode = "working" | "idle" | "standby" | "sleeping";

export interface AutomationActivity {
  mode: ActivityMode;
  iconVariant: string;
  label: string;
  endsAt?: number;
}

// --- File System Types ---

export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  modifiedAt: number;
}

export interface FileListResponse {
  entries: FileInfo[];
}

export interface FileContent {
  name: string;
  path: string;
  content: string;
  size: number;
  encoding: string;
}

export interface FileUploadResult {
  files: Array<{ name: string; path: string; size: number }>;
}

export interface FileWriteResult {
  name: string;
  path: string;
  size: number;
}

/** 定时任务信息 */
export interface TaskInfo {
  id: string;
  name: string;
  description?: string;
  cron: string;
  environmentId: string;
  environmentName?: string;
  task: string;
  timeoutMinutes: number;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: string | null;
}
