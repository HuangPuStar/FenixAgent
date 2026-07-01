/**
 * Workflow Definition API Client。
 *
 * 对接后端 POST /web/workflow-defs，通过 action 字段分发。
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

import type { ApiResponse } from "./request";
import { request } from "./request";

const ENDPOINT = "/web/workflow-defs";

/** 后端 action 分发公共入口：POST /web/workflow-defs + { action } */
function dispatch<T>(body: Record<string, unknown>): Promise<ApiResponse<T>> {
  return request<T>(ENDPOINT, { method: "POST", body });
}

export const workflowApi = {
  /** 创建工作流定义 */
  create: (name: string, description?: string) => dispatch<WorkflowDefItem>({ action: "create", name, description }),

  /** 保存工作流 YAML 草稿 */
  save: (workflowId: string, yaml: string) => dispatch<void>({ action: "save", workflowId, yaml }),

  /** 发布工作流版本 */
  publish: (workflowId: string) => dispatch<WorkflowVersionItem>({ action: "publish", workflowId }),

  /** 列出当前组织下所有工作流定义 */
  list: () => dispatch<WorkflowDefItem[]>({ action: "list" }),

  /** 获取单个工作流详情（含草稿 YAML） */
  get: (workflowId: string) => dispatch<WorkflowDefItem>({ action: "get", workflowId }),

  /** 获取工作流的所有版本历史 */
  getVersions: (workflowId: string) => dispatch<WorkflowVersionItem[]>({ action: "getVersions", workflowId }),

  /** 获取指定版本的 YAML 内容 */
  getVersion: (workflowId: string, version: number) =>
    dispatch<VersionYamlResponse>({ action: "getVersion", workflowId, version }),

  /** 将指定版本设为最新（回滚操作） */
  setLatest: (workflowId: string, version: number) => dispatch<void>({ action: "setLatest", workflowId, version }),

  /** 删除工作流定义 */
  del: (workflowId: string) => dispatch<void>({ action: "delete", workflowId }),

  /** 更新工作流元数据（名称、描述） */
  updateMeta: (workflowId: string, data: { name?: string; description?: string }) =>
    dispatch<WorkflowDefItem>({ action: "updateMeta", workflowId, ...data }),

  /** 将指定版本恢复为当前草稿 */
  restoreToDraft: (workflowId: string, version: number) =>
    dispatch<void>({ action: "restoreToDraft", workflowId, version }),

  /** 扫描可恢复的工作流 ID 列表 */
  recover: () => dispatch<string[]>({ action: "recover" }),

  /** 确认恢复选中的工作流 */
  recoverApply: (workflowIds: string[]) => dispatch<WorkflowDefItem[]>({ action: "recoverApply", workflowIds }),
};
