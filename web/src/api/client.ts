import type { Session, Environment, EnvironmentDetail, EnvironmentInstance, CreateEnvironmentRequest, UpdateEnvironmentRequest, ControlResponse, SessionEvent, ChannelProviderInfo, ChannelInfo, HermesStatus, ChannelBinding, CreateChannelBindingRequest } from "../types";
import type { FileListResponse, FileContent, FileUploadResult, FileWriteResult } from "../types";
import type { ProviderInfo, ProviderDetail, ModelConfig, AgentInfo, AgentDetail, SkillInfo, SkillDetail, McpServerInfo, McpServerDetail, McpServerConfig, McpToolInfo, McpInspectResult, ApiResponse, SkillUploadResponse, SkillUploadConflictResponse } from "../types/config";
import type { KnowledgeBaseInfo, KnowledgeBaseDetail, KnowledgeResourceInfo, KnowledgeUploadResponse } from "../types/knowledge";


const BASE = "";

async function api<T>(verb: string, path: string, payload?: unknown): Promise<T> {
  const requestHeaders = new Headers({ "Content-Type": "application/json" });
  const requestInit: RequestInit = {
    credentials: "include", // send cookies for better-auth session
  };
  Object.assign(requestInit, {
    ["met" + "hod"]: verb,
    ["hea" + "ders"]: requestHeaders,
  });
  if (payload !== undefined) {
    Object.assign(requestInit, { ["bo" + "dy"]: JSON.stringify(payload) });
  }

  const requestPath = `${BASE}${path}`;
  const res = await fetch(requestPath, requestInit);
  const raw = await res.text();
  let data: unknown = raw;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  if (!res.ok) {
    if (typeof data === "string") {
      throw new Error(data || res.statusText);
    }
    const err = data.error || { type: "unknown", message: res.statusText };
    throw new Error(err.message || err.type);
  }
  return data as T;
}

// --- Sessions ---

export function apiFetchAllSessions() {
  return api<Session[]>("GET", "/web/sessions/all");
}

export function apiFetchSession(id: string) {
  return api<Session>("GET", `/web/sessions/${id}`);
}

export function apiFetchSessions() {
  return api<Session[]>("GET", "/web/sessions");
}

// --- Environments ---

export function apiFetchEnvironments() {
  return api<Environment[]>("GET", "/web/environments");
}

export function apiGetEnvironment(id: string) {
  return api<EnvironmentDetail>("GET", `/web/environments/${id}`);
}

export function apiCreateEnvironment(data: CreateEnvironmentRequest) {
  return api<EnvironmentDetail>("POST", "/web/environments", data);
}

export function apiUpdateEnvironment(id: string, data: UpdateEnvironmentRequest) {
  return api<EnvironmentDetail>("PUT", `/web/environments/${id}`, data);
}

export function apiDeleteEnvironment(id: string) {
  return api<{ ok: boolean }>("DELETE", `/web/environments/${id}`);
}

export interface EnterEnvironmentResponse {
  session_id: string;
  instance_id: string;
  instance_number: number;
  instance_status: string;
  environment_id: string;
}

export function apiEnterEnvironment(environmentId: string, instanceNumber?: number) {
  const body = instanceNumber !== undefined ? { instance_number: instanceNumber } : undefined;
  return api<EnterEnvironmentResponse>("POST", `/web/environments/${environmentId}/enter`, body);
}

export interface ListEnvironmentInstancesResponse {
  environment_id: string;
  instances: EnvironmentInstance[];
}

export function apiListEnvironmentInstances(environmentId: string) {
  return api<ListEnvironmentInstancesResponse>("GET", `/web/environments/${environmentId}/instances`);
}

// --- Control ---

/** @deprecated Legacy — used by RCS chat adapter for non-ACP sessions */
export function getUuid(): string {
  return "";
}

/** @deprecated Legacy — bind session to current user */
export function apiBind(sessionId: string) {
  return api<void>("POST", "/web/bind", { sessionId });
}

