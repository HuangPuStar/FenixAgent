/**
 * api-keys.ts — API Key 管理域 API 模块
 *
 * 封装 API Key 的 CRUD 操作。
 * 后端使用 REST 风格的 /web/api-keys 路由（GET/POST/DELETE/PUT），
 * 旧的 POST /web/apiKeys action 分发端点保留兼容。
 */

import { request } from "./request";

/** API Key 基本信息 */
export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  /** 创建时间，后端 FlexibleDateTimeSchema 序列化为时间戳或 ISO 字符串 */
  createdAt: number | string;
  /** 过期时间，为空表示不过期 */
  expiresAt: number | string | null;
  /** 最后使用时间，未使用过时为空 */
  lastUsedAt: number | string | null;
  /** API Key 扩展元数据 */
  metadata?: unknown;
}

/** 创建 API Key 请求体 */
export interface ApiKeyCreateBody {
  name: string;
  /** 过期时间，ISO 日期字符串 */
  expiresAt?: string;
}

/** 更新 API Key 请求体 */
export interface ApiKeyUpdateBody {
  name?: string;
}

export const apiKeyApi = {
  /** 获取当前组织下所有 API Key 列表 */
  list: () => request<ApiKeyInfo[]>("/web/api-keys", { method: "GET" }),

  /** 创建新的 API Key，返回包含明文 key 的完整信息 */
  create: (body: ApiKeyCreateBody) =>
    request<{ key: string } & ApiKeyInfo>("/web/api-keys", {
      method: "POST",
      body: { name: body.name, expiresAt: body.expiresAt },
    }),

  /** 删除指定 API Key */
  del: (id: string) =>
    request<void>("/web/api-keys/:id", {
      method: "DELETE",
      params: { id },
    }),

  /** 更新指定 API Key 的名称 */
  update: (id: string, data: ApiKeyUpdateBody) =>
    request<void>("/web/api-keys/:id", {
      method: "PUT",
      params: { id },
      body: { name: data.name },
    }),
};
