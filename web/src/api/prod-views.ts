/**
 * prod-views.ts — ProdView 发布视图域 API 模块
 *
 * 封装 ProdView 的 CRUD 及视图加载操作。
 * 管理端端点: /web/config/prod-views
 * 视图加载端点: /web/prod-views/:id/load
 */

import { request } from "./request";

export interface ProdViewModuleConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface ProdViewModulesConfig {
  chatHeader?: ProdViewModuleConfig;
  sessionSidebar?: ProdViewModuleConfig;
  chatView?: ProdViewModuleConfig;
  chatComposer?: ProdViewModuleConfig;
  permissionPanel?: ProdViewModuleConfig;
  todoPanel?: ProdViewModuleConfig;
  contextPanel?: ProdViewModuleConfig;
  toolCallRow?: ProdViewModuleConfig;
}

export interface ProdViewInfo {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  agentId: string;
  modulesConfig: ProdViewModulesConfig;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProdViewLoadData {
  agentId: string;
  name: string;
  modulesConfig: ProdViewModulesConfig;
}

export const prodViewApi = {
  /** 获取 ProdView 列表，可选按 agentId / enabled 过滤 */
  list: (params?: { agentId?: string; enabled?: boolean }) =>
    request<ProdViewInfo[]>("/web/config/prod-views", {
      method: "GET",
      query: params,
    }),

  /** 获取单个 ProdView 详情 */
  get: (id: string) => request<ProdViewInfo>(`/web/config/prod-views/${id}`, { method: "GET" }),

  /** 创建 ProdView */
  create: (data: { name: string; agentId: string; description?: string }) =>
    request<ProdViewInfo>("/web/config/prod-views", {
      method: "POST",
      body: data,
    }),

  /** 更新 ProdView */
  update: (
    id: string,
    data: {
      name?: string;
      description?: string;
      modulesConfig?: ProdViewModulesConfig;
      enabled?: boolean;
    },
  ) =>
    request<ProdViewInfo>(`/web/config/prod-views/${id}`, {
      method: "PUT",
      body: data,
    }),

  /** 删除 ProdView */
  del: (id: string) =>
    request<{ ok: boolean }>(`/web/config/prod-views/${id}`, {
      method: "DELETE",
    }),

  /** 加载 ProdView 配置（公开端点） */
  load: (id: string) =>
    request<ProdViewLoadData>(`/web/prod-views/${id}/load`, {
      method: "GET",
    }),
};
