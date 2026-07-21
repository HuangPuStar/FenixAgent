/**
 * providers.ts — Provider 配置域 API 模块
 *
 * 封装 LLM Provider 的 CRUD、模型管理、模型列表获取与模型测试等操作。
 * 后端使用 REST + query-param 风格端点以支持含 / 的 resource key。
 */

import type { ProviderDetail, ProviderInfo } from "../../src/types/config";
import { request } from "./request";

/** 列表响应：后端返回 providers 数组 */
interface ProviderListResult {
  providers: ProviderInfo[];
}

/** 创建/更新响应 */
interface ProviderSaveResult {
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

/** 构建 provider name 查询参数 */
function withName(name: string): { query: { name: string } } {
  return { query: { name } };
}

export const providerApi = {
  /** 获取 Provider 列表（无 name 参数）或单个 Provider 详情（有 name 参数） */
  list: () => request<ProviderListResult>("/web/config/providers"),

  /** 获取单个 Provider 详情（支持含 / 的 resource key） */
  get: (name: string) => request<ProviderDetail>("/web/config/providers", { method: "GET", ...withName(name) }),

  /** 更新已有 Provider（支持含 / 的 resource key） */
  update: (name: string, data: ProviderData) =>
    request<ProviderSaveResult>("/web/config/providers", {
      method: "PUT",
      ...withName(name),
      body: data,
    }),

  /**
   * 创建新 Provider。
   * 同名已存在时返回 409，调用方应检查错误码后通过 update() 重试。
   */
  create: (name: string, data: ProviderData) =>
    request<ProviderSaveResult>("/web/config/providers", {
      method: "POST",
      body: { name, ...data },
    }),

  /**
   * 创建或更新 Provider 配置（upsert）。
   * 先尝试 PUT（更新已有 provider），不存在时回退到 POST（新建）。
   */
  set: async (name: string, data: ProviderData) => {
    const putResult = await request<ProviderSaveResult>("/web/config/providers", {
      method: "PUT",
      ...withName(name),
      body: data,
    });
    if (putResult.success) return putResult;
    // 非 404 错误直接返回，不做 POST 回退
    if (putResult.error?.code !== "NOT_FOUND") return putResult;
    // 新建：POST 携带 name 标识符
    return request<ProviderSaveResult>("/web/config/providers", {
      method: "POST",
      body: { name, ...data },
    });
  },

  /** 获取 Provider 模型列表，可选传入内联配置参数（支持含 / 的 resource key） */
  fetchModels: (name: string, inline?: { apiKey?: string; baseURL?: string; protocol?: string }) =>
    request<ProviderFetchModelsResult>("/web/config/providers/actions/fetch-models", {
      method: "POST",
      ...withName(name),
      body: inline ?? {},
    }),

  /** 测试指定 Provider 下某个模型的连通性（支持含 / 的 resource key） */
  testModel: (name: string, modelId: string) =>
    request<ModelTestResult>("/web/config/providers/actions/test-model", {
      method: "POST",
      ...withName(name),
      body: { modelId },
    }),

  /** 删除 Provider（支持含 / 的 resource key） */
  del: (name: string) => request<void>("/web/config/providers", { method: "DELETE", ...withName(name) }),

  /** 为 Provider 添加模型（支持含 / 的 resource key） */
  addModel: (name: string, modelData: ModelData) =>
    request<ModelActionResult>("/web/config/providers/actions/models", {
      method: "POST",
      ...withName(name),
      body: modelData,
    }),

  /** 更新 Provider 下的某个模型配置（支持含 / 的 resource key） */
  updateModel: (name: string, modelId: string, modelData: ModelData) =>
    request<ModelActionResult>(`/web/config/providers/actions/models/${encodeURIComponent(modelId)}`, {
      method: "PUT",
      ...withName(name),
      body: modelData,
    }),

  /** 删除 Provider 下的某个模型（支持含 / 的 resource key） */
  removeModel: (name: string, modelId: string) =>
    request<ModelActionResult>(`/web/config/providers/actions/models/${encodeURIComponent(modelId)}`, {
      method: "DELETE",
      ...withName(name),
    }),

  /** 查询 LiteLLM 服务可用状态 */
  getLitellmStatus: () => request<{ configured: boolean; available: boolean }>("/web/config/litellm/status"),
};
