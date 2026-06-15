import * as z from "zod/v4";
import { StatusOkResponseSchema } from "./common.schema";

/** Worker 上报的单条事件 */
export const WorkerEventSchema = z.record(z.string(), z.unknown()).describe("Worker 上报的单条事件对象。");

/** POST /v1/code/sessions/:id/worker/events 请求体 */
export const WorkerEventsRequestSchema = z
  .union([
    z.object({
      events: z.array(WorkerEventSchema).describe("批量上报的事件列表。"),
    }),
    z.array(WorkerEventSchema).describe("直接传入事件数组。"),
    WorkerEventSchema,
  ])
  .describe("Worker 事件上报请求体。");

/** PUT /v1/code/sessions/:id/worker/state 请求体 */
export const WorkerStateRequestSchema = z
  .object({
    status: z.string().optional().describe("要同步到会话的运行状态。"),
  })
  .describe("Worker 状态上报请求体。");

/** POST /v1/code/sessions/:id/worker/events — 写入事件响应 */
export const WorkerEventsResponseSchema = z
  .object({
    status: z.literal("ok").describe("处理状态。"),
    count: z.number().describe("本次成功发布的事件条数。"),
  })
  .describe("Worker 事件写入响应。");

/** PUT /v1/code/sessions/:id/worker/state 响应 */
export const WorkerStateResponseSchema = StatusOkResponseSchema.describe("Worker 状态写入成功响应。");

export type WorkerEventsRequest = z.infer<typeof WorkerEventsRequestSchema>;
export type WorkerStateRequest = z.infer<typeof WorkerStateRequestSchema>;
export type WorkerEventsResponse = z.infer<typeof WorkerEventsResponseSchema>;
