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
  V2CodeSessionApi,
  V2WorkerApi,
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
export const agentSitesApi = {
  list: () => fetch("/web/agent-sites/apps", { credentials: "include" }).then((r) => r.json()),
  get: (id: string) => fetch(`/web/agent-sites/apps/${id}`, { credentials: "include" }).then((r) => r.json()),
  create: (body: { name: string; description?: string; visibility?: string }) =>
    fetch("/web/agent-sites/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  update: (id: string, body: { name?: string; description?: string; visibility?: string }) =>
    fetch(`/web/agent-sites/apps/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    }).then((r) => r.json()),
  delete: (id: string) =>
    fetch(`/web/agent-sites/apps/${id}`, { method: "DELETE", credentials: "include" }).then((r) => r.json()),
  rotateToken: (id: string) =>
    fetch(`/web/agent-sites/apps/${id}/rotate-token`, {
      method: "POST",
      credentials: "include",
    }).then((r) => r.json()),
  uploadFile: (id: string, path: string, body: BodyInit) =>
    fetch(`/web/agent-sites/apps/${id}/files/${path}`, {
      method: "PUT",
      credentials: "include",
      body,
    }).then((r) => r.json()),
  uploadBundle: (id: string, body: BodyInit) =>
    fetch(`/web/agent-sites/apps/${id}/files/bundle`, {
      method: "POST",
      credentials: "include",
      body,
    }).then((r) => r.json()),
};

// ── V2 模块（一般前端不直接使用，保留导出） ──
export const v2CodeSessionApi = new V2CodeSessionApi();
export const v2WorkerApi = new V2WorkerApi();
