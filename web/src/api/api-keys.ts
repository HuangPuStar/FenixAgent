/**
 * api-keys.ts — API Key 管理域 API 模块
 *
 * 封装 API Key 的 CRUD 操作，统一通过 request() 与后端 RESTful 接口通信。
 */

import { request } from "./request";

/** API Key 基本信息 */
export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

/** 创建 API Key 请求体 */
export interface ApiKeyCreateBody {
  name: string;
  /** 过期时间（秒），不传则永不过期 */
  expiresIn?: number;
}

/** 更新 API Key 请求体（部分字段可选） */
export type ApiKeyUpdateBody = Partial<ApiKeyCreateBody>;

export const apiKeyApi = {
  /** 获取当前组织下所有 API Key 列表 */
  list: () => request<ApiKeyInfo[]>("/web/auth/apikeys", { method: "GET" }),

  /** 创建新的 API Key，返回包含明文 key 的完整信息 */
  create: (body: ApiKeyCreateBody) =>
    request<{ key: string } & ApiKeyInfo>("/web/auth/apikeys", { method: "POST", body }),

  /** 删除指定 API Key */
  del: (id: string) => request<void>("/web/auth/apikeys/:id", { method: "DELETE", params: { id } }),

  /** 更新指定 API Key 的名称或过期时间 */
  update: (id: string, data: ApiKeyUpdateBody) =>
    request<ApiKeyInfo>("/web/auth/apikeys/:id", { method: "PUT", params: { id }, body: data }),
};
