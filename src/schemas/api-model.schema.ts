import * as z from "zod/v4";
import { AgentResourceAccessSchema } from "./config.schema";

/**
 * Model / Provider 列表查询参数。
 * 对外接口统一保持稳定分页结构。
 */
export const ApiModelListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).describe("页码，从 1 开始。"),
    pageSize: z.coerce.number().int().min(1).max(100).default(20).describe("每页条数，最大 100。"),
  })
  .describe("Model / Provider 列表查询参数。");

/**
 * Provider 路径参数。
 * 对外统一使用 Provider 名称作为标识符。
 */
export const ApiProviderIdParamsSchema = z
  .object({
    providerId: z.string().min(1).describe("Provider 唯一 ID。"),
  })
  .describe("Provider 路径参数。");

/**
 * 仅包含 providerId 的路径参数。
 */
export const ApiProviderOnlyParamsSchema = z
  .object({
    providerId: z.string().min(1).describe("Provider 唯一 ID。"),
  })
  .describe("Provider 子资源路径参数。");

/**
 * Model 路径参数。
 */
export const ApiModelIdParamsSchema = z
  .object({
    providerId: z.string().min(1).describe("Provider 唯一 ID。"),
    id: z.string().min(1).describe("Model 唯一 ID。"),
  })
  .describe("Model 路径参数。");

/**
 * 创建 Provider 请求体。
 */
export const ApiProviderUpsertBodySchema = z
  .object({
    name: z.string().min(1).max(64).describe("Provider 名称，组织内唯一。"),
    displayName: z.string().nullable().optional().describe("Provider 展示名称；传 null 表示清空。"),
    protocol: z.enum(["openai", "anthropic"]).default("openai").describe("Provider 协议类型。"),
    baseUrl: z.string().nullable().optional().describe("Provider Base URL；传 null 表示清空。"),
    apiKey: z.string().nullable().optional().describe("Provider API Key 或占位符；传 null 表示清空。"),
    extraOptions: z.record(z.string(), z.unknown()).nullable().optional().describe("扩展配置；传 null 表示清空。"),
    publicReadable: z.boolean().optional().describe("是否允许其他组织只读访问。"),
  })
  .describe("创建 Provider 请求体。");

/**
 * 更新 Provider 请求体。
 * Provider 名称由路径参数决定，不允许通过 body 重命名。
 */
export const ApiProviderUpdateBodySchema = ApiProviderUpsertBodySchema.omit({ name: true })
  .partial()
  .describe("更新 Provider 请求体。");

/**
 * 创建 Model 请求体。
 */
export const ApiModelUpsertBodySchema = z
  .object({
    modelId: z.string().min(1).describe("Model ID。"),
    displayName: z.string().nullable().optional().describe("Model 展示名称；传 null 表示清空。"),
    modalities: z.unknown().nullable().optional().describe("Model 模态配置；传 null 表示清空。"),
    limitConfig: z
      .object({
        context: z.number().int().optional().describe("上下文窗口限制。"),
        output: z.number().int().optional().describe("输出 token 限制。"),
        rpm: z.number().int().optional().describe("每分钟请求数限制。"),
      })
      .nullable()
      .optional()
      .describe("Model 限制配置；传 null 表示清空。"),
    cost: z
      .object({
        input: z.number().optional().describe("输入 token 单价。"),
        output: z.number().optional().describe("输出 token 单价。"),
      })
      .nullable()
      .optional()
      .describe("Model 成本配置；传 null 表示清空。"),
    options: z.record(z.string(), z.unknown()).nullable().optional().describe("扩展配置；传 null 表示清空。"),
  })
  .describe("创建 Model 请求体。");

/**
 * 更新 Model 请求体。
 */
export const ApiModelUpdateBodySchema = ApiModelUpsertBodySchema.omit({ modelId: true })
  .partial()
  .describe("更新 Model 请求体。");

/**
 * Provider 列表项。
 */
export const ApiProviderListItemSchema = z
  .object({
    id: z.string().describe("Provider 唯一 ID。"),
    name: z.string().describe("Provider 名称。"),
    displayName: z.string().nullable().describe("Provider 展示名称。"),
    protocol: z.enum(["openai", "anthropic"]).describe("Provider 协议类型。"),
    baseUrl: z.string().nullable().describe("Provider Base URL。"),
    modelCount: z.number().int().min(0).describe("该 Provider 下的模型数量。"),
    resourceAccess: AgentResourceAccessSchema.optional().describe("资源访问控制信息。"),
  })
  .describe("Provider 列表项。");

/**
 * Provider 详情中内嵌的 Model 摘要。
 */
