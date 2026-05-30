import * as z from "zod/v4";
import { OkResponseSchema } from "./common.schema";

export const InstanceStatusSchema = z.enum(["starting", "running", "stopped", "error"]);

export const InstanceInfoSchema = z.object({
  id: z.string(),
  port: z.number(),
  status: InstanceStatusSchema,
  error: z.string().nullable(),
  group_id: z.string(),
  environment_id: z.string().nullable(),
  session_id: z.string().nullable(),
  instance_number: z.number(),
  created_at: z.number(),
});

export const SpawnInstanceFromEnvironmentRequestSchema = z.object({
  environmentId: z.string().min(1, "environmentId is required"),
});

/** GET /web/instances — 实例列表响应 */
export const InstanceListResponseSchema = InstanceInfoSchema.array();

/** DELETE /web/instances/:id — 删除实例响应 */
export const DeleteInstanceResponseSchema = OkResponseSchema;

export type InstanceInfo = z.infer<typeof InstanceInfoSchema>;
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;
export type SpawnInstanceFromEnvironmentRequest = z.infer<typeof SpawnInstanceFromEnvironmentRequestSchema>;
export type InstanceListResponse = z.infer<typeof InstanceListResponseSchema>;
export type DeleteInstanceResponse = z.infer<typeof DeleteInstanceResponseSchema>;
