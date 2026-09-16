import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";

/** GET /web/workflow-runs 查询参数 */
export const WorkflowRunsRouteQuerySchema = z.object({
  page: z.string().optional().describe("页码，从 1 开始。"),
  pageSize: z.string().optional().describe("每页条数，上限 100。"),
  status: z.string().optional().describe("按运行状态过滤。"),
  q: z.string().optional().describe("按工作流名称模糊搜索。"),
});

export const WorkflowRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe("页码，从 1 开始。"),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).describe("每页条数，上限 100。"),
  status: z.string().optional().describe("按运行状态过滤。"),
  q: z.string().optional().describe("按工作流名称模糊搜索。"),
});

export type WorkflowRunsQuery = z.infer<typeof WorkflowRunsQuerySchema>;

/** 分页运行记录响应 */
export const WorkflowRunsDataSchema = z.object({
  items: z.array(z.any()).describe("运行记录列表 (RunSummary[])。"),
  total: z.number().int().min(0).describe("符合条件的总记录数。"),
  page: z.number().int().min(1).describe("当前页码。"),
  pageSize: z.number().int().min(1).describe("每页条数。"),
});

export const WorkflowRunsResponseSchema = WebOkSchema(WorkflowRunsDataSchema).describe("分页运行记录响应。");

export type WorkflowRunsResponse = z.infer<typeof WorkflowRunsResponseSchema>;

// ── REST 风格路由参数 / body schema ──

/** 含 runId 的路径参数 */
export const WorkflowRunIdParamsSchema = z.object({
  runId: z.string().describe("运行 ID。"),
});

/** 含 runId + nodeId 的路径参数 */
export const WorkflowRunNodeParamsSchema = z.object({
  runId: z.string().describe("运行 ID。"),
  nodeId: z.string().describe("节点 ID。"),
});

/** POST /web/workflow-runs — 执行工作流请求体 */
export const WorkflowRunRequestBodySchema = z.object({
  yaml: z.string().optional().describe("待执行的工作流 YAML；与 workflowId 二选一。"),
  params: z.record(z.string(), z.unknown()).optional().describe("运行参数。"),
  workflowId: z.string().optional().describe("可选工作流 ID；传入后从最新发布版本读取 YAML，用于事件归档。"),
});

/** POST /web/workflow-runs/dry — 干运行校验请求体 */
export const WorkflowDryRunRequestBodySchema = z.object({
  yaml: z.string().optional().describe("待校验的工作流 YAML；与 workflowId 二选一。"),
  workflowId: z.string().optional().describe("可选工作流 ID；传入后从最新发布版本读取 YAML，用于发布干运行事件。"),
});

/** POST /web/workflow-runs/:runId/approve — 审批通过挂起节点请求体 */
export const WorkflowApproveRequestBodySchema = z.object({
  nodeId: z.string().describe("节点 ID。"),
  token: z.string().describe("审批 token。"),
  data: z.unknown().optional().describe("审批附加数据。"),
  workflowId: z.string().optional().describe("可选工作流 ID，用于发布事件。"),
});

/** POST /web/workflow-runs/:runId/recover — 从快照恢复运行请求体 */
export const WorkflowRecoverRequestBodySchema = z.object({
  yaml: z.string().describe("恢复时使用的工作流 YAML。"),
});

/** POST /web/workflow-runs/:runId/rerun — 从指定节点重新运行请求体 */
export const WorkflowRerunRequestBodySchema = z.object({
  fromNodeId: z.string().describe("重新运行的起始节点 ID。"),
  yaml: z.string().describe("执行使用的工作流 YAML。"),
  workflowId: z.string().optional().describe("可选工作流 ID，用于归档与事件发布。"),
});

/** POST /web/workflow-runs/:runId/cancel — 取消运行请求体 */
export const WorkflowCancelRequestBodySchema = z.object({
  workflowId: z.string().optional().describe("可选工作流 ID，用于发布事件。"),
});

/** GET /web/workflow-runs/:runId/events — 查询参数 */
export const WorkflowEventsQuerySchema = z.object({
  nodeId: z.string().optional().describe("可选节点 ID；传入后仅筛选该节点事件。"),
});
