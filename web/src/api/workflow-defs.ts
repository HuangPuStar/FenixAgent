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

import { workflowDefApi as _sdkDefApi } from "./sdk";

// ── API Methods ──

export const workflowDefApi = {
  /** 创建工作流 */
  async create(name: string, description?: string): Promise<WorkflowDefItem> {
    return _sdkDefApi.create({ name, description }).then(({ data, error }) => {
      if (error) throw new Error(error.message);
      return data as WorkflowDefItem;
    });
  },

  /** 保存草稿 */
  async save(workflowId: string, yaml: string): Promise<void> {
    const { error } = await _sdkDefApi.save(workflowId, yaml);
    if (error) throw new Error(error.message);
  },

  /** 发布版本 */
  async publish(workflowId: string): Promise<WorkflowVersionItem> {
    return _sdkDefApi.publish(workflowId).then(({ data, error }) => {
      if (error) throw new Error(error.message);
      return data as WorkflowVersionItem;
    });
  },

  /** 列出工作流 */
  async list(): Promise<WorkflowDefItem[]> {
    return _sdkDefApi.list().then(({ data, error }) => {
      if (error) throw new Error(error.message);
      return (data ?? []) as WorkflowDefItem[];
    });
  },

  /** 获取单个工作流（含草稿内容） */
  async get(workflowId: string): Promise<WorkflowDefItem> {
    return _sdkDefApi.get(workflowId).then(({ data, error }) => {
      if (error) throw new Error(error.message);
      return data as WorkflowDefItem;
    });
  },

  /** 获取版本历史 */
  async getVersions(workflowId: string): Promise<WorkflowVersionItem[]> {
    return _sdkDefApi.getVersions(workflowId).then(({ data, error }) => {
      if (error) throw new Error(error.message);
      return (data ?? []) as WorkflowVersionItem[];
    });
  },

  /** 获取特定版本 YAML */
  async getVersion(workflowId: string, version: number): Promise<VersionYamlResponse> {
    return _sdkDefApi.getVersion(workflowId, version).then(({ data, error }) => {
      if (error) throw new Error(error.message);
      return data as VersionYamlResponse;
    });
  },

  /** 设置 latest 指针（回滚） */
  async setLatest(workflowId: string, version: number): Promise<void> {
    const { error } = await _sdkDefApi.setLatest(workflowId, version);
    if (error) throw new Error(error.message);
  },

  /** 删除工作流 */
  async delete(workflowId: string): Promise<void> {
    const { error } = await _sdkDefApi.delete(workflowId);
    if (error) throw new Error(error.message);
  },

  /** 更新元数据 */
  async updateMeta(workflowId: string, data: { name?: string; description?: string }): Promise<WorkflowDefItem> {
    return _sdkDefApi.updateMeta(workflowId, data).then(({ data: d, error }) => {
      if (error) throw new Error(error.message);
      return d as WorkflowDefItem;
    });
  },

  /** 扫描可恢复的工作流 ID */
  async recover(): Promise<string[]> {
    const { data, error } = await _sdkDefApi.recover();
    if (error) throw new Error(error.message);
    return (data ?? []) as string[];
  },

  /** 执行恢复 */
  async recoverApply(workflowIds: string[]): Promise<WorkflowDefItem[]> {
    const { data, error } = await _sdkDefApi.recoverApply(workflowIds);
    if (error) throw new Error(error.message);
    return (data ?? []) as WorkflowDefItem[];
  },

  /** 恢复版本到草稿 */
  async restoreToDraft(workflowId: string, version: number): Promise<void> {
    const { error } = await _sdkDefApi.restoreToDraft(workflowId, version);
    if (error) throw new Error(error.message);
  },
};
