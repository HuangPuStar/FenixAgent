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

// ── API Client ──

import { apiPost } from "./client";

// ── API Methods ──

export const workflowDefApi = {
  /** 创建工作流 */
  async create(name: string, description?: string): Promise<WorkflowDefItem> {
    return apiPost<WorkflowDefItem>("/web/workflow-defs", { action: "create", name, description });
  },

  /** 保存草稿 */
  async save(workflowId: string, yaml: string): Promise<void> {
    await apiPost("/web/workflow-defs", { action: "save", workflowId, yaml });
  },

  /** 发布版本 */
  async publish(workflowId: string): Promise<WorkflowVersionItem> {
    return apiPost<WorkflowVersionItem>("/web/workflow-defs", { action: "publish", workflowId });
  },

  /** 列出工作流 */
  async list(): Promise<WorkflowDefItem[]> {
    return apiPost<WorkflowDefItem[]>("/web/workflow-defs", { action: "list" });
  },

  /** 获取单个工作流（含草稿内容） */
  async get(workflowId: string): Promise<WorkflowDefItem> {
    return apiPost<WorkflowDefItem>("/web/workflow-defs", { action: "get", workflowId });
  },

  /** 获取版本历史 */
  async getVersions(workflowId: string): Promise<WorkflowVersionItem[]> {
    return apiPost<WorkflowVersionItem[]>("/web/workflow-defs", { action: "getVersions", workflowId });
  },

  /** 获取特定版本 YAML */
  async getVersion(workflowId: string, version: number): Promise<VersionYamlResponse> {
    return apiPost<VersionYamlResponse>("/web/workflow-defs", { action: "getVersion", workflowId, version });
  },

  /** 设置 latest 指针（回滚） */
  async setLatest(workflowId: string, version: number): Promise<void> {
    await apiPost("/web/workflow-defs", { action: "setLatest", workflowId, version });
  },

  /** 删除工作流 */
  async delete(workflowId: string): Promise<void> {
    await apiPost("/web/workflow-defs", { action: "delete", workflowId });
  },

  /** 更新元数据 */
  async updateMeta(workflowId: string, data: { name?: string; description?: string }): Promise<WorkflowDefItem> {
    return apiPost<WorkflowDefItem>("/web/workflow-defs", { action: "updateMeta", workflowId, ...data });
  },

  /** 扫描可恢复的工作流 ID */
  async recover(): Promise<string[]> {
    return apiPost<string[]>("/web/workflow-defs", { action: "recover" });
  },

  /** 执行恢复 */
  async recoverApply(workflowIds: string[]): Promise<WorkflowDefItem[]> {
    return apiPost<WorkflowDefItem[]>("/web/workflow-defs", { action: "recoverApply", workflowIds });
  },

  /** 恢复版本到草稿 */
  async restoreToDraft(workflowId: string, version: number): Promise<void> {
    await apiPost("/web/workflow-defs", { action: "restoreToDraft", workflowId, version });
  },
};
