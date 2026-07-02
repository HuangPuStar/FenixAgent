/**
 * Workflow Definition API Client。
 *
 * 对接后端 RESTful /web/workflow-defs 端点。
 */

// ── 类型定义 ──

export interface WorkflowDefItem {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  description: string | null;
  latestVersion: number | null;
  storagePath: string | null;
  createdAt: string;
  updatedAt: string;
  draftYaml?: string | null;
}

export interface WorkflowVersionItem {
  id: string;
  workflowId: string;
  version: number;
  filePath: string;
  status: string;
  createdBy: string;
  createdAt: string;
}

export interface VersionYamlResponse {
  workflowId: string;
  version: number;
  yaml: string;
}

export interface TriggerItem {
  id: string;
  workflowId: string;
  type: string;
  publicHash: string;
  maskedHash: string;
  webhookUrl: string | null;
  secret: string | null;
  config: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowParamDefsResponse {
  version: number;
  params: Record<string, unknown>;
}

export interface CustomToolInputDef {
  type: string;
  required?: boolean;
  description: string;
  group?: string;
}

export interface CustomToolItem {
  name: string;
  description: string;
  inputs: Record<string, CustomToolInputDef>;
  produces: string[];
  kind?: string;
  color?: string;
  env?: string[];
}

// ── API Client ──

import { request } from "./request";

const ENDPOINT = "/web/workflow-defs";

// ── API Methods ──

export const workflowDefApi = {
  /** 列出工作流 */
  list: () => request<WorkflowDefItem[]>(ENDPOINT, { method: "GET" }),

  /** 创建工作流 */
  create: (name: string, description?: string) =>
    request<WorkflowDefItem>(ENDPOINT, { method: "POST", body: { name, description } }),

  /** 获取单个工作流（含草稿内容） */
  get: (workflowId: string) => request<WorkflowDefItem>(`${ENDPOINT}/${workflowId}`, { method: "GET" }),

  /** 保存草稿 */
  save: (workflowId: string, yaml: string) =>
    request<void>(`${ENDPOINT}/${workflowId}/draft`, { method: "PUT", body: { yaml } }),

  /** 发布版本 */
  publish: (workflowId: string) =>
    request<WorkflowVersionItem>(`${ENDPOINT}/${workflowId}/publish`, { method: "POST" }),

  /** 删除工作流 */
  delete: (workflowId: string) => request<void>(`${ENDPOINT}/${workflowId}`, { method: "DELETE" }),

  /** 更新元数据 */
  updateMeta: (workflowId: string, data: { name?: string; description?: string }) =>
    request<WorkflowDefItem>(`${ENDPOINT}/${workflowId}`, { method: "PATCH", body: data }),

  /** 获取版本历史 */
  getVersions: (workflowId: string) =>
    request<WorkflowVersionItem[]>(`${ENDPOINT}/${workflowId}/versions`, { method: "GET" }),

  /** 获取特定版本 YAML */
  getVersion: (workflowId: string, version: number) =>
    request<VersionYamlResponse>(`${ENDPOINT}/${workflowId}/versions/${version}`, { method: "GET" }),

  /** 设置 latest 指针（回滚） */
  setLatest: (workflowId: string, version: number) =>
    request<void>(`${ENDPOINT}/${workflowId}/versions/${version}/set-latest`, { method: "POST" }),

  /** 恢复版本到草稿 */
  restoreToDraft: (workflowId: string, version: number) =>
    request<void>(`${ENDPOINT}/${workflowId}/versions/${version}/restore`, { method: "POST" }),

  /** 获取工作流参数定义（从 YAML 解析） */
  getParamDefs: (workflowId: string, version?: number) =>
    request<WorkflowParamDefsResponse>(`${ENDPOINT}/${workflowId}/params`, {
      method: "GET",
      query: version !== undefined ? { version: String(version) } : undefined,
    }),

  /** 扫描可恢复的工作流 ID */
  recover: () => request<string[]>(`${ENDPOINT}/recoverable`, { method: "GET" }),

  /** 执行恢复 */
  recoverApply: (workflowIds: string[]) =>
    request<WorkflowDefItem[]>(`${ENDPOINT}/recover`, { method: "POST", body: { workflowIds } }),

  // ── Triggers ──

  /** 创建 webhook trigger */
  createTrigger: (workflowId: string, type?: string, config?: Record<string, unknown>) =>
    request<TriggerItem>(`${ENDPOINT}/${workflowId}/triggers`, {
      method: "POST",
      body: { type, config },
    }),

  /** 列出 workflow 的所有 trigger */
  listTriggers: (workflowId: string) => request<TriggerItem[]>(`${ENDPOINT}/${workflowId}/triggers`, { method: "GET" }),

  /** 删除 trigger */
  deleteTrigger: (workflowId: string, triggerId: string) =>
    request<void>(`${ENDPOINT}/${workflowId}/triggers/${triggerId}`, { method: "DELETE" }),

  /** 重新生成 hash */
  regenerateTriggerHash: (workflowId: string, triggerId: string) =>
    request<TriggerItem>(`${ENDPOINT}/${workflowId}/triggers/${triggerId}/regenerate`, { method: "POST" }),

  /** 启用 trigger */
  enableTrigger: (workflowId: string, triggerId: string) =>
    request<void>(`${ENDPOINT}/${workflowId}/triggers/${triggerId}/enable`, { method: "POST" }),

  /** 禁用 trigger */
  disableTrigger: (workflowId: string, triggerId: string) =>
    request<void>(`${ENDPOINT}/${workflowId}/triggers/${triggerId}/disable`, { method: "POST" }),
};

export const customToolsApi = {
  list: async (): Promise<CustomToolItem[]> => {
    const r = await fetch("/web/workflow-custom-tools", { credentials: "include" });
    if (!r.ok) {
      throw new Error(`Failed to load custom tools: ${r.status}`);
    }
    const json = (await r.json()) as { success?: boolean; data?: CustomToolItem[] };
    return Array.isArray(json.data) ? json.data : [];
  },
};
