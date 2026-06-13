import * as z from "zod/v4";
import { AgentResourceAccessSchema } from "./config.schema";

/**
 * MCP 列表查询参数。
 */
export const ApiMcpListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).describe("页码，从 1 开始。"),
    pageSize: z.coerce.number().int().min(1).max(100).default(20).describe("每页条数，最大 100。"),
  })
  .describe("MCP 列表查询参数。");

/**
 * MCP 路径参数。
 * 支持名称或跨组织共享资源键。
 */
export const ApiMcpIdParamsSchema = z
  .object({
    id: z.string().min(1).describe("MCP Server 唯一 ID。"),
  })
  .describe("MCP 路径参数。");

/**
 * MCP OAuth 配置。
 */
export const ApiMcpOAuthSchema = z
  .object({
    clientId: z.string().optional().describe("OAuth Client ID。"),
    clientSecret: z.string().optional().describe("OAuth Client Secret。"),
    scope: z.string().optional().describe("OAuth Scope。"),
    redirectUri: z.string().optional().describe("OAuth Redirect URI。"),
  })
  .describe("MCP OAuth 配置。");

/**
 * 创建 MCP Server 请求体。
 */
export const ApiMcpCreateBodySchema = z
  .object({
    name: z.string().min(1).max(64).describe("MCP Server 名称，组织内唯一。"),
    type: z.enum(["local", "remote", "streamable-http"]).default("local").describe("MCP Server 类型。"),
    command: z.array(z.string()).optional().describe("本地 MCP Server 启动命令数组。"),
    url: z.string().optional().describe("远端 MCP Server 地址。"),
    headers: z.record(z.string(), z.string()).optional().describe("远端 MCP 请求头。"),
    timeout: z.number().int().positive().optional().describe("连接超时时间，单位毫秒。"),
    oauth: ApiMcpOAuthSchema.nullable().optional().describe("远端 MCP 的 OAuth 配置；传 null 表示清空。"),
    publicReadable: z.boolean().optional().describe("是否允许其他组织只读访问。"),
  })
  .describe("创建 MCP Server 请求体。");

/**
 * 更新 MCP Server 请求体。
 * 名称由路径参数决定，不允许通过 body 重命名。
 */
export const ApiMcpUpdateBodySchema = ApiMcpCreateBodySchema.omit({ name: true })
  .partial()
  .describe("更新 MCP Server 请求体。");

/**
 * MCP 列表项。
 */
export const ApiMcpListItemSchema = z
  .object({
    id: z.string().describe("MCP Server 内部 ID。"),
    name: z.string().describe("MCP Server 名称。"),
    type: z.enum(["local", "remote", "streamable-http"]).describe("MCP Server 类型。"),
    enabled: z.boolean().describe("MCP Server 是否启用。"),
    summary: z.string().describe("MCP Server 摘要信息。"),
    toolsCount: z.number().int().min(0).describe("缓存的 MCP Tool 数量。"),
    resourceAccess: AgentResourceAccessSchema.optional().describe("资源访问控制信息。"),
  })
  .describe("MCP 列表项。");

/**
 * MCP 列表响应。
 */
export const ApiMcpListResponseSchema = z
  .object({
    items: z.array(ApiMcpListItemSchema).describe("当前页 MCP Server 列表。"),
    total: z.number().int().min(0).describe("总条数。"),
    page: z.number().int().min(1).describe("当前页码。"),
    pageSize: z.number().int().min(1).describe("当前分页大小。"),
  })
  .describe("MCP 列表响应。");

/**
 * MCP 详情。
 */
export const ApiMcpDetailSchema = z
  .object({
    id: z.string().describe("MCP Server 内部 ID。"),
    name: z.string().describe("MCP Server 名称。"),
    type: z.enum(["local", "remote", "streamable-http"]).describe("MCP Server 类型。"),
    enabled: z.boolean().describe("MCP Server 是否启用。"),
    summary: z.string().describe("MCP Server 摘要信息。"),
    config: z.unknown().describe("MCP Server 完整配置。"),
    resourceAccess: AgentResourceAccessSchema.optional().describe("资源访问控制信息。"),
  })
  .describe("MCP 详情。");

/**
 * 删除 MCP 响应。
 */
export const ApiMcpDeleteResponseSchema = z
  .object({
    id: z.string().describe("已删除的 MCP Server 唯一 ID。"),
    deleted: z.literal(true).describe("删除结果。"),
  })
  .describe("删除 MCP 响应。");

export type ApiMcpListQuery = z.infer<typeof ApiMcpListQuerySchema>;
export type ApiMcpCreateBody = z.infer<typeof ApiMcpCreateBodySchema>;
export type ApiMcpUpdateBody = z.infer<typeof ApiMcpUpdateBodySchema>;
