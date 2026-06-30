/**
 * instances.ts — Instance 管理 API 模块
 *
 * 封装 Instance 的创建、批量生成、列表查询、删除等操作。
 * 后端使用 RESTful 风格（GET/POST/DELETE），域模块内部抽象为具名方法。
 */

import { request } from "./request";

/** 单个 Instance 信息 */
export interface InstanceInfo {
  id: string;
  environmentId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** 列表响应 */
export interface InstanceListResult {
  items: InstanceInfo[];
  total: number;
  page: number;
  pageSize: number;
}

/** 删除响应 */
export interface InstanceDeleteResult {
  id: string;
  deleted: boolean;
}

export const instanceApi = {
  /** 创建单个 Instance */
  create: (body: Record<string, unknown>) => request<InstanceInfo>("/v2/instances", { method: "POST", body }),

  /** 批量生成 Instance（从 environment 模板 spawn） */
  spawn: (body: Record<string, unknown>) => request<InstanceInfo>("/v2/instances/spawn", { method: "POST", body }),

  /** 获取 Instance 列表 */
  list: () => request<InstanceListResult>("/v2/instances", { method: "GET" }),

  /** 删除指定 Instance */
  del: (params: { instanceId: string }) =>
    request<InstanceDeleteResult>("/v2/instances/:instanceId", { method: "DELETE", params }),

  /** 删除指定 Instance（别名） */
  delete: (params: { id: string }) =>
    request<InstanceDeleteResult>("/v2/instances/:instanceId", { method: "DELETE", params: { instanceId: params.id } }),
};
