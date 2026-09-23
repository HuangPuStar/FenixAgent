/**
 * instances.ts — Instance 管理 API 模块
 *
 * 封装 Instance 的创建、删除等操作。
 * 后端路由前缀为 /web/instances，返回 snake_case 字段，本模块负责键名转换。
 */

import { camelResponse, request } from "@fenix/web-runtime/api/request";

/** 单个 Instance 信息（camelCase 转换后） */
export interface InstanceInfo {
  instanceUid: string;
  environmentId: string;
  name: string;
  status: string;
  createdAt: string;
}

export const instanceApi = {
  /** 从环境启动新实例（POST /web/instances/from-environment） */
  spawn: (body: { environmentId: string }) =>
    camelResponse(request<InstanceInfo>("/web/instances/from-environment", { method: "POST", body })),

  /** 停止 runtime，保留持久 Instance（POST /web/instances/:id/stop） */
  stop: (params: { id: string }) =>
    request<void>("/web/instances/:id/stop", { method: "POST", params: { id: params.id } }),

  /** 使用同一持久 Instance uid 重启 runtime（POST /web/instances/:id/restart） */
  restart: (params: { id: string }) =>
    request<void>("/web/instances/:id/restart", { method: "POST", params: { id: params.id } }),

  /** 停止并删除指定实例（DELETE /web/instances/:id） */
  del: (params: { id: string }) => request<void>("/web/instances/:id", { method: "DELETE", params: { id: params.id } }),

  /** 停止并删除指定实例（别名） */
  delete: (params: { id: string }) =>
    request<void>("/web/instances/:id", { method: "DELETE", params: { id: params.id } }),
};
