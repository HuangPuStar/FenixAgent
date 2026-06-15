import * as z from "zod/v4";
import { StatusOkResponseSchema } from "./common.schema";

/** Worker 外部元数据 */
export const WorkerMetadataSchema = z.record(z.string(), z.unknown()).describe("Worker 外部元数据对象。");

/** PUT /v1/code/sessions/:id/worker 请求体 */
export const UpdateWorkerRequestSchema = z
  .object({
    worker_status: z.string().optional().describe("新的 worker 状态。"),
    external_metadata: WorkerMetadataSchema.optional().describe("外部元数据。"),
    requires_action_details: WorkerMetadataSchema.optional().describe("需要用户处理时的附加详情。"),
  })
  .describe("更新 worker 状态请求体。");

/** Worker 当前状态对象 */
export const WorkerStateSchema = z
  .object({
    worker_status: z.string().nullable().describe("当前 worker 状态；未知时为 null。"),
    external_metadata: WorkerMetadataSchema.nullable().describe("当前外部元数据；没有时为 null。"),
    requires_action_details: WorkerMetadataSchema.nullable().describe("当前待处理详情；没有时为 null。"),
    last_heartbeat_at: z.string().nullable().describe("最近一次心跳时间；没有时为 null。"),
  })
  .describe("Worker 当前状态。");

/** GET /v1/code/sessions/:id/worker — 读取 worker 状态 */
export const GetWorkerResponseSchema = z
  .object({
    worker: WorkerStateSchema.describe("Worker 状态。"),
  })
  .describe("读取 worker 状态响应。");

/** PUT /v1/code/sessions/:id/worker — 更新 worker 状态响应 */
export const UpdateWorkerResponseSchema = z
  .object({
    status: z.literal("ok").describe("处理状态。"),
    worker: WorkerStateSchema.describe("更新后的 worker 状态。"),
  })
  .describe("更新 worker 状态响应。");

/** POST /v1/code/sessions/:id/worker/heartbeat — 心跳响应 */
export const WorkerHeartbeatResponseSchema = z
  .object({
    status: z.literal("ok").describe("处理状态。"),
    last_heartbeat_at: z.string().describe("本次记录的心跳时间。"),
  })
  .describe("Worker 心跳响应。");

/** POST /v1/code/sessions/:id/worker/register — 注册响应 */
export const WorkerRegisterResponseSchema = StatusOkResponseSchema;

export type UpdateWorkerRequest = z.infer<typeof UpdateWorkerRequestSchema>;
export type GetWorkerResponse = z.infer<typeof GetWorkerResponseSchema>;
export type UpdateWorkerResponse = z.infer<typeof UpdateWorkerResponseSchema>;
export type WorkerHeartbeatResponse = z.infer<typeof WorkerHeartbeatResponseSchema>;
