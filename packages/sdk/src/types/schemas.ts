/**
 * SDK 自包含类型定义
 *
 * 这些类型与后端 Zod schema 保持同步。
 * SDK 包独立于后端，不通过相对路径引用后端 schema 文件。
 *
 * 注意：所有 interface 都包含 `[key: string]: unknown` 索引签名，
 * 以支持 `as Record<string, unknown>` 类型转换模式。
 */

// ── Indexable base ──
// biome-ignore lint/suspicious/noExplicitAny: allow index signature for Record<string, unknown> compatibility
type Indexable = { [key: string]: any };

// ── Channel ──
export interface ChannelBinding extends Indexable {
  id: string;
  platform: string;
  chatId: string;
  agentId: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
export type ChannelBindingListResponse = ChannelBinding[];
export interface ChannelProviderDescriptor {
  id: string;
  name: string;
  type: string;
}
export type ChannelProviderListResponse = ChannelProviderDescriptor[];
export interface CreateChannelBindingRequest {
  platform: string;
  chatId: string;
  agentId: string;
  enabled?: boolean;
}
export type CreateChannelBindingResponse = ChannelBinding;
export type DeleteChannelBindingResponse = Record<string, unknown>;
export interface HermesStatus {
  connected: boolean;
  url?: string;
}
export type UpdateChannelBindingResponse = ChannelBinding;

// ── Common ──
export interface OkResponse {
  success: boolean;
}
export interface PaginationParams {
  page?: number;
  pageSize?: number;
}
export interface StatusOkResponse {
  status: string;
}

// ── Config ──
export interface AgentInfo extends Indexable {
  name: string;
  model?: string;
  description?: string;
  builtIn?: boolean;
  enabled?: boolean;
  permissions?: Record<string, string>;
  skills?: string[];
}
export interface AgentDetail extends AgentInfo {
  systemPrompt?: string;
}
export type ConfigAction = "list" | "get" | "set" | "create" | "delete" | "set_default";
export interface ConfigBody {
  action: ConfigAction;
  name?: string;
  data?: Record<string, unknown>;
}
export interface McpInspectResult extends Indexable {
  name: string;
  tools?: McpToolInfo[];
}
export interface McpServerDetail extends Indexable {
  name: string;
  config: Record<string, unknown>;
  enabled?: boolean;
  summary?: string;
}
export interface McpServerInfo extends Indexable {
  name: string;
  type?: string;
  enabled?: boolean;
  summary?: string;
}
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
export interface ModelConfig extends Indexable {
  current: {
    model: string;
    small_model?: string;
  };
  available?: ModelEntry[];
}
export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}
export interface ProviderDetail extends Indexable {
  name: string;
  configured: boolean;
  keyHint?: string;
  baseURL?: string;
  models?: ModelEntry[];
}
export interface ProviderInfo extends Indexable {
  name: string;
  configured: boolean;
  keyHint?: string;
  baseURL?: string;
}
export interface SkillInfo extends Indexable {
  name: string;
  description?: string;
  enabled?: boolean;
  path?: string;
  source?: SkillSourceInfo;
}
export interface SkillSourceInfo {
  type: string;
  path?: string;
}

// ── Environment ──
export interface CreateEnvironmentRequest {
  name: string;
  agentConfigId?: string;
  description?: string;
  autoStart?: boolean;
}
export type DeleteEnvironmentResponse = Record<string, unknown>;
export interface EnterEnvironmentResponse {
  sessionId: string;
  instanceId?: string;
}
export interface EnvironmentInfo {
  id: string;
  name: string;
  description: string | null;
  workspace_path: string;
  agent_config_id: string | null;
  status: string;
  machine_name: string | null;
  branch: string | null;
  auto_start: boolean;
  last_poll_at: number | null;
  created_at: number;
  updated_at: number;
}
export interface EnvironmentListResponse extends EnvironmentInfo {
  session_id: string;
  instance_status: string | null;
  instance_id: string | null;
  instances_count: number;
}
export interface EnvironmentDetailResponse extends EnvironmentInfo {
  secret: string;
}
export interface ListInstancesResponse {
  instances: Array<{
    id: string;
    instance_number: number;
    status: string;
    session_id: string | null;
    port: number;
    created_at: number;
  }>;
}
export interface UpdateEnvironmentRequest {
  name?: string;
  description?: string;
  agentConfigId?: string;
  autoStart?: boolean;
}
export interface UpdateEnvironmentResponse {
  id: string;
}

// ── File ──
export interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  modifiedAt: number;
}
export interface FileListResponse {
  entries: FileEntry[];
}
export interface FileContent {
  name: string;
  path: string;
  content: string;
  size: number;
  encoding: string;
}
export interface FileUploadResponse {
  files: Array<{ name: string; path: string; size: number }>;
}
export interface FileWriteResult {
  name: string;
  path: string;
  size: number;
}
export interface TreeResponse {
  paths: string[];
}
export interface RenameResponse {
  oldPath: string;
  newPath: string;
}
export interface MkdirResponse {
  path: string;
}
export interface BatchDeleteResponse {
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}

// ── Instance ──
export interface InstanceInfo {
  id: string;
  environment_id: string;
  instance_number: number;
  status: string;
  session_id: string | null;
  port: number;
  created_at: number;
}
export interface InstanceListResponse {
  instances: InstanceInfo[];
}
export type InstanceStatus = string;
export interface SpawnInstanceFromEnvironmentRequest {
  environmentId: string;
  instanceNumber?: number;
}
export type DeleteInstanceResponse = Record<string, unknown>;

