/**
 * api-keys.ts — API Key 管理域 API 模块
 *
 * 封装 API Key 的 CRUD 操作。
 * 后端使用 POST /web/apiKeys 的 action 分发模式，域模块内部抽象为具名方法。
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
  list: () =>
    request<ApiKeyInfo[]>("/web/apiKeys", {
      method: "POST",
      body: { action: "list" },
    }),

  /** 创建新的 API Key，返回包含明文 key 的完整信息 */
  create: (body: ApiKeyCreateBody) =>
    request<{ key: string } & ApiKeyInfo>("/web/apiKeys", {
      method: "POST",
      body: { action: "create", name: body.name, expiresAt: body.expiresAt },
    }),

  /** 删除指定 API Key */
  del: (id: string) =>
    request<void>("/web/apiKeys", {
      method: "POST",
      body: { action: "delete", id },
    }),

  /** 更新指定 API Key 的名称。后端返回 { success: true } 无 data 字段 */
  update: (id: string, data: ApiKeyUpdateBody) =>
    request<void>("/web/apiKeys", {
      method: "POST",
      body: { action: "update", id, name: data.name },
    }),
};
