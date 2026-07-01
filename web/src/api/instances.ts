/**
 * instances.ts — Instance 管理 API 模块
 *
 * 封装 Instance 的创建、删除等操作。
 * 后端路由前缀为 /web/instances，返回 snake_case 字段，本模块负责键名转换。
 */

import type { ApiResponse } from "./request";
import { request } from "./request";

/** 单个 Instance 信息（camelCase 转换后） */
export interface InstanceInfo {
  id: string;
  port: number;
  status: string;
  error: string | null;
  groupId: string;
  environmentId: string | null;
  sessionId: string | null;
  instanceNumber: number;
  createdAt: number;
  [key: string]: unknown;
}

// ── snake_case → camelCase 键名映射 ──

function toCamelKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

async function camelResponse<T>(resp: Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  const r = await resp;
  if (r.success && r.data && typeof r.data === "object" && !Array.isArray(r.data)) {
    r.data = toCamelKeys(r.data as Record<string, unknown>) as unknown as T;
  }
  return r;
}

export const instanceApi = {
  /** 从环境启动新实例（POST /web/instances/from-environment） */
  spawn: (body: { environmentId: string }) =>
    camelResponse(request<InstanceInfo>("/web/instances/from-environment", { method: "POST", body })),

  /** 停止并删除指定实例（DELETE /web/instances/:id） */
  del: (params: { id: string }) => request<void>("/web/instances/:id", { method: "DELETE", params: { id: params.id } }),

  /** 停止并删除指定实例（别名） */
  delete: (params: { id: string }) =>
    request<void>("/web/instances/:id", { method: "DELETE", params: { id: params.id } }),
};
