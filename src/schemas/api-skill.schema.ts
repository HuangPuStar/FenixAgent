/**
 * api-skill.schema.ts — 对外 OpenAPI 的 Skill Schema 定义。
 *
 * 遵循外部 API 规范：稳定分页结构、统一错误格式。
 */
import * as z from "zod/v4";
import { AgentResourceAccessSchema } from "./config.schema";

/**
 * Skill 列表查询参数。
 * 保持分页结构稳定，避免未来补筛选时破坏现有调用方。
 */
export const ApiSkillListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1).describe("页码，从 1 开始。"),
    pageSize: z.coerce.number().int().min(1).max(100).default(20).describe("每页条数，最大 100。"),
  })
  .describe("Skill 列表查询参数。");

/**
 * Skill 路径参数。
 * 对外统一使用 Skill 名称作为标识符（组织内唯一）。
 */
export const ApiSkillNameParamsSchema = z
  .object({
    name: z.string().min(1).describe("Skill 名称。"),
  })
  .describe("Skill 路径参数。");

/**
 * 创建 Skill 请求体。
 */
export const ApiSkillCreateBodySchema = z
  .object({
    name: z.string().min(1).max(64).describe("Skill 名称，组织内唯一。"),
    description: z.string().max(500).nullable().optional().describe("Skill 描述；传 null 表示清空。"),
    content: z.string().min(1).describe("SKILL.md 正文内容。"),
    metadata: z.record(z.string(), z.string()).nullable().optional().describe("额外元数据；传 null 表示清空。"),
  })
  .describe("创建 Skill 请求体。");

/**
 * 对外 Skill 列表项。
 */
export const ApiSkillListItemSchema = z
  .object({
    name: z.string().describe("Skill 名称。"),
    description: z.string().nullable().describe("Skill 描述。"),
    resourceAccess: AgentResourceAccessSchema.optional().describe("资源访问控制信息。"),
  })
  .describe("对外 Skill 列表项。");

/**
 * 对外 Skill 列表响应。
 */
export const ApiSkillListResponseSchema = z
  .object({
    items: z.array(ApiSkillListItemSchema).describe("当前页 Skill 列表。"),
    total: z.number().int().min(0).describe("总条数。"),
    page: z.number().int().min(1).describe("当前页码。"),
    pageSize: z.number().int().min(1).describe("当前分页大小。"),
  })
  .describe("对外 Skill 列表响应。");

/**
 * 对外 Skill 详情。
 */
export const ApiSkillDetailSchema = z
  .object({
    name: z.string().describe("Skill 名称。"),
    description: z.string().nullable().describe("Skill 描述。"),
    content: z.string().describe("SKILL.md 正文内容。"),
    metadata: z.record(z.string(), z.string()).describe("额外元数据。"),
    resourceAccess: AgentResourceAccessSchema.optional().describe("资源访问控制信息。"),
  })
  .describe("对外 Skill 详情。");

/**
 * 删除 Skill 响应。
 */
export const ApiSkillDeleteResponseSchema = z
  .object({
    name: z.string().describe("已删除的 Skill 名称。"),
    deleted: z.literal(true).describe("删除结果。"),
  })
  .describe("删除 Skill 响应。");

// ── 类型导出 ──

export type ApiSkillListQuery = z.infer<typeof ApiSkillListQuerySchema>;
export type ApiSkillNameParams = z.infer<typeof ApiSkillNameParamsSchema>;
export type ApiSkillCreateBody = z.infer<typeof ApiSkillCreateBodySchema>;
