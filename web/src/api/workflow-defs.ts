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

import { client, unwrapEden } from "./client";

// ── API Methods ──

export const workflowDefApi = {
  /** 创建工作流 */
  async create(name: string, description?: string): Promise<WorkflowDefItem> {
    const res = await client.web.workflowDefs.post({ action: "create", name, description });
    return unwrapEden<WorkflowDefItem>(res);
  },

  /** 保存草稿 */
  async save(workflowId: string, yaml: string): Promise<void> {
    const res = await client.web.workflowDefs.post({ action: "save", workflowId, yaml });
    unwrapEden(res);
  },

  /** 发布版本 */
  async publish(workflowId: string): Promise<WorkflowVersionItem> {
    const res = await client.web.workflowDefs.post({ action: "publish", workflowId });
    return unwrapEden<WorkflowVersionItem>(res);
  },

  /** 列出工作流 */
  async list(): Promise<WorkflowDefItem[]> {
    const res = await client.web.workflowDefs.post({ action: "list" });
    return unwrapEden<WorkflowDefItem[]>(res);
  },

  /** 获取单个工作流（含草稿内容） */
  async get(workflowId: string): Promise<WorkflowDefItem> {
    const res = await client.web.workflowDefs.post({ action: "get", workflowId });
    return unwrapEden<WorkflowDefItem>(res);
  },

  /** 获取版本历史 */
  async getVersions(workflowId: string): Promise<WorkflowVersionItem[]> {
    const res = await client.web.workflowDefs.post({ action: "getVersions", workflowId });
    return unwrapEden<WorkflowVersionItem[]>(res);
  },

  /** 获取特定版本 YAML */
  async getVersion(workflowId: string, version: number): Promise<VersionYamlResponse> {
    const res = await client.web.workflowDefs.post({ action: "getVersion", workflowId, version });
    return unwrapEden<VersionYamlResponse>(res);
  },

  /** 设置 latest 指针（回滚） */
  async setLatest(workflowId: string, version: number): Promise<void> {
    const res = await client.web.workflowDefs.post({ action: "setLatest", workflowId, version });
    unwrapEden(res);
  },

  /** 删除工作流 */
  async delete(workflowId: string): Promise<void> {
    const res = await client.web.workflowDefs.post({ action: "delete", workflowId });
    unwrapEden(res);
  },

  /** 更新元数据 */
  async updateMeta(workflowId: string, data: { name?: string; description?: string }): Promise<WorkflowDefItem> {
    const res = await client.web.workflowDefs.post({ action: "updateMeta", workflowId, ...data });
    return unwrapEden<WorkflowDefItem>(res);
  },

  /** 扫描可恢复的工作流 ID */
  async recover(): Promise<string[]> {
    const res = await client.web.workflowDefs.post({ action: "recover" });
    return unwrapEden<string[]>(res);
  },

  /** 执行恢复 */
  async recoverApply(workflowIds: string[]): Promise<WorkflowDefItem[]> {
    const res = await client.web.workflowDefs.post({ action: "recoverApply", workflowIds });
    return unwrapEden<WorkflowDefItem[]>(res);
  },

  /** 恢复版本到草稿 */
  async restoreToDraft(workflowId: string, version: number): Promise<void> {
    const res = await client.web.workflowDefs.post({ action: "restoreToDraft", workflowId, version });
    unwrapEden(res);
  },
};
