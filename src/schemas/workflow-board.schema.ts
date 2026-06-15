import * as z from "zod/v4";

/** 看板基础信息 */
export const WorkflowBoardSchema = z
  .object({
    id: z.string().describe("看板 ID。"),
    organizationId: z.string().describe("所属组织 ID。"),
    name: z.string().describe("看板名称。"),
    userId: z.string().describe("看板创建者用户 ID。"),
    isDefault: z.boolean().describe("是否为默认看板。"),
    createdAt: z.string().describe("创建时间，通常为 ISO 8601 字符串。"),
    updatedAt: z.string().describe("更新时间，通常为 ISO 8601 字符串。"),
  })
  .describe("工作流看板信息。");

/** workflow-boards create 请求体 */
export const BoardCreateSchema = z
  .object({
    action: z.literal("create").describe("操作类型：创建看板。"),
    name: z.string().min(1).max(100).describe("看板名称。"),
  })
  .describe("创建工作流看板请求。");

/** workflow-boards update 请求体 */
export const BoardUpdateSchema = z
  .object({
    action: z.literal("update").describe("操作类型：重命名看板。"),
    boardId: z.string().min(1).describe("待更新的看板 ID。"),
    name: z.string().min(1).max(100).describe("新的看板名称。"),
  })
  .describe("更新工作流看板请求。");

/** workflow-boards delete 请求体 */
export const BoardDeleteSchema = z
  .object({
    action: z.literal("delete").describe("操作类型：删除看板。"),
    boardId: z.string().min(1).describe("待删除的看板 ID。"),
  })
  .describe("删除工作流看板请求。");

/** workflow-boards get 请求体 */
export const BoardGetSchema = z
  .object({
    action: z.literal("get").describe("操作类型：获取单个看板。"),
    boardId: z.string().min(1).describe("待查询的看板 ID。"),
  })
  .describe("获取工作流看板详情请求。");

/** workflow-boards list 请求体 */
export const BoardListSchema = z
  .object({
    action: z.literal("list").describe("操作类型：列出当前组织的看板。"),
  })
  .describe("获取工作流看板列表请求。");

/** workflow-boards 统一请求体 */
export const WorkflowBoardActionRequestSchema = z
  .discriminatedUnion("action", [
    BoardCreateSchema,
    BoardUpdateSchema,
    BoardDeleteSchema,
    BoardGetSchema,
    BoardListSchema,
  ])
  .describe("工作流看板接口的 action 分发请求体。");

/** workflow-boards 列表响应 */
export const WorkflowBoardListResponseSchema = z
  .object({
    success: z.literal(true).describe("请求是否成功。"),
    data: WorkflowBoardSchema.array().describe("看板列表。"),
  })
  .describe("工作流看板列表响应。");

/** workflow-boards 详情响应 */
export const WorkflowBoardDetailResponseSchema = z
  .object({
    success: z.literal(true).describe("请求是否成功。"),
    data: WorkflowBoardSchema.describe("看板详情。"),
  })
  .describe("工作流看板详情响应。");

/** workflow-boards 更新成功响应 */
export const WorkflowBoardMutationResponseSchema = z
  .object({
    success: z.literal(true).describe("请求是否成功。"),
  })
  .describe("工作流看板更新类操作成功响应。");

/** workflow-boards 删除响应 */
export const WorkflowBoardDeleteResponseSchema = z
  .object({
    success: z.literal(true).describe("请求是否成功。"),
    data: z.boolean().describe("是否删除成功。"),
  })
  .describe("删除工作流看板后的响应。");

/** workflow-boards 统一响应 */
export const WorkflowBoardActionResponseSchema = z
  .union([
    WorkflowBoardListResponseSchema,
    WorkflowBoardDetailResponseSchema,
    WorkflowBoardMutationResponseSchema,
    WorkflowBoardDeleteResponseSchema,
  ])
  .describe("工作流看板接口的可能成功响应。");

export type WorkflowBoard = z.infer<typeof WorkflowBoardSchema>;
