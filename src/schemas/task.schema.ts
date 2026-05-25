import * as z from "zod/v4";
import { OkResponseSchema, StatusOkResponseSchema } from "./common.schema";

export const TaskInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  cron: z.string(),
  timezone: z.string().nullable(),
  enabled: z.boolean(),
  url: z.string(),
  method: z.string(),
  headers: z.string().nullable(),
  body: z.string().nullable(),
  lastRunAt: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  lastStatus: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ExecutionLogInfoSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  duration: z.number().nullable(),
  triggeredBy: z.string(),
  taskSnapshot: z.string().nullable(),
  skipReason: z.string().nullable(),
  resultSummary: z.string().nullable(),
  createdAt: z.number(),
});

export const PaginatedLogsSchema = z.object({
  total: z.number(),
  items: ExecutionLogInfoSchema.array(),
});

export const CreateTaskRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  cron: z.string().min(1),
  timezone: z.string().nullable().optional(),
  url: z.string().min(1),
  method: z.string().optional(),
  headers: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
});

export const UpdateTaskRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  cron: z.string().min(1).optional(),
  timezone: z.string().nullable().optional(),
  url: z.string().min(1).optional(),
  method: z.string().optional(),
  headers: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

/** DELETE /web/tasks/:id — 删除任务响应 */
export const DeleteTaskResponseSchema = TaskInfoSchema;

/** POST /web/tasks/:id/toggle — 切换启用状态响应 */
export const ToggleTaskResponseSchema = TaskInfoSchema;

/** POST /web/tasks/:id/trigger — 手动触发响应 */
export const TriggerTaskResponseSchema = StatusOkResponseSchema;

/** DELETE /web/tasks/:id/logs — 清除日志响应 */
export const ClearTaskLogsResponseSchema = StatusOkResponseSchema;

export type TaskInfo = z.infer<typeof TaskInfoSchema>;
export type ExecutionLogInfo = z.infer<typeof ExecutionLogInfoSchema>;
export type PaginatedLogs = z.infer<typeof PaginatedLogsSchema>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;
export type DeleteTaskResponse = z.infer<typeof DeleteTaskResponseSchema>;
export type ToggleTaskResponse = z.infer<typeof ToggleTaskResponseSchema>;
export type TriggerTaskResponse = z.infer<typeof TriggerTaskResponseSchema>;
export type ClearTaskLogsResponse = z.infer<typeof ClearTaskLogsResponseSchema>;