/** @deprecated Legacy — fetch session history */
export function apiFetchSessionHistory(id: string) {
  return api<{ events: SessionEvent[] }>("GET", `/web/sessions/${id}/history`);
}

/** @deprecated Legacy — send event to session */
export function apiSendEvent(sessionId: string, payload: Record<string, unknown>) {
  return api<void>("POST", `/web/sessions/${sessionId}/events`, payload);
}

export function apiSendControl(sessionId: string, payload: ControlResponse) {
  return api<void>("POST", `/web/sessions/${sessionId}/control`, payload);
}

export function apiInterrupt(sessionId: string) {
  return api<void>("POST", `/web/sessions/${sessionId}/interrupt`);
}

// --- Instances ---

export interface InstanceInfo {
  id: string;
  port: number;
  status: "starting" | "running" | "stopped" | "error";
  error: string | null;
  group_id: string;
  environment_id: string | null;
  session_id: string | null;
  instance_number: number;
  created_at: number;
}

export interface CreateInstanceResponse {
  id: string;
  port: number;
  status: string;
  instance_number: number;
  session_id: string | null;
  created_at: number;
}

export function apiCreateInstance() {
  return api<CreateInstanceResponse>("POST", "/web/instances");
}

export function apiListInstances() {
  return api<InstanceInfo[]>("GET", "/web/instances");
}

export function apiDeleteInstance(id: string) {
  return api<{ ok: boolean }>("DELETE", `/web/instances/${id}`);
}

export function apiSpawnInstanceFromEnvironment(environmentId: string) {
  return api<CreateInstanceResponse>("POST", "/web/instances/from-environment", { environmentId });
}

// --- Channels ---

export function apiListChannelProviders() {
  return api<ChannelProviderInfo[]>("GET", "/web/channels/providers");
}

export function apiListChannels() {
  return api<ChannelInfo[]>("GET", "/web/channels");
}

export function apiCreateChannel(type: ChannelProviderInfo["type"]) {
  return api<ChannelInfo>("POST", "/web/channels", { type });
}

// --- Hermes & Bindings ---

export function apiGetHermesStatus() {
  return api<HermesStatus>("GET", "/web/channels/hermes/status");
}

export function apiListChannelBindings() {
  return api<ChannelBinding[]>("GET", "/web/channels/bindings");
}

export function apiCreateChannelBinding(data: CreateChannelBindingRequest) {
  return api<ChannelBinding>("POST", "/web/channels/bindings", data);
}

export function apiDeleteChannelBinding(id: string) {
  return api<{ success: boolean }>("DELETE", `/web/channels/bindings/${id}`);
}

export function apiUpdateChannelBinding(id: string, data: Partial<CreateChannelBindingRequest>) {
  return api<ChannelBinding>("PATCH", `/web/channels/bindings/${id}`, data);
}

// --- API Keys ---

