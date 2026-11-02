/**
 * providers.ts — Provider 配置域 API 模块
 *
 * 封装 LLM Provider 的 CRUD、模型管理、模型列表获取与模型测试等操作。
 * 已有资源通过 ID 路径定位，创建时显式提交配置名。
 */

import { request } from "@fenix/web-runtime/api/request";
import type { ProviderDetail, ProviderInfo } from "@fenix/web-runtime/types/config";

/** 列表响应：后端返回 providers 数组 */
interface ProviderListResult {
  providers: ProviderInfo[];
}

/** 创建/更新响应 */
interface ProviderSaveResult {
  id: string;
  name: string;
}

/** 获取模型列表响应 */
interface ProviderFetchModelsResult {
  models: string[];
}

/** 模型连通性测试响应 */
interface ModelTestResult {
  ok: boolean;
  content: string;
}

/** 模型操作（增/删/改）响应 */
interface ModelActionResult {
  id: string;
  modelId: string;
}

/** Provider 配置数据 */
interface ProviderData {
  protocol?: string;
  apiKey?: string;
  baseURL?: string;
  [key: string]: unknown;
}

/** 模型配置数据 */
interface ModelData {
  modelId?: string;
  name?: string;
  modalities?: unknown;
  limit?: unknown;
  cost?: unknown;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Provider 与 Model 的控制台 REST 客户端；ID 始终为数据库资源 ID。 */
export const providerApi = {
  list: () => request<ProviderListResult>("/web/config/providers"),
  get: (providerId: string) => request<ProviderDetail>("/web/config/providers/:providerId", { params: { providerId } }),
  create: (name: string, data: ProviderData) =>
    request<ProviderSaveResult>("/web/config/providers", { method: "POST", body: { ...data, name } }),
  update: (providerId: string, data: ProviderData) =>
    request<ProviderSaveResult>("/web/config/providers/:providerId", {
      method: "PATCH",
      params: { providerId },
      body: data,
    }),
  del: (providerId: string) =>
    request<void>("/web/config/providers/:providerId", { method: "DELETE", params: { providerId } }),
  fetchModels: (providerId: string, inline?: { apiKey?: string; baseURL?: string; protocol?: string }) =>
    request<ProviderFetchModelsResult>("/web/config/providers/:providerId/fetch-models", {
      method: "POST",
      params: { providerId },
      body: inline ?? {},
    }),
  probeModels: (inline: { apiKey?: string; baseURL?: string; protocol?: string }) =>
    request<ProviderFetchModelsResult>("/web/config/providers/probe-models", { method: "POST", body: inline }),
  testModel: (providerId: string, id: string) =>
    request<ModelTestResult>("/web/config/providers/:providerId/models/:id/test", {
      method: "POST",
      params: { providerId, id },
    }),
  addModel: (providerId: string, data: ModelData) =>
    request<ModelActionResult>("/web/config/providers/:providerId/models", {
      method: "POST",
      params: { providerId },
      body: data,
    }),
  updateModel: (providerId: string, id: string, data: ModelData) =>
    request<ModelActionResult>("/web/config/providers/:providerId/models/:id", {
      method: "PATCH",
      params: { providerId, id },
      body: data,
    }),
  removeModel: (providerId: string, id: string) =>
    request<ModelActionResult>("/web/config/providers/:providerId/models/:id", {
      method: "DELETE",
      params: { providerId, id },
    }),
};