// ── Knowledge ──
export interface KnowledgeBaseInfo {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}
export type KnowledgeBaseListResponse = KnowledgeBaseInfo[];
export interface CreateKnowledgeBaseRequest {
  name: string;
  description?: string;
}
export interface UpdateKnowledgeBaseRequest {
  name?: string;
  description?: string;
}
export type DeleteKnowledgeBaseResponse = Record<string, unknown>;
export interface KnowledgeResourceItem {
  id: string;
  knowledgeBaseId: string;
  sourceName?: string;
  sourceType: string;
  createdAt: number;
}
export interface UploadKnowledgeResourcesResponse extends Indexable {
  imported: string[];
  skipped: string[];
}
export interface ImportKnowledgeUrlResponse {
  id: string;
}
export type DeleteKnowledgeResourceResponse = Record<string, unknown>;

// ── S3 File ──
export interface S3FileEntry {
  key: string;
  size: number;
  lastModified: number;
}
export interface S3FileListQuery {
  sessionId: string;
  prefix?: string;
}
export interface S3FileListResponse {
  files: S3FileEntry[];
}
export interface S3PresignGetQuery {
  sessionId: string;
  key: string;
}
export interface S3PresignGetResponse {
  url: string;
}
export interface S3PresignPutBody {
  sessionId: string;
  key: string;
  contentType: string;
}
export interface S3PresignPutResponse {
  url: string;
}
export interface S3UploadResponse {
  key: string;
}

// ── Session ──
export interface SessionEvent extends Indexable {
  seqNum?: number;
  type: string;
  payload?: Record<string, unknown>;
}
export interface SessionResponse {
  id: string;
  title?: string;
  environment_id?: string;
  status?: string;
  created_at?: number;
}
export type SessionListResponse = SessionResponse[];
export interface SessionHistory {
  events: SessionEvent[];
}
export interface SessionSummary {
  id: string;
  title?: string;
  status?: string;
}
export type SendEventResponse = Record<string, unknown>;
export type InterruptResponse = Record<string, unknown>;

// ── Task ──
export interface TaskInfo extends Indexable {
  id: string;
  name: string;
  description?: string;
  cron: string;
  environmentId: string;
  task: string;
  timeoutMinutes: number;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: string | null;
}
export interface CreateTaskRequest {
  name: string;
  cron: string;
  environmentId: string;
  task: string;
  timeoutMinutes?: number;
  description?: string;
}
export interface UpdateTaskRequest {
  name?: string;
  cron?: string;
  task?: string;
  timeoutMinutes?: number;
  description?: string;
  enabled?: boolean;
}
export type DeleteTaskResponse = Record<string, unknown>;
export interface ToggleTaskResponse {
  enabled: boolean;
}
export type TriggerTaskResponse = Record<string, unknown>;
export type ClearTaskLogsResponse = Record<string, unknown>;
export interface ExecutionLogInfo {
  id: string;
  status: string;
  triggeredBy: string;
  duration?: number | null;
  createdAt: number;
  workspacePath?: string | null;
  resultSummary?: string | null;
  error?: string | null;
}
export interface PaginatedLogs {
  logs: ExecutionLogInfo[];
  total: number;
}

// ── V1 Environment ──
export interface BridgeRegistrationRequest {
  name: string;
  token: string;
  workspace_path?: string;
}
export interface BridgeRegistrationResponse {
  id: string;
  token: string;
}

// ── V1 Session ──
export interface CreateSessionRequest {
  environmentId: string;
  title?: string;
}
export interface V1CreateSessionResponse {
  id: string;
}
export interface V1GetSessionResponse {
  id: string;
  title?: string;
  environment_id?: string;
  status?: string;
}
export type V1SendEventsResponse = Record<string, unknown>;
export interface UpdateSessionRequest {
  title?: string;
}
export interface SendEventsRequest {
  events: Record<string, unknown>[] | Record<string, unknown>;
}

// ── V2 Code Session ──
export interface CreateCodeSessionRequest {
  environmentId: string;
  title?: string;
}
export interface CreateCodeSessionResponse {
  id: string;
}
export interface CodeSessionBridgeResponse {
  sessionId: string;
}

// ── V2 Worker ──
export interface GetWorkerResponse {
  id: string;
  status: string;
}
export interface UpdateWorkerRequest {
  status?: string;
}
export type UpdateWorkerResponse = Record<string, unknown>;
export type WorkerHeartbeatResponse = Record<string, unknown>;

// ── V2 Worker Events ──
export interface WorkerEventsRequest {
  events: Record<string, unknown>[];
}
export type WorkerEventsResponse = Record<string, unknown>;
export interface WorkerStateRequest {
  state: Record<string, unknown>;
}

// ── Organization ──
export interface OrgInfo extends Indexable {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
}
export interface OrgDetail extends OrgInfo {
  members?: OrgMember[];
}
export interface OrgMember {
  id: string;
  userId: string;
  role: string;
  organizationId: string;
}
export interface CreateOrgRequest {
  name: string;
  slug: string;
}
export interface UpdateOrgRequest {
  name?: string;
  slug?: string;
}

// ── API Key ──
export interface ApiKeyInfo extends Indexable {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number;
}
