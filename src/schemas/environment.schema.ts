import * as z from "zod/v4";
import { OkResponseSchema } from "./common.schema";

const _EnvironmentStatusSchema = z.enum(["active", "idle", "offline", "error"]);

export const EnvironmentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  workspace_path: z.string(),
  agent_config_id: z.string().nullable(),
  status: z.string(),
  machine_name: z.string().nullable(),
  branch: z.string().nullable(),
  auto_start: z.boolean(),
  last_poll_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const InstanceSummarySchema = z.object({
  id: z.string(),
  instance_number: z.number(),
  status: z.string(),
  session_id: z.string().nullable(),
  port: z.number(),
  created_at: z.number(),
});

export const EnvironmentListResponseSchema = EnvironmentInfoSchema.extend({
  session_id: z.string(),
  instance_status: z.string().nullable(),
  instance_id: z.string().nullable(),
  instances: InstanceSummarySchema.array(),
  instances_count: z.number(),
});

export const EnvironmentDetailResponseSchema = EnvironmentInfoSchema.extend({
  secret: z.string(),
});

export const CreateEnvironmentRequestSchema = z.object({
  name: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "name 必须为 kebab-case 格式"),
  agentConfigId: z.string().min(1).optional(),
  description: z.string().optional(),
  autoStart: z.boolean().optional(),
});

export const UpdateEnvironmentRequestSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "name 必须为 kebab-case 格式")
    .optional(),
  agentConfigId: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  autoStart: z.boolean().optional(),
});

export const EnterEnvironmentRequestSchema = z.object({
  instance_number: z.number().int().positive().optional(),
});

export const EnterEnvironmentResponseSchema = z.object({
  session_id: z.string(),
  instance_id: z.string(),
  instance_number: z.number(),
  instance_status: z.string(),
  environment_id: z.string(),
});

export const ListInstancesResponseSchema = z.object({
  environment_id: z.string(),
  instances: InstanceSummarySchema.array(),
});

/** PUT /web/environments/:id — 更新环境后的响应 */
export const UpdateEnvironmentResponseSchema = EnvironmentInfoSchema;

/** DELETE /web/environments/:id — 删除环境响应 */
export const DeleteEnvironmentResponseSchema = OkResponseSchema;

export type EnvironmentInfo = z.infer<typeof EnvironmentInfoSchema>;
export type EnvironmentListResponse = z.infer<typeof EnvironmentListResponseSchema>;
export type CreateEnvironmentRequest = z.infer<typeof CreateEnvironmentRequestSchema>;
export type UpdateEnvironmentRequest = z.infer<typeof UpdateEnvironmentRequestSchema>;
export type EnterEnvironmentResponse = z.infer<typeof EnterEnvironmentResponseSchema>;
export type ListInstancesResponse = z.infer<typeof ListInstancesResponseSchema>;
export type UpdateEnvironmentResponse = z.infer<typeof UpdateEnvironmentResponseSchema>;
export type DeleteEnvironmentResponse = z.infer<typeof DeleteEnvironmentResponseSchema>;