export const ApiProviderModelSummarySchema = z
  .object({
    providerId: z.string().describe("所属 Provider 唯一 ID。"),
    id: z.string().describe("Model 唯一 ID。"),
    modelId: z.string().describe("Model 业务标识。"),
    displayName: z.string().nullable().describe("Model 展示名称。"),
    modalities: z.unknown().nullable().describe("Model 模态配置。"),
    limitConfig: z.unknown().nullable().describe("Model 限制配置。"),
    cost: z.unknown().nullable().describe("Model 成本配置。"),
  })
  .describe("Provider 详情中的 Model 摘要。");

/**
 * Provider 列表响应。
 */
export const ApiProviderListResponseSchema = z
  .object({
    items: z.array(ApiProviderListItemSchema).describe("当前页 Provider 列表。"),
    total: z.number().int().min(0).describe("总条数。"),
    page: z.number().int().min(1).describe("当前页码。"),
    pageSize: z.number().int().min(1).describe("当前分页大小。"),
  })
  .describe("Provider 列表响应。");

/**
 * Provider 详情。
 */
export const ApiProviderDetailSchema = z
  .object({
    id: z.string().describe("Provider 唯一 ID。"),
    name: z.string().describe("Provider 名称。"),
    displayName: z.string().nullable().describe("Provider 展示名称。"),
    protocol: z.enum(["openai", "anthropic"]).describe("Provider 协议类型。"),
    baseUrl: z.string().nullable().describe("Provider Base URL。"),
    extraOptions: z.record(z.string(), z.unknown()).nullable().describe("Provider 扩展配置。"),
    models: z.array(ApiProviderModelSummarySchema).describe("该 Provider 下的模型摘要列表。"),
    resourceAccess: AgentResourceAccessSchema.optional().describe("资源访问控制信息。"),
  })
  .describe("Provider 详情。");

/**
 * 删除 Provider 响应。
 */
export const ApiProviderDeleteResponseSchema = z
  .object({
    id: z.string().describe("已删除的 Provider 唯一 ID。"),
    deleted: z.literal(true).describe("删除结果。"),
  })
  .describe("删除 Provider 响应。");

/**
 * Model 列表项。
 */
export const ApiModelListItemSchema = z
  .object({
    providerId: z.string().describe("所属 Provider 唯一 ID。"),
    id: z.string().describe("Model 唯一 ID。"),
    modelId: z.string().describe("Model 业务标识。"),
    providerName: z.string().describe("所属 Provider 名称。"),
    displayName: z.string().nullable().describe("Model 展示名称。"),
    modalities: z.unknown().nullable().describe("Model 模态配置。"),
    limitConfig: z.unknown().nullable().describe("Model 限制配置。"),
    cost: z.unknown().nullable().describe("Model 成本配置。"),
  })
  .describe("Model 列表项。");

/**
 * Model 列表响应。
 */
export const ApiModelListResponseSchema = z
  .object({
    items: z.array(ApiModelListItemSchema).describe("当前页 Model 列表。"),
    total: z.number().int().min(0).describe("总条数。"),
    page: z.number().int().min(1).describe("当前页码。"),
    pageSize: z.number().int().min(1).describe("当前分页大小。"),
  })
  .describe("Model 列表响应。");

/**
 * Model 详情。
 */
export const ApiModelDetailSchema = z
  .object({
    providerId: z.string().describe("所属 Provider 唯一 ID。"),
    id: z.string().describe("Model 唯一 ID。"),
    modelId: z.string().describe("Model 业务标识。"),
    providerName: z.string().describe("所属 Provider 名称。"),
    displayName: z.string().nullable().describe("Model 展示名称。"),
    modalities: z.unknown().nullable().describe("Model 模态配置。"),
    limitConfig: z.unknown().nullable().describe("Model 限制配置。"),
    cost: z.unknown().nullable().describe("Model 成本配置。"),
    options: z.record(z.string(), z.unknown()).nullable().describe("Model 扩展配置。"),
  })
  .describe("Model 详情。");

/**
 * 删除 Model 响应。
 */
export const ApiModelDeleteResponseSchema = z
  .object({
    providerId: z.string().describe("所属 Provider 名称。"),
    id: z.string().describe("已删除的 Model 唯一 ID。"),
    modelId: z.string().describe("已删除的 Model ID。"),
    deleted: z.literal(true).describe("删除结果。"),
  })
  .describe("删除 Model 响应。");

export type ApiModelListQuery = z.infer<typeof ApiModelListQuerySchema>;
export type ApiProviderUpsertBody = z.infer<typeof ApiProviderUpsertBodySchema>;
export type ApiProviderUpdateBody = z.infer<typeof ApiProviderUpdateBodySchema>;
export type ApiModelUpsertBody = z.infer<typeof ApiModelUpsertBodySchema>;
export type ApiModelUpdateBody = z.infer<typeof ApiModelUpdateBodySchema>;
