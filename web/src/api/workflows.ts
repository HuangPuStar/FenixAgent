/**
 * Workflow Definition API Client。
 *
 * 对接后端 RESTful /web/workflow-defs 端点。
 * 类型定义与 workflow-defs.ts 共享。
 */

// ── 类型定义 ──

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

import { request } from "./request";

const ENDPOINT = "/web/workflow-defs";

export const workflowApi = {
  /** 列出当前组织下所有工作流定义 */
  list: () => request<WorkflowDefItem[]>(ENDPOINT, { method: "GET" }),

  /** 创建工作流定义 */
  create: (name: string, description?: string) =>
    request<WorkflowDefItem>(ENDPOINT, { method: "POST", body: { name, description } }),

  /** 获取单个工作流详情（含草稿 YAML） */
  get: (workflowId: string) => request<WorkflowDefItem>(`${ENDPOINT}/${workflowId}`, { method: "GET" }),

  /** 保存工作流 YAML 草稿 */
  save: (workflowId: string, yaml: string) =>
    request<void>(`${ENDPOINT}/${workflowId}/draft`, { method: "PUT", body: { yaml } }),

  /** 发布工作流版本 */
  publish: (workflowId: string) =>
    request<WorkflowVersionItem>(`${ENDPOINT}/${workflowId}/publish`, { method: "POST" }),

  /** 删除工作流定义 */
  del: (workflowId: string) => request<void>(`${ENDPOINT}/${workflowId}`, { method: "DELETE" }),

  /** 更新工作流元数据（名称、描述） */
  updateMeta: (workflowId: string, data: { name?: string; description?: string }) =>
    request<WorkflowDefItem>(`${ENDPOINT}/${workflowId}`, { method: "PATCH", body: data }),

  /** 获取工作流的所有版本历史 */
  getVersions: (workflowId: string) =>
    request<WorkflowVersionItem[]>(`${ENDPOINT}/${workflowId}/versions`, { method: "GET" }),

  /** 获取指定版本的 YAML 内容 */
  getVersion: (workflowId: string, version: number) =>
    request<VersionYamlResponse>(`${ENDPOINT}/${workflowId}/versions/${version}`, { method: "GET" }),

  /** 将指定版本设为最新（回滚操作） */
  setLatest: (workflowId: string, version: number) =>
    request<void>(`${ENDPOINT}/${workflowId}/versions/${version}/set-latest`, { method: "POST" }),

  /** 将指定版本恢复为当前草稿 */
  restoreToDraft: (workflowId: string, version: number) =>
    request<void>(`${ENDPOINT}/${workflowId}/versions/${version}/restore`, { method: "POST" }),

  /** 扫描可恢复的工作流 ID 列表 */
  recover: () => request<string[]>(`${ENDPOINT}/recoverable`, { method: "GET" }),

  /** 确认恢复选中的工作流 */
  recoverApply: (workflowIds: string[]) =>
    request<WorkflowDefItem[]>(`${ENDPOINT}/recover`, { method: "POST", body: { workflowIds } }),
};
