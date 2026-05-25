import * as z from "zod/v4";
import { StatusOkResponseSchema } from "./common.schema";

export const UpdateWorkerRequestSchema = z.object({
  worker_status: z.string().optional(),
  external_metadata: z.record(z.string(), z.unknown()).optional(),
  requires_action_details: z.record(z.string(), z.unknown()).optional(),
});

/** GET /v1/code/sessions/:id/worker — 读取 worker 状态 */
export const GetWorkerResponseSchema = z.object({
  worker: z.object({
    worker_status: z.string().nullable(),
    external_metadata: z.record(z.string(), z.unknown()).nullable(),
    requires_action_details: z.record(z.string(), z.unknown()).nullable(),
    last_heartbeat_at: z.string().nullable(),
  }),
});

/** PUT /v1/code/sessions/:id/worker — 更新 worker 状态响应 */
export const UpdateWorkerResponseSchema = z.object({
  status: z.literal("ok"),
  worker: z.object({
    worker_status: z.string().nullable(),
    external_metadata: z.record(z.string(), z.unknown()).nullable(),
    requires_action_details: z.record(z.string(), z.unknown()).nullable(),
    last_heartbeat_at: z.string().nullable(),
  }),
});

/** POST /v1/code/sessions/:id/worker/heartbeat — 心跳响应 */
export const WorkerHeartbeatResponseSchema = z.object({
  status: z.literal("ok"),
  last_heartbeat_at: z.string(),
});

/** POST /v1/code/sessions/:id/worker/register — 注册响应 */
export const WorkerRegisterResponseSchema = StatusOkResponseSchema;

export type UpdateWorkerRequest = z.infer<typeof UpdateWorkerRequestSchema>;
export type GetWorkerResponse = z.infer<typeof GetWorkerResponseSchema>;
export type UpdateWorkerResponse = z.infer<typeof UpdateWorkerResponseSchema>;
export type WorkerHeartbeatResponse = z.infer<typeof WorkerHeartbeatResponseSchema>;
