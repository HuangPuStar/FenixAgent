import * as z from "zod/v4";

/** 计划任务信息 */
export const TaskInfoSchema = z.object({
  id: z.string().describe("任务 ID。"),
  name: z.string().describe("任务名称。"),
  description: z.string().nullable().describe("任务描述；未填写时为 null。"),
  cron: z.string().describe("cron 表达式。"),
  timezone: z.string().nullable().describe("任务时区；未设置时为 null。"),
  enabled: z.boolean().describe("任务是否启用。"),
  url: z.string().describe("任务执行时请求的目标 URL。"),
  method: z.string().describe("任务执行使用的 HTTP 方法。"),
  headers: z.record(z.string(), z.string()).nullable().describe("请求头对象；未设置时为 null。"),
  body: z.string().nullable().describe("请求体文本内容；未设置时为 null。"),
  lastRunAt: z.number().nullable().describe("最近一次执行时间戳，单位为秒。"),
  nextRunAt: z.number().nullable().describe("下一次计划执行时间戳，单位为秒。"),
  lastStatus: z.string().nullable().describe("最近一次执行状态；未执行过时为 null。"),
  createdAt: z.number().describe("创建时间戳，单位为秒。"),
  updatedAt: z.number().describe("更新时间戳，单位为秒。"),
});

/** 任务执行日志 */
export const ExecutionLogInfoSchema = z.object({
  id: z.string().describe("执行日志 ID。"),
  taskId: z.string().describe("所属任务 ID。"),
  status: z.string().describe("执行状态，例如 success、failed、timeout。"),
  error: z.string().nullable().describe("失败错误信息；成功时为 null。"),
  duration: z.number().nullable().describe("执行耗时，单位为毫秒。"),
  triggeredBy: z.string().describe("触发来源，例如 cron 或 manual。"),
  skipReason: z.string().nullable().describe("跳过原因；未跳过时为 null。"),
  resultSummary: z.string().nullable().describe("执行结果摘要。"),
  createdAt: z.number().describe("日志创建时间戳，单位为秒。"),
});

/** 分页执行日志结果 */
export const PaginatedLogsSchema = z.object({
  total: z.number().describe("日志总数。"),
  items: ExecutionLogInfoSchema.array().describe("当前页日志列表。"),
});

/** 创建任务请求体 */
export const CreateTaskRequestSchema = z.object({
  name: z.string().min(1).describe("任务名称。"),
  description: z.string().optional().describe("任务描述。"),
  cron: z.string().min(1).describe("cron 表达式。"),
  timezone: z.string().nullable().optional().describe("可选时区。"),
  url: z.string().min(1).describe("任务执行时请求的目标 URL。"),
  method: z.string().optional().describe("HTTP 方法；默认 POST。"),
  headers: z.string().nullable().optional().describe("可选请求头内容；当前按现有协议透传字符串。"),
  body: z.string().nullable().optional().describe("可选请求体文本。"),
});

/** 更新任务请求体 */
export const UpdateTaskRequestSchema = z.object({
  name: z.string().min(1).optional().describe("更新后的任务名称。"),
  description: z.string().nullable().optional().describe("更新后的任务描述。"),
  cron: z.string().min(1).optional().describe("更新后的 cron 表达式。"),
  timezone: z.string().nullable().optional().describe("更新后的时区。"),
  url: z.string().min(1).optional().describe("更新后的目标 URL。"),
  method: z.string().optional().describe("更新后的 HTTP 方法。"),
  headers: z.string().nullable().optional().describe("更新后的请求头内容；当前按现有协议透传字符串。"),
  body: z.string().nullable().optional().describe("更新后的请求体文本。"),
  enabled: z.boolean().optional().describe("更新后的启用状态。"),
});

/** 任务详情成功响应 */
export const TaskResponseSchema = z.object({
  success: z.literal(true).describe("接口调用成功。"),
  data: TaskInfoSchema.describe("任务详情。"),
});

/** 任务列表成功响应 */
export const TaskListResponseSchema = z.object({
  success: z.literal(true).describe("接口调用成功。"),
  data: TaskInfoSchema.array().describe("任务列表。"),
});

/** 执行日志分页响应 */
export const TaskLogsResponseSchema = z.object({
  success: z.literal(true).describe("接口调用成功。"),
  data: PaginatedLogsSchema.describe("分页日志结果。"),
});

/** 删除任务响应 */
export const DeleteTaskResponseSchema = z.object({
  success: z.literal(true).describe("接口调用成功。"),
});

/** 切换任务启用状态响应 */
export const ToggleTaskResponseSchema = z.object({
  success: z.literal(true).describe("接口调用成功。"),
  data: z
    .object({
      id: z.string().describe("任务 ID。"),
      enabled: z.boolean().describe("切换后的启用状态。"),
    })
    .describe("切换结果。"),
});

/** 手动触发任务响应 */
export const TriggerTaskResponseSchema = z.object({
  success: z.literal(true).describe("接口调用成功。"),
  data: ExecutionLogInfoSchema.describe("本次手动触发生成的执行日志。"),
});

/** 清空任务日志响应 */
export const ClearTaskLogsResponseSchema = z.object({
  success: z.literal(true).describe("接口调用成功。"),
});

export type TaskInfo = z.infer<typeof TaskInfoSchema>;
export type ExecutionLogInfo = z.infer<typeof ExecutionLogInfoSchema>;
export type PaginatedLogs = z.infer<typeof PaginatedLogsSchema>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
export type TaskLogsResponse = z.infer<typeof TaskLogsResponseSchema>;
export type DeleteTaskResponse = z.infer<typeof DeleteTaskResponseSchema>;
export type ToggleTaskResponse = z.infer<typeof ToggleTaskResponseSchema>;
export type TriggerTaskResponse = z.infer<typeof TriggerTaskResponseSchema>;
export type ClearTaskLogsResponse = z.infer<typeof ClearTaskLogsResponseSchema>;
