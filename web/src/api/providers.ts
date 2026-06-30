/**
 * providers.ts — Provider 配置域 API 模块
 *
 * 封装 LLM Provider 的 CRUD、模型管理、连通性测试等操作。
 * 后端使用 POST /web/config/providers 的 action 分发模式，域模块内部抽象为具名方法。
 */

import type { ProviderDetail, ProviderInfo } from "../../src/types/config";
import { request } from "./request";

/** 列表响应：后端在 data.providers 中返回 Provider 数组 */
interface ProviderListResult {
  providers: ProviderInfo[];
}

/** 创建/更新响应 */
interface ProviderSaveResult {
  name: string;
}

/** 连通性测试响应：后端返回 { models: string[] } */
interface ProviderTestResult {
  models: string[];
}

/** 模型连通性测试响应：后端返回 { ok: boolean; content: string } */
interface ModelTestResult {
  ok: boolean;
  content: string;
}

/** 模型操作（增/删/改）响应：后端返回 { modelId: string } */
interface ModelActionResult {
  modelId: string;
}

/** Provider 配置数据，对应后端 set action 的 data 字段 */
interface ProviderData {
  protocol?: string;
  apiKey?: string;
  baseURL?: string;
}

/** 模型配置数据，对应后端 add_model / update_model action 的 modelData 字段 */
interface ModelData {
  name?: string;
  modalities?: unknown;
  limit?: unknown;
  cost?: unknown;
  options?: Record<string, unknown>;
}

export const providerApi = {
  /** 获取 Provider 列表 */
  list: () => request<ProviderListResult>("/web/config/providers", { method: "POST", body: { action: "list" } }),

  /** 获取单个 Provider 详情（含关联模型列表），后端直接返回 ProviderDetail 字段扁平结构 */
  get: (name: string) =>
    request<ProviderDetail>("/web/config/providers", { method: "POST", body: { action: "get", name } }),

  /** 创建或更新 Provider 配置 */
  set: (name: string, data: ProviderData) =>
    request<ProviderSaveResult>("/web/config/providers", { method: "POST", body: { action: "set", name, data } }),

  /** 测试 Provider 连通性，可选传入内联配置参数（apiKey/baseURL/protocol 直接展开到请求体顶层） */
  test: (name: string, inline?: { apiKey?: string; baseURL?: string; protocol?: string }) =>
    request<ProviderTestResult>("/web/config/providers", {
      method: "POST",
      body: { action: "test", name, ...inline },
    }),

  /** 测试指定 Provider 下某个模型的连通性 */
  testModel: (name: string, modelId: string) =>
    request<ModelTestResult>("/web/config/providers", {
      method: "POST",
      body: { action: "test_model", name, modelId },
    }),

  /** 删除 Provider */
  del: (name: string) => request<void>("/web/config/providers", { method: "POST", body: { action: "delete", name } }),

  /** 为 Provider 添加模型，后端 ConfigBodySchema 识别顶层 data 字段 */
  addModel: (name: string, modelData: ModelData) =>
    request<ModelActionResult>("/web/config/providers", {
      method: "POST",
      body: { action: "add_model", name, data: modelData },
    }),

  /** 更新 Provider 下的某个模型配置，后端 ConfigBodySchema 识别顶层 data 字段 */
  updateModel: (name: string, modelId: string, modelData: ModelData) =>
    request<ModelActionResult>("/web/config/providers", {
      method: "POST",
      body: { action: "update_model", name, modelId, data: modelData },
    }),

  /** 删除 Provider 下的某个模型 */
  removeModel: (name: string, modelId: string) =>
    request<ModelActionResult>("/web/config/providers", {
      method: "POST",
      body: { action: "remove_model", name, modelId },
    }),
};
