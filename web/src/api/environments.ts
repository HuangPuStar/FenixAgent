/**
 * environments.ts — 环境管理 API 模块
 *
 * 封装环境的 CRUD、进入、实例列表等操作。
 * 后端使用 RESTful 风格（GET/POST/PUT/DELETE），域模块内部抽象为具名方法。
 *
 * 对应后端路由：/v1/environments
 */

import { request } from "./request";

/** 环境详情 */
export interface EnvironmentDetail {
  id: string;
  name: string;
  description?: string;
  workspacePath?: string;
  agentConfigId?: string;
  autoStart?: boolean;
  secret?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  /** 其它动态属性 */
  [key: string]: unknown;
}

/** 环境列表项 */
export type EnvironmentListItem = EnvironmentDetail;

/** 创建环境请求体 */
export interface CreateEnvironmentRequest {
  name: string;
  description?: string;
  agentConfigId?: string;
  autoStart?: boolean;
  /** 其它自定义属性 */
  [key: string]: unknown;
}

/** 更新环境请求体 */
export interface UpdateEnvironmentRequest {
  name?: string;
  description?: string;
  agentConfigId?: string;
  autoStart?: boolean;
  /** 其它自定义属性 */
  [key: string]: unknown;
}

/** 进入环境响应 */
export interface EnterEnvironmentResponse {
  environmentId: string;
  instanceId?: string;
  sessionId?: string;
  wsUrl?: string;
  [key: string]: unknown;
}

/** 实例列表项 */
export interface EnvironmentInstanceInfo {
  id: string;
  environmentId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** 实例列表响应 */
export interface EnvironmentInstanceListResult {
  items: EnvironmentInstanceInfo[];
  total: number;
  page: number;
  pageSize: number;
}

export const envApi = {
  /**
   * 获取环境列表。
   * @param params.agentConfigId - 可选，按 Agent 配置筛选
   */
  list: (params?: { agentConfigId?: string }) =>
    request<EnvironmentListItem[]>("/v1/environments", {
      method: "GET",
      query: params?.agentConfigId ? { agentConfigId: params.agentConfigId } : undefined,
    }),

  /** 创建新环境 */
  create: (body: CreateEnvironmentRequest) => request<EnvironmentDetail>("/v1/environments", { method: "POST", body }),

  /** 获取指定环境详情 */
  get: (params: { id: string }) => request<EnvironmentDetail>("/v1/environments/:id", { method: "GET", params }),

  /** 更新指定环境 */
  update: (params: { id: string }, body: UpdateEnvironmentRequest) =>
    request<EnvironmentDetail>("/v1/environments/:id", { method: "PUT", params, body }),

  /** 删除指定环境 */
  del: (params: { id: string }) =>
    request<{ id: string; deleted: boolean }>("/v1/environments/:id", { method: "DELETE", params }),

  /**
   * 进入指定环境，自动 spawn 或复用实例。
   * @param params.id - 环境 ID
   * @param body.instanceNumber - 可选，指定实例编号
   */
  enter: (params: { id: string }, body?: { instance_number?: number }) =>
    request<EnterEnvironmentResponse>("/v1/environments/:id/enter", { method: "POST", params, body }),

  /** 获取指定环境下的实例列表 */
  listInstances: (params: { id: string }) =>
    request<EnvironmentInstanceListResult>("/v1/environments/:id/instances", { method: "GET", params }),
};
