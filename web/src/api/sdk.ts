/**
 * sdk.ts — 前端 SDK 实例工厂
 *
 * 所有模块类无状态，可以安全复用单例。
 * 前端通过 `import { envApi, sessionApi } from "@/src/api/sdk"` 使用。
 */

import {
  AgentApi,
  ApiKeyApi,
  AuthApi,
  ChannelApi,
  ControlApi,
  EnvironmentApi,
  FileApi,
  InstanceApi,
  KnowledgeBaseApi,
  McpApi,
  MetaAgentApi,
  ModelApi,
  OrganizationApi,
  ProviderApi,
  RegistryApi,
  SessionApi,
  SkillConfigApi,
  TaskApi,
  UserFileApi,
  WorkflowDefApi,
  WorkflowEngineApi,
} from "@fenix/sdk";

// ── Web 模块 ──
export const envApi = new EnvironmentApi();
export const sessionApi = new SessionApi();
export const controlApi = new ControlApi();
export const instanceApi = new InstanceApi();
export const taskApi = new TaskApi();
export const fileApi = new FileApi();
export const userFileApi = new UserFileApi();
export const kbApi = new KnowledgeBaseApi();
export const channelApi = new ChannelApi();
export const providerApi = new ProviderApi();
export const modelApi = new ModelApi();
export const agentApi = new AgentApi();
export const skillConfigApi = new SkillConfigApi();
export const mcpApi = new McpApi();
export const orgApi = new OrganizationApi();
export const apiKeyApi = new ApiKeyApi();
export const workflowEngineApi = new WorkflowEngineApi();
export const workflowDefApi = new WorkflowDefApi();
export const metaAgentApi = new MetaAgentApi();
export const registryApi = new RegistryApi();
export const authApi = new AuthApi();

// ── Agent Sites ──

async function agentSitesFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "include", ...init });
  const json: { success?: boolean; error?: { message?: string } } = await r.json();
  if (!r.ok || json.success === false) {
    throw new Error(json?.error?.message ?? `请求失败 (${r.status})`);
  }
  return json as T;
}

export const agentSitesApi = {
  list: () => agentSitesFetch<{ success: boolean; data: unknown[] }>("/web/agent-sites/apps"),
  get: (id: string) => agentSitesFetch(`/web/agent-sites/apps/${id}`),
  create: (body: { name: string; description?: string; visibility?: string }) =>
    agentSitesFetch("/web/agent-sites/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  update: (id: string, body: { name?: string; description?: string; visibility?: string }) =>
    agentSitesFetch(`/web/agent-sites/apps/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  delete: (id: string) => agentSitesFetch(`/web/agent-sites/apps/${id}`, { method: "DELETE" }),
  rotateToken: (id: string) => agentSitesFetch(`/web/agent-sites/apps/${id}/rotate-token`, { method: "POST" }),
  uploadFile: (id: string, path: string, body: BodyInit) =>
    agentSitesFetch(`/web/agent-sites/apps/${id}/files/${path}`, {
      method: "PUT",
      body,
    }),
  uploadBundle: (id: string, body: BodyInit) =>
    agentSitesFetch(`/web/agent-sites/apps/${id}/files/bundle`, {
      method: "POST",
      body,
    }),
  /**
   * 按 agentConfigId 拉取绑定的 site app 详情列表。
   * chat 右侧 ArtifactsPanel 用它来填充顶部 Files / Site1 / Site2 tab。
   * 返回顺序与绑定顺序一致（按 created_at 升序），UI 展示稳定。
   */
  listByAgentConfig: (agentConfigId: string) =>
    agentSitesFetch<{ success: boolean; data: unknown[] }>(
      `/web/agent-sites/agent-configs/${encodeURIComponent(agentConfigId)}/sites`,
    ),
  /**
   * 单点绑定 site 到 agent。chat 右侧 Sites tab 的 + 按钮调用。
   * 后端走 PK 联合唯一 + ON CONFLICT DO NOTHING，重复绑定幂等。
   */
  bindSite: (agentConfigId: string, siteAppId: string) =>
    agentSitesFetch<{ success: boolean }>(
      `/web/agent-sites/agent-configs/${encodeURIComponent(agentConfigId)}/sites/${encodeURIComponent(siteAppId)}`,
      { method: "POST" },
    ),
  /**
   * 单点解绑 site。chat 右侧 Sites tab 的 × 按钮调用。DELETE 天然幂等。
   */
  unbindSite: (agentConfigId: string, siteAppId: string) =>
    agentSitesFetch<{ success: boolean }>(
      `/web/agent-sites/agent-configs/${encodeURIComponent(agentConfigId)}/sites/${encodeURIComponent(siteAppId)}`,
      { method: "DELETE" },
    ),
};
