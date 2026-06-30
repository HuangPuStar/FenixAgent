/**
 * Workflow API 模块（RESTful 风格）。
 *
 * 对照后端 RESTful 路由，通过 HTTP 方法和资源路径表达操作语义。
 * 不再使用单一 POST + action 字段的分发模式。
 *
 * 类型定义同步于 packages/sdk/src/modules/workflow-defs.ts 的 WorkflowDefApi 方法签名。
 */

import { request } from "./request";

// ── 类型定义（与现有 workflow-defs.ts 共享，此处按需重导出或内联） ──

/** 工作流定义列表项 */
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

/** 工作流版本记录 */
export interface WorkflowVersionItem {
  id: string;
  workflowId: string;
  version: number;
  filePath: string;
  status: string;
  createdBy: string;
  createdAt: string;
}

/** 版本 YAML 响应 */
export interface VersionYamlResponse {
  workflowId: string;
  version: number;
  yaml: string;
}

// ── API Client ──

export const workflowApi = {
  /** 创建工作流定义 */
  create: (body: Record<string, unknown>) => request<WorkflowDefItem>("/web/workflow-defs", { method: "POST", body }),

  /** 保存工作流 YAML 草稿 */
  save: (workflowId: string, yaml: string) =>
    request<void>(`/web/workflow-defs/${workflowId}`, {
      method: "PUT",
      body: { yaml },
    }),

  /** 发布工作流版本 */
  publish: (workflowId: string) =>
    request<WorkflowVersionItem>(`/web/workflow-defs/${workflowId}/publish`, {
      method: "POST",
    }),

  /** 列出当前组织下所有工作流定义 */
  list: () => request<WorkflowDefItem[]>("/web/workflow-defs", { method: "GET" }),

  /** 获取单个工作流详情（含草稿 YAML） */
  get: (workflowId: string) => request<WorkflowDefItem>(`/web/workflow-defs/${workflowId}`, { method: "GET" }),

  /** 获取工作流的所有版本历史 */
  getVersions: (workflowId: string) =>
    request<WorkflowVersionItem[]>(`/web/workflow-defs/${workflowId}/versions`, { method: "GET" }),

  /** 获取指定版本的 YAML 内容 */
  getVersion: (workflowId: string, version: number) =>
    request<VersionYamlResponse>(`/web/workflow-defs/${workflowId}/versions/${version}`, { method: "GET" }),

  /** 将指定版本设为最新（回滚操作） */
  setLatest: (workflowId: string, version: number) =>
    request<void>(`/web/workflow-defs/${workflowId}/versions/${version}/set-latest`, {
      method: "POST",
    }),

  /** 删除工作流定义 */
  del: (workflowId: string) => request<void>(`/web/workflow-defs/${workflowId}`, { method: "DELETE" }),

  /** 更新工作流元数据（名称、描述） */
  updateMeta: (workflowId: string, data: { name?: string; description?: string }) =>
    request<WorkflowDefItem>(`/web/workflow-defs/${workflowId}/meta`, {
      method: "PUT",
      body: data,
    }),

  /** 将指定版本恢复为当前草稿 */
  restoreToDraft: (workflowId: string, version: number) =>
    request<void>(`/web/workflow-defs/${workflowId}/versions/${version}/restore`, {
      method: "POST",
    }),

  /** 扫描可恢复的工作流 ID 列表 */
  recover: () => request<string[]>("/web/workflow-defs/recover", { method: "POST" }),

  /** 确认恢复选中的工作流 */
  recoverApply: (workflowIds: string[]) =>
    request<WorkflowDefItem[]>("/web/workflow-defs/recover/apply", {
      method: "POST",
      body: { workflowIds },
    }),
};
