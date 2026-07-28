/**
 * knowledge-models.ts — 模型供应商管理 API
 *
 * 统一通过 POST /web/knowledgeBases/models 的 action 分发，调用对应 RAGFlow
 * 租户的模型 API。
 *
 * RAGFlow v0.26 模型管理的真实结构是三级：供应商(provider) → 实例(instance，
 * 即一组 API Key) → 模型(model)。模型只能 active/inactive 切换（PATCH），无法
 * 单独删除；删除粒度是「实例」。因此本 API 的 list 返回三级树，delete 按
 * 实例删除，setModelStatus 用于屏蔽/取消屏蔽单个模型。
 */
import type {
  ConfiguredProviderNode,
  EmbeddingFactoryOption,
  InstanceModelOption,
  ProviderModelOption,
} from "../types/knowledge";
import { request } from "./request";

export interface VerifyResult {
  success: boolean;
  message?: string;
}

export interface AddProviderResult {
  instanceName: string;
}

export const embeddingModelApi = {
  /** 列出已配置的模型供应商三级树（provider→instance→models，含每个模型 active/inactive） */
  list: () =>
    request<ConfiguredProviderNode[]>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "list" },
    }),

  /** 列出可用厂商（系统目录，添加供应商时选） */
  listFactories: () =>
    request<EmbeddingFactoryOption[]>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "list-factories" },
    }),

  /** 验证厂商 API Key */
  verify: (body: { provider: string; providerApiKey: string; baseUrl?: string | null }) =>
    request<VerifyResult>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "verify", ...body },
    }),

  /** 动态列出厂商的模型库（添加供应商前的预览，需 api_key 临时访问） */
  listProviderModels: (body: { provider: string; providerApiKey: string; baseUrl?: string | null }) =>
    request<ProviderModelOption[]>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "list-provider-models", ...body },
    }),

  /** 按需懒加载某实例下的模型列表（展开实例节点时调用，含 active/inactive 状态） */
  listInstanceModels: (body: { provider: string; instanceName: string }) =>
    request<InstanceModelOption[]>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "list-instance-models", ...body },
    }),

  /** 添加一个模型供应商实例（创建实例，该厂商目录下所有模型自动可用） */
  add: (body: { provider: string; instanceName: string; providerApiKey: string; baseUrl?: string | null }) =>
    request<AddProviderResult>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "add", ...body },
    }),

  /** 删除一个 provider 实例（含其下所有模型配置） */
  delete: (body: { provider: string; instanceName: string }) =>
    request<{ ok: true }>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "delete", ...body },
    }),

  /** 切换实例下单个模型的 active/inactive 状态（屏蔽/取消屏蔽模型） */
  setModelStatus: (body: {
    provider: string;
    instanceName: string;
    modelName: string;
    status: "active" | "inactive";
  }) =>
    request<{ ok: true }>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "set-model-status", ...body },
    }),
};
