import type { Session, Environment, EnvironmentDetail, CreateEnvironmentRequest, UpdateEnvironmentRequest, ControlResponse, SessionEvent } from "../types";
import type { ProviderInfo, ProviderDetail, ModelConfig, AgentInfo, AgentDetail, SkillInfo, SkillDetail, McpServerInfo, McpServerDetail, McpServerConfig, McpToolInfo, McpInspectResult, ApiResponse } from "../types/config";


const BASE = "";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  const url = `${BASE}${path}`;
  const opts: RequestInit = {
    method,
    headers,
    credentials: "include", // send cookies for better-auth session
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) {
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
export function apiSendEvent(sessionId: string, body: Record<string, unknown>) {
  return api<void>("POST", `/web/sessions/${sessionId}/events`, body);
}

export function apiSendControl(sessionId: string, body: ControlResponse) {
  return api<void>("POST", `/web/sessions/${sessionId}/control`, body);
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
  created_at: number;
}

export interface CreateInstanceResponse {
  id: string;
  port: number;
  status: string;
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
  return apiConfigAction<{ name: string }>("agents", "set", { name, data });
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
export function apiGetSkill(name: string) {
  return apiConfigAction<SkillDetail>("skills", "get", { name });
}
export function apiSetSkill(name: string, data: { description: string; content: string; metadata?: Record<string, string> }) {
  return apiConfigAction<{ name: string; enabled: boolean }>("skills", "set", { name, data });
}
export function apiDeleteSkill(name: string) {
  return apiConfigAction<null>("skills", "delete", { name });
}
export function apiEnableSkill(name: string) {
  return apiConfigAction<{ name: string; enabled: boolean }>("skills", "enable", { name });
}
export function apiDisableSkill(name: string) {
  return apiConfigAction<{ name: string; enabled: boolean }>("skills", "disable", { name });
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
export function apiTestMcpUrl(url: string, headers?: Record<string, string>, timeout?: number) {
  return apiConfigAction<{ reachable: boolean; protocol: boolean; serverName?: string; serverVersion?: string; toolsCount?: number; transport?: string; message?: string }>("mcp", "test_url", { url, headers, timeout });
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
  userId: string;
  name: string;
  description: string | null;
  cron: string;
  timezone: string;
  enabled: boolean;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  body: string | null;
  timeout: number;
  retryEnabled: boolean;
  retryCount: number;
  retryInterval: number;
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
  statusCode: number | null;
  responseBody: string | null;
  error: string | null;
  duration: number | null;
  attempt: number;
  triggeredBy: string;
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