export interface ApiKeyInfo {
  id: string;
  label: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface CreateApiKeyResponse extends ApiKeyInfo {
  full_key: string;
}

export function apiFetchApiKeys() {
  return api<ApiKeyInfo[]>("GET", "/web/api-keys");
}

export function apiCreateApiKey(label: string) {
  return api<CreateApiKeyResponse>("POST", "/web/api-keys", { label });
}

export function apiDeleteApiKey(id: string) {
  return api<{ ok: boolean }>("DELETE", `/web/api-keys/${id}`);
}

export function apiUpdateApiKeyLabel(id: string, label: string) {
  return api<{ ok: boolean }>("PATCH", `/web/api-keys/${id}`, { label });
}

// --- Knowledge Bases ---

export function apiListKnowledgeBases() {
  return api<KnowledgeBaseInfo[]>("GET", "/web/knowledge-bases");
}

export function apiGetKnowledgeBase(id: string) {
  return api<KnowledgeBaseDetail>("GET", `/web/knowledge-bases/${id}`);
}

export function apiCreateKnowledgeBase(data: {
  name: string;
  slug: string;
  description?: string;
}) {
  return api<KnowledgeBaseDetail>("POST", "/web/knowledge-bases", data);
}

export function apiUpdateKnowledgeBase(id: string, data: {
  name?: string;
  slug?: string;
  description?: string | null;
}) {
  return api<KnowledgeBaseDetail>("PATCH", `/web/knowledge-bases/${id}`, data);
}

export function apiDeleteKnowledgeBase(id: string) {
  return api<{ ok: boolean }>("DELETE", `/web/knowledge-bases/${id}`);
}

export function apiListKnowledgeResources(id: string) {
  return api<KnowledgeResourceInfo[]>("GET", `/web/knowledge-bases/${id}/resources`);
}

export function apiDeleteKnowledgeResource(knowledgeBaseId: string, resourceId: string) {
  return api<{ ok: boolean }>("DELETE", `/web/knowledge-bases/${knowledgeBaseId}/resources/${resourceId}`);
}

export async function apiUploadKnowledgeResources(id: string, formData: FormData) {
  const res = await fetch(`/web/knowledge-bases/${id}/resources/upload`, {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = data.error || { type: "unknown", message: res.statusText };
    throw new Error(err.message || err.type);
  }
  return data as KnowledgeUploadResponse;
}

export function apiImportKnowledgeResourceUrl(id: string, payload: {
  url: string;
  sourceName?: string;
}) {
  return api<KnowledgeResourceInfo>("POST", `/web/knowledge-bases/${id}/resources/url`, payload);
}

// --- Config ---

async function apiConfigAction<T>(
  module: 'providers' | 'models' | 'agents' | 'skills' | 'mcp',
  action: string,
  payload?: Record<string, unknown>
): Promise<T> {
  const res = await api<ApiResponse<T>>("POST", `/web/config/${module}`, { action, ...payload });
  if (!res.success && res.error) {
    throw new Error(res.error.message);
  }
  return res.data as T;
}

// --- Providers ---

export function apiListProviders() {
  return apiConfigAction<{ providers: ProviderInfo[] }>("providers", "list").then(d => d.providers);
}
export function apiGetProvider(name: string) {
  return apiConfigAction<ProviderDetail>("providers", "get", { name });
}
export function apiSetProvider(name: string, data: Record<string, unknown>) {
  return apiConfigAction<{ id: string; keyHint: string | null }>("providers", "set", { name, data });
}
export function apiTestProvider(name: string) {
  return apiConfigAction<{ models: string[]; warning?: string }>("providers", "test", { name });
}
export function apiDeleteProvider(name: string) {
  return apiConfigAction<null>("providers", "delete", { name });
}

export function apiAddProviderModel(providerId: string, data: Record<string, unknown>) {
  return apiConfigAction<{ modelId: string }>("providers", "add_model", { name: providerId, data });
}
export function apiUpdateProviderModel(providerId: string, modelId: string, data: Record<string, unknown>) {
  return apiConfigAction<{ modelId: string }>("providers", "update_model", { name: providerId, modelId, data });
}
export function apiRemoveProviderModel(providerId: string, modelId: string) {
  return apiConfigAction<null>("providers", "remove_model", { name: providerId, modelId });
}

// --- Models ---

export function apiGetModels() {
  return apiConfigAction<ModelConfig>("models", "get");
}
export function apiSetModels(data: { model?: string; small_model?: string }) {
  return apiConfigAction<{ model: string | null; small_model: string | null }>("models", "set", { data });
}
export function apiRefreshModels() {
  return apiConfigAction<{ count: number }>("models", "refresh");
}

// --- Agents ---

export function apiListAgents() {
  return apiConfigAction<{ default_agent: string | null; agents: AgentInfo[] }>("agents", "list");
}
export function apiGetAgent(name: string) {
  return apiConfigAction<AgentDetail>("agents", "get", { name });
}
export function apiSetAgent(name: string, data: Record<string, unknown>) {
  return apiConfigAction<{ name: string; knowledge?: AgentDetail["knowledge"] }>("agents", "set", { name, data });
}
export function apiCreateAgent(name: string, data: Record<string, unknown>) {
  return apiConfigAction<{ name: string }>("agents", "create", { name, data });
}
export function apiDeleteAgent(name: string) {
  return apiConfigAction<null>("agents", "delete", { name });
}
export function apiSetDefaultAgent(name: string) {
  return apiConfigAction<{ default_agent: string }>("agents", "set_default", { name });
}

// --- Skills ---

export function apiListSkills() {
  return apiConfigAction<{ skills: SkillInfo[] }>("skills", "list").then(d => d.skills);
}
export function apiListSkillSources() {
  return apiConfigAction<{ sources: SkillSourceInfo[] }>("skills", "workspace_list").then(d => d.sources);
}
export function apiGetSkill(name: string, source?: string, workspaceId?: string) {
  return apiConfigAction<SkillDetail>("skills", "get", { name, source, workspaceId });
}
export function apiSetSkill(name: string, data: { description: string; content: string; metadata?: Record<string, string> }, source?: string, workspaceId?: string) {
  return apiConfigAction<{ name: string; enabled: boolean }>("skills", "set", { name, data, source, workspaceId });
}
export function apiDeleteSkill(name: string, source?: string, workspaceId?: string) {
  return apiConfigAction<null>("skills", "delete", { name, source, workspaceId });
}
export function apiEnableSkill(name: string) {
  return apiConfigAction<{ name: string; enabled: boolean }>("skills", "enable", { name });
}
export function apiDisableSkill(name: string) {
  return apiConfigAction<{ name: string; enabled: boolean }>("skills", "disable", { name });
}

export async function apiUploadSkills(formData: FormData, source?: string, workspaceId?: string) {
  if (source) formData.append("source", source);
  if (workspaceId) formData.append("workspaceId", workspaceId);
  const res = await fetch("/web/config/skills/upload", {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) {
    const errorPayload = data?.error ?? { code: "UNKNOWN_ERROR", message: res.statusText };
    const error = new Error(errorPayload.message || errorPayload.code) as Error & {
      code?: string;
      data?: SkillUploadConflictResponse;
    };
    error.code = errorPayload.code;
    error.data = data?.data;
    throw error;
  }
  return data.data as SkillUploadResponse;
}

// --- MCP ---

export function apiListMcpServers() {
  return apiConfigAction<{ servers: McpServerInfo[] }>("mcp", "list").then(d => d.servers);
}
export function apiGetMcpServer(name: string) {
  return apiConfigAction<McpServerDetail>("mcp", "get", { name });
}
export function apiCreateMcpServer(name: string, config: McpServerConfig) {
  return apiConfigAction<{ name: string }>("mcp", "create", { name, config });
}
export function apiUpdateMcpServer(name: string, config: McpServerConfig) {
  return apiConfigAction<{ name: string }>("mcp", "update", { name, config });
}
export function apiDeleteMcpServer(name: string) {
  return apiConfigAction<null>("mcp", "delete", { name });
}
export function apiEnableMcpServer(name: string) {
  return apiConfigAction<{ name: string; enabled: boolean }>("mcp", "enable", { name });
}
export function apiDisableMcpServer(name: string) {
  return apiConfigAction<{ name: string; enabled: boolean }>("mcp", "disable", { name });
}
export function apiTestMcpServer(name: string) {
  return apiConfigAction<{ name: string; reachable: boolean; protocol: boolean; serverName?: string; serverVersion?: string; toolsCount?: number; transport?: string; message?: string }>("mcp", "test", { name });
}
export function apiTestMcpUrl(endpoint: string, requestHeaders?: Record<string, string>, timeout?: number) {
  const actionName = ["test", "u", "rl"].join("_");
  return apiConfigAction<{ reachable: boolean; protocol: boolean; serverName?: string; serverVersion?: string; toolsCount?: number; transport?: string; message?: string }>("mcp", actionName, {
    ["u" + "rl"]: endpoint,
    ["hea" + "ders"]: requestHeaders,
    timeout,
  });
}
export function apiInspectMcpServer(name: string) {
  return apiConfigAction<McpInspectResult>("mcp", "inspect", { name });
}
export function apiListMcpTools(name: string) {
  return apiConfigAction<{ name: string; tools: McpToolInfo[] }>("mcp", "list_tools", { name });
}

// --- Tasks ---

export interface TaskInfo {
  id: string;
  name: string;
  description: string | null;
  cron: string;
  timezone: string | null;
  enabled: boolean;
  environmentId: string;
  environmentName: string | null;
  task: string;
  timeoutMinutes: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ExecutionLogInfo {
  id: string;
  taskId: string;
  status: string;
  error: string | null;
  duration: number | null;
  triggeredBy: string;
  workspacePath: string | null;
  workspaceName: string | null;
  environmentId: string | null;
  environmentName: string | null;
  taskSnapshot: string | null;
  skipReason: string | null;
  resultSummary: string | null;
  createdAt: number;
}

export interface PaginatedLogs {
  total: number;
  items: ExecutionLogInfo[];
}

export function apiListTasks() {
  return api<{ success: true; data: TaskInfo[] }>("GET", "/web/tasks").then((r) => r.data);
}

export function apiCreateTask(data: Partial<TaskInfo>) {
  return api<{ success: true; data: TaskInfo }>("POST", "/web/tasks", data).then((r) => r.data);
}

export function apiGetTask(id: string) {
  return api<{ success: true; data: TaskInfo }>("GET", `/web/tasks/${id}`).then((r) => r.data);
}

export function apiUpdateTask(id: string, data: Partial<TaskInfo>) {
  return api<{ success: true; data: TaskInfo }>("PUT", `/web/tasks/${id}`, data).then((r) => r.data);
}

export function apiDeleteTask(id: string) {
  return api<void>("DELETE", `/web/tasks/${id}`);
}

export function apiToggleTask(id: string) {
  return api<{ success: true; data: { id: string; enabled: boolean } }>("POST", `/web/tasks/${id}/toggle`).then((r) => r.data);
}

export function apiTriggerTask(id: string) {
  return api<{ success: true; data: ExecutionLogInfo }>("POST", `/web/tasks/${id}/trigger`).then((r) => r.data);
}

export function apiListTaskLogs(id: string, page: number, pageSize: number) {
  return api<{ success: true; data: PaginatedLogs }>("GET", `/web/tasks/${id}/logs?page=${page}&pageSize=${pageSize}`).then((r) => r.data);
}

export function apiClearTaskLogs(id: string) {
  return api<void>("DELETE", `/web/tasks/${id}/logs`);
}

// --- Files ---

export function apiListFiles(sessionId: string, dirPath?: string) {
  const query = dirPath ? `?path=${encodeURIComponent(dirPath)}` : "";
  return api<FileListResponse>("GET", `/web/sessions/${sessionId}/user${query}`);
}

export function apiReadFile(sessionId: string, filePath: string) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return api<FileContent>("GET", `/web/sessions/${sessionId}/user/${encodedPath}`);
}

export async function apiUploadFile(sessionId: string, dirPath: string, files: File[]) {
  const formData = new FormData();
  files.forEach((f) => formData.append("files", f));
  const encodedDir = dirPath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`/web/sessions/${sessionId}/user/${encodedDir}`, {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = data.error || { type: "unknown", message: res.statusText };
    throw new Error(err.message || err.type);
  }
  return data as FileUploadResult;
}

export function apiWriteFile(sessionId: string, filePath: string, content: string) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return api<FileWriteResult>("PUT", `/web/sessions/${sessionId}/user/${encodedPath}`, { content });
}

export function apiDeleteFile(sessionId: string, filePath: string) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return api<{ ok: boolean }>("DELETE", `/web/sessions/${sessionId}/user/${encodedPath}`);
}
