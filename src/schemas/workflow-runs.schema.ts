import * as z from "zod/v4";

/** GET /web/workflow-runs 查询参数 */
export const WorkflowRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe("页码，从 1 开始。"),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).describe("每页条数，上限 100。"),
  status: z.string().optional().describe("按运行状态过滤。"),
  q: z.string().optional().describe("按工作流名称模糊搜索。"),
});

export type WorkflowRunsQuery = z.infer<typeof WorkflowRunsQuerySchema>;

/** 分页运行记录响应 */
export const WorkflowRunsResponseSchema = z.object({
  items: z.array(z.any()).describe("运行记录列表 (RunSummary[])。"),
  total: z.number().int().min(0).describe("符合条件的总记录数。"),
  page: z.number().int().min(1).describe("当前页码。"),
  pageSize: z.number().int().min(1).describe("每页条数。"),
});

export type WorkflowRunsResponse = z.infer<typeof WorkflowRunsResponseSchema>;
