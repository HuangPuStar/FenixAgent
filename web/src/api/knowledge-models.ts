/**
 * Embedding 模型管理 API 客户端。
 *
 * 统一通过 POST /web/knowledgeBases/models 的 action 分发。
 * 分层功能已移除，始终使用全局 RAGFlow 租户。
 */
import { request } from "./request";

export const embeddingModelApi = {
  /** 列出已配置的模型供应商树 */
  list: () =>
    request<unknown[]>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "list" },
    }),

  /** 列出可用厂商 */
  listFactories: () =>
    request<unknown[]>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "list-factories" },
    }),

  /** 验证厂商 API Key */
  verify: (body: { provider: string; providerApiKey: string; baseUrl?: string | null }) =>
    request<unknown>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "verify", ...body },
    }),

  /** 列出厂商模型库 */
  listProviderModels: (body: { provider: string; providerApiKey: string; baseUrl?: string | null }) =>
    request<unknown[]>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "list-provider-models", ...body },
    }),

  /** 列出实例下的模型 */
  listInstanceModels: (body: { provider: string; instanceName: string }) =>
    request<unknown[]>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "list-instance-models", ...body },
    }),

  /** 添加模型供应商 */
  add: (body: { provider: string; instanceName: string; providerApiKey: string; baseUrl?: string | null }) =>
    request<{ instanceName: string }>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "add", ...body },
    }),

  /** 删除一个 provider 实例 */
  delete: (body: { provider: string; instanceName: string }) =>
    request<{ ok: boolean }>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "delete", ...body },
    }),

  /** 切换模型 active/inactive 状态 */
  setModelStatus: (body: {
    provider: string;
    instanceName: string;
    modelName: string;
    status: "active" | "inactive";
  }) =>
    request<{ ok: boolean }>("/web/knowledgeBases/models", {
      method: "POST",
      body: { action: "set-model-status", ...body },
    }),
};
