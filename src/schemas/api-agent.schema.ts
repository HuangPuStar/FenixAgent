import * as z from "zod/v4";
import { AgentDetailSchema, AgentInfoSchema, AgentResourceAccessSchema } from "./config.schema";

/**
 * 对外 Agent 列表查询参数。
 * 保持分页结构稳定，避免未来补筛选时破坏现有调用方。
 */
export const ApiAgentListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).describe("页码，从 1 开始。"),
    pageSize: z.coerce.number().int().min(1).max(100).default(20).describe("每页条数，最大 100。"),
  })
  .describe("Agent 列表查询参数。");

/**
 * 对外 Agent 主键路径参数。
 * 对外统一使用配置 ID，避免把 name 当作可变主键暴露给外部系统。
 */
export const ApiAgentIdParamsSchema = z
  .object({
    id: z.string().min(1).describe("Agent 配置 ID。"),
  })
  .describe("Agent 路径参数。");

export const ApiAgentUpsertBodySchema = z
  .object({
    name: z.string().min(1).max(64).describe("Agent 名称。"),
    modelId: z.string().nullable().optional().describe("绑定的模型 ID；传 null 表示清空。"),
    prompt: z.string().nullable().optional().describe("系统提示词；传 null 表示清空。"),
    description: z.string().nullable().optional().describe("Agent 描述；传 null 表示清空。"),
    extra: z.record(z.string(), z.unknown()).nullable().optional().describe("额外扩展配置；传 null 表示清空。"),
    knowledge: z.unknown().nullable().optional().describe("知识库绑定配置；传 null 表示清空。"),
    machineId: z.string().nullable().optional().describe("绑定的机器 ID；传 null 表示清空。"),
    skillIds: z.array(z.string()).optional().describe("绑定的 Skill ID 或 Skill 名称列表。"),
    mcpIds: z.array(z.string()).optional().describe("绑定的 MCP Server ID 列表。"),
    publicReadable: z.boolean().optional().describe("是否允许其他组织只读访问。"),
  })
  .describe("创建 Agent 请求体。");

export const ApiAgentUpdateBodySchema = ApiAgentUpsertBodySchema.omit({ name: true })
  .extend({
    name: z.string().min(1).max(64).optional().describe("更新后的 Agent 名称。"),
  })
  .describe("更新 Agent 请求体。");

export const ApiAgentListItemSchema = AgentInfoSchema.omit({
  resourceAccess: true,
  skillLabels: true,
  modelLabel: true,
})
  .extend({
    resourceAccess: AgentResourceAccessSchema.optional().describe("资源访问控制信息。"),
  })
  .describe("对外 Agent 列表项。");

export const ApiAgentListResponseSchema = z
  .object({
    items: z.array(ApiAgentListItemSchema).describe("当前页 Agent 列表。"),
    total: z.number().int().min(0).describe("总条数。"),
    page: z.number().int().min(1).describe("当前页码。"),
    pageSize: z.number().int().min(1).describe("当前分页大小。"),
  })
  .describe("对外 Agent 列表响应。");

export const ApiAgentDetailSchema = AgentDetailSchema.describe("对外 Agent 详情。");

export const ApiAgentDeleteResponseSchema = z
  .object({
    id: z.string().describe("已删除的 Agent 配置 ID。"),
    deleted: z.literal(true).describe("删除结果。"),
  })
  .describe("删除 Agent 响应。");

export type ApiAgentListQuery = z.infer<typeof ApiAgentListQuerySchema>;
export type ApiAgentIdParams = z.infer<typeof ApiAgentIdParamsSchema>;
export type ApiAgentUpsertBody = z.infer<typeof ApiAgentUpsertBodySchema>;
export type ApiAgentUpdateBody = z.infer<typeof ApiAgentUpdateBodySchema>;
