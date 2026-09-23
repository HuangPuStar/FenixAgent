/**
 * environments.ts — 环境管理 API 模块
 *
 * 封装环境的 CRUD、进入、实例列表等操作。
 * 后端路由前缀为 /web/environments，返回 snake_case 字段，本模块负责键名转换。
 */

import { camelResponse, request } from "@fenix/web-runtime/api/request";

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
}

/** 环境列表项 */
export type EnvironmentListItem = EnvironmentDetail;

/** 创建环境请求体 */
export interface CreateEnvironmentRequest {
  name: string;
  description?: string;
  agentConfigId: string;
  autoStart?: boolean;
}

/** 更新环境请求体 */
export interface UpdateEnvironmentRequest {
  name?: string;
  description?: string;
  agentConfigId?: string;
  autoStart?: boolean;
}

/** 进入环境响应（camelCase 转换后） */
export interface EnterEnvironmentResponse {
  instanceUid: string;
  environmentId: string;
  name: string;
  status: string;
  createdAt: string;
}

/** 实例列表项（来自 GET /web/environments/:id/instances） */
export interface EnvironmentInstanceInfo {
  instanceUid: string;
  name: string;
  status: string;
  createdAt: string;
}

/** 实例列表响应（camelCase 转换后） */
export interface EnvironmentInstanceListResult {
  environmentId: string;
  instances: EnvironmentInstanceInfo[];
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

  /** 进入指定环境，自动 spawn 或复用实例。 */
  enter: (params: { id: string }, body?: { instanceUid?: string }) =>
    camelResponse(request<EnterEnvironmentResponse>("/web/environments/:id/enter", { method: "POST", params, body })),

  /** 获取指定环境下的实例列表 */
  listInstances: (params: { id: string }) =>
    camelResponse(request<EnvironmentInstanceListResult>("/web/environments/:id/instances", { method: "GET", params })),
};
