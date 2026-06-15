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
 * 对外统一使用 Skill 唯一 ID 作为资源标识符。
 */
export const ApiSkillIdParamsSchema = z
  .object({
    id: z.string().min(1).describe("Skill 唯一 ID。"),
  })
  .describe("Skill 路径参数。");

/**
 * Skill 上传 manifest 条目。
 */
export const ApiSkillUploadManifestEntrySchema = z
  .object({
    skillName: z.string().min(1).describe("待导入的 Skill 名称。一次请求内所有条目必须属于同一个 Skill。"),
    relativePath: z.string().min(1).describe("Skill 目录内文件相对路径，例如 `SKILL.md` 或 `scripts/tool.sh`。"),
  })
  .describe("Skill 上传 manifest 条目。");

/**
 * 创建 Skill 的 multipart/form-data 表单。
 * 与 `/web/config/skills/upload` 采用相同上传协议，但对外接口仅允许单次导入一个 Skill。
 */
export const ApiSkillCreateBodySchema = z
  .object({
    manifest: z
      .string()
      .describe(
        "上传 manifest 的 JSON 字符串。其内容应为 `ApiSkillUploadManifestEntry` 数组，并且一次请求内只允许包含同一个 Skill 的文件条目。",
      ),
    files: z.array(z.unknown()).describe("与 manifest 条目顺序一一对应的上传文件列表。"),
    overwrite: z
      .enum(["true", "false"])
      .optional()
      .describe("是否允许覆盖同名 Skill。传 `true` 表示覆盖；缺省或传 `false` 时同名冲突返回 409。"),
  })
  .describe("创建 Skill 的 multipart/form-data 表单。");

/**
 * 对外 Skill 列表项。
 */
export const ApiSkillListItemSchema = z
  .object({
    id: z.string().describe("Skill 唯一 ID。"),
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
 * metadata 来源于 SKILL.md frontmatter 中除 name / description 外的其余字段，
 * 当前为保持兼容统一收敛为 string map。
 */
export const ApiSkillDetailSchema = z
  .object({
    id: z.string().describe("Skill 唯一 ID。"),
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
    id: z.string().describe("已删除的 Skill 唯一 ID。"),
    name: z.string().describe("已删除的 Skill 名称。"),
    deleted: z.literal(true).describe("删除结果。"),
  })
  .describe("删除 Skill 响应。");

// ── 类型导出 ──

export type ApiSkillListQuery = z.infer<typeof ApiSkillListQuerySchema>;
export type ApiSkillIdParams = z.infer<typeof ApiSkillIdParamsSchema>;
export type ApiSkillCreateBody = z.infer<typeof ApiSkillCreateBodySchema>;
