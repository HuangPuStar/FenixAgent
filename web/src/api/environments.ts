/**
 * environments.ts — 环境管理 API 模块
 *
 * 封装环境的 CRUD、进入、实例列表等操作。
 * 后端路由前缀为 /web/environments，返回 snake_case 字段，本模块负责键名转换。
 */

import type { ApiResponse } from "./request";
import { request } from "./request";

/** 环境详情 */
export interface EnvironmentDetail {
  id: string;
  name: string;
  description?: string | null;
  workspacePath?: string;
  agentConfigId?: string | null;
  autoStart?: boolean;
  secret?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  instanceId?: string | null;
  instanceStatus?: string | null;
  sessionId?: string | null;
  agentName?: string | null;
  machineName?: string | null;
  branch?: string | null;
  instancesCount?: number;
  instances?: EnvironmentInstanceInfo[];
  lastPollAt?: number | null;
  [key: string]: unknown;
}

/** 环境列表项 */
export type EnvironmentListItem = EnvironmentDetail;

/** 创建环境请求体 */
export interface CreateEnvironmentRequest {
  name: string;
  description?: string;
  agentConfigId: string;
  autoStart?: boolean;
  [key: string]: unknown;
}

/** 更新环境请求体 */
export interface UpdateEnvironmentRequest {
  name?: string;
  description?: string;
  agentConfigId?: string;
  autoStart?: boolean;
  [key: string]: unknown;
}

/** 进入环境响应（camelCase 转换后） */
export interface EnterEnvironmentResponse {
  environmentId: string;
  instanceId: string;
  instanceNumber: number;
  instanceStatus: string;
  sessionId: string | null;
  [key: string]: unknown;
}

/** 实例列表项（来自 GET /web/environments/:id/instances） */
export interface EnvironmentInstanceInfo {
  id: string;
  instanceNumber: number;
  status: string;
  sessionId?: string | null;
  port?: number;
  createdAt?: number;
  [key: string]: unknown;
}

/** 实例列表响应（camelCase 转换后） */
export interface EnvironmentInstanceListResult {
  environmentId: string;
  instances: EnvironmentInstanceInfo[];
}

// ── snake_case → camelCase 键名映射 ──

/** 将后端返回的 snake_case 键名转换为 camelCase */
function toCamelKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    // 递归转换嵌套对象（如 instances 数组中的对象）
    if (Array.isArray(value)) {
      result[camelKey] = value.map((item) =>
        item && typeof item === "object" ? toCamelKeys(item as Record<string, unknown>) : item,
      );
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

/** 将完整响应中的 data 字段进行键名转换 */
async function camelResponse<T>(resp: Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  const r = await resp;
  if (r.success && r.data) {
    if (Array.isArray(r.data)) {
      r.data = r.data.map((item) =>
        item && typeof item === "object" ? toCamelKeys(item as Record<string, unknown>) : item,
      ) as unknown as T;
    } else if (typeof r.data === "object") {
      r.data = toCamelKeys(r.data as Record<string, unknown>) as unknown as T;
    }
  }
  return r;
}

export const envApi = {
  /** 获取环境列表 */
  list: (params?: { agentConfigId?: string }) =>
    camelResponse(
      request<EnvironmentListItem[]>("/web/environments", {
        method: "GET",
        query: params?.agentConfigId ? { agentConfigId: params.agentConfigId } : undefined,
      }),
    ),

  /** 创建新环境 */
  create: (body: CreateEnvironmentRequest) =>
    camelResponse(request<EnvironmentDetail>("/web/environments", { method: "POST", body })),

  /** 获取指定环境详情 */
  get: (params: { id: string }) =>
    camelResponse(request<EnvironmentDetail>("/web/environments/:id", { method: "GET", params })),

  /** 更新指定环境 */
  update: (params: { id: string }, body: UpdateEnvironmentRequest) =>
    camelResponse(request<EnvironmentDetail>("/web/environments/:id", { method: "PUT", params, body })),

  /** 删除指定环境 */
  del: (params: { id: string }) => camelResponse(request<void>("/web/environments/:id", { method: "DELETE", params })),

  /**
   * 进入指定环境，自动 spawn 或复用实例。
   * @param params.id - 环境 ID
   * @param body.instance_number - 可选，指定实例编号
   */
  enter: (params: { id: string }, body?: { instance_number?: number }) =>
    camelResponse(request<EnterEnvironmentResponse>("/web/environments/:id/enter", { method: "POST", params, body })),

  /** 获取指定环境下的实例列表 */
  listInstances: (params: { id: string }) =>
    camelResponse(request<EnvironmentInstanceListResult>("/web/environments/:id/instances", { method: "GET", params })),
};
