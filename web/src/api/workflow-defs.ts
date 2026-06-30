/**
 * Workflow Definition API Client。
 *
 * 对接后端 POST /web/workflow-defs，通过 action 字段分发。
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

export interface CustomToolInputDef {
  type: string;
  required: boolean;
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

// ── API Methods ──

export const workflowDefApi = {
  /** 创建工作流 */
  create: (name: string, description?: string) =>
    request<WorkflowDefItem>("/web/workflow-defs", { method: "POST", body: { action: "create", name, description } }),

  /** 保存草稿 */
  save: (workflowId: string, yaml: string) =>
    request<void>("/web/workflow-defs", { method: "POST", body: { action: "save", workflowId, yaml } }),

  /** 发布版本 */
  publish: (workflowId: string) =>
    request<WorkflowVersionItem>("/web/workflow-defs", { method: "POST", body: { action: "publish", workflowId } }),

  /** 列出工作流 */
  list: () => request<WorkflowDefItem[]>("/web/workflow-defs", { method: "POST", body: { action: "list" } }),

  /** 获取单个工作流（含草稿内容） */
  get: (workflowId: string) =>
    request<WorkflowDefItem>("/web/workflow-defs", { method: "POST", body: { action: "get", workflowId } }),

  /** 获取版本历史 */
  getVersions: (workflowId: string) =>
    request<WorkflowVersionItem[]>("/web/workflow-defs", {
      method: "POST",
      body: { action: "getVersions", workflowId },
    }),

  /** 获取特定版本 YAML */
  getVersion: (workflowId: string, version: number) =>
    request<VersionYamlResponse>("/web/workflow-defs", {
      method: "POST",
      body: { action: "getVersion", workflowId, version },
    }),

  /** 设置 latest 指针（回滚） */
  setLatest: (workflowId: string, version: number) =>
    request<void>("/web/workflow-defs", { method: "POST", body: { action: "setLatest", workflowId, version } }),

  /** 删除工作流 */
  delete: (workflowId: string) =>
    request<void>("/web/workflow-defs", { method: "POST", body: { action: "delete", workflowId } }),

  /** 更新元数据 */
  updateMeta: (workflowId: string, data: { name?: string; description?: string }) =>
    request<WorkflowDefItem>("/web/workflow-defs", {
      method: "POST",
      body: { action: "updateMeta", workflowId, ...data },
    }),

  /** 扫描可恢复的工作流 ID */
  recover: () => request<string[]>("/web/workflow-defs", { method: "POST", body: { action: "recover" } }),

  /** 执行恢复 */
  recoverApply: (workflowIds: string[]) =>
    request<WorkflowDefItem[]>("/web/workflow-defs", { method: "POST", body: { action: "recoverApply", workflowIds } }),

  /** 恢复版本到草稿 */
  restoreToDraft: (workflowId: string, version: number) =>
    request<void>("/web/workflow-defs", { method: "POST", body: { action: "restoreToDraft", workflowId, version } }),

  // ── Triggers ──

  /** 创建 webhook trigger */
  createTrigger: (workflowId: string, type?: string, config?: Record<string, unknown>) =>
    request<TriggerItem>("/web/workflow-defs", {
      method: "POST",
      body: { action: "createTrigger", workflowId, type, config },
    }),

  /** 列出 workflow 的所有 trigger */
  listTriggers: (workflowId: string) =>
    request<TriggerItem[]>("/web/workflow-defs", { method: "POST", body: { action: "listTriggers", workflowId } }),

  /** 删除 trigger */
  deleteTrigger: (triggerId: string) =>
    request<void>("/web/workflow-defs", { method: "POST", body: { action: "deleteTrigger", triggerId } }),

  /** 重新生成 hash */
  regenerateTriggerHash: (triggerId: string) =>
    request<TriggerItem>("/web/workflow-defs", { method: "POST", body: { action: "regenerateHash", triggerId } }),

  /** 启用 trigger */
  enableTrigger: (triggerId: string) =>
    request<void>("/web/workflow-defs", { method: "POST", body: { action: "enableTrigger", triggerId } }),

  /** 禁用 trigger */
  disableTrigger: (triggerId: string) =>
    request<void>("/web/workflow-defs", { method: "POST", body: { action: "disableTrigger", triggerId } }),
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
