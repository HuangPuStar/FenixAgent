import type { Session, Environment, ControlResponse, SessionEvent } from "../types";
import type { ProviderInfo, ProviderDetail, ModelConfig, AgentInfo, AgentDetail, SkillInfo, SkillDetail, ApiResponse } from "../types/config";


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
  module: 'providers' | 'models' | 'agents' | 'skills',
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
