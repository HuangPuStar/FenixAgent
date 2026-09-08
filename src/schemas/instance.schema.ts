import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";
/** 实例运行状态 */
export const InstanceStatusSchema = z.enum(["starting", "running", "stopped", "error"]).describe("实例当前运行状态。");
export const InstanceSpawnSourceSchema = z
  .enum(["interactive", "scheduled", "system"])
  .describe("实例启动来源，用于并发分类与审计。");
export const InstanceActivityUserSchema = z.object({
  id: z.string().describe("实例所属用户 ID。"),
  name: z.string().nullable().describe("实例所属用户名；查不到时为 null。"),
  email: z.string().nullable().describe("实例所属用户邮箱；查不到时为 null。"),
});

/** 实例详情信息 */
export const InstanceInfoSchema = z.object({
  instanceUid: z.string().describe("持久 Agent Instance UID。"),
  environmentId: z.string().describe("实例关联的环境 ID。"),
  name: z.string().describe("实例名称。"),
  status: z.enum(["stopped", "starting", "running", "stopping", "unknown"]).describe("实例 runtime 状态。"),
  createdAt: z.string().datetime().describe("实例创建时间。"),
});

/** ACP 实例活跃度监控视图 */
export const InstanceActivityInfoSchema = z.object({
  id: z.string(),
  port: z.number(),
  status: InstanceStatusSchema,
  error: z.string().nullable(),
  group_id: z.string(),
  environment_id: z.string().nullable(),
  session_id: z.string().nullable(),
  created_at: z.number(),
  user: InstanceActivityUserSchema.nullable().describe("实例所属用户信息；缺少 supplement 时为 null。"),
  spawn_source: InstanceSpawnSourceSchema.nullable().describe("实例启动来源；缺少 supplement 时为 null。"),
  last_activity_at: z.number().describe("最近一次非保活 ACP 业务消息时间戳，单位为秒。"),
  relay_count: z.number().describe("当前附着到实例的前端 relay 连接数。"),
  last_relay_detached_at: z
    .number()
    .nullable()
    .describe("最后一次前端 relay 全部断开的时间戳，单位为秒；仍有 relay 时为 null。"),
  idle_seconds: z.number().describe("断开前端连接后已空闲的秒数。"),
  idle_timeout_seconds: z.number().describe("断开前端连接后允许空闲的最长秒数。"),
  idle_kill_eligible: z.boolean().describe("当前是否已满足“断开前端连接后空闲超时”的回收条件。"),
  inactivity_seconds: z.number().describe("无 ACP 业务活动后已空闲的秒数。"),
  activity_timeout_seconds: z.number().describe("无 ACP 业务活动允许空闲的最长秒数。"),
  activity_kill_eligible: z.boolean().describe("当前是否已满足“无 ACP 业务活动硬超时”的回收条件。"),
});

/** 从环境启动实例的请求体 */
export const SpawnInstanceFromEnvironmentRequestSchema = z.object({
  environmentId: z.string().min(1, "environmentId is required").describe("要启动实例的环境 ID。"),
});

/** 从环境启动实例的成功响应 */
export const SpawnInstanceFromEnvironmentResponseSchema = z.object({
  success: z.literal(true).describe("接口调用成功。"),
  data: InstanceInfoSchema.describe("新启动的实例信息。"),
});

/** GET /web/instances — 实例列表响应 */
export const InstanceListResponseSchema = InstanceInfoSchema.array();
export const InstanceActivityQuerySchema = z.object({
  all: z.coerce.boolean().optional().describe("跨组织查询不对控制台用户开放；传入 true 返回 403。"),
  showError: z.coerce.boolean().optional().describe("为 true 时额外返回 error 状态实例，便于排查问题。"),
});
export const InstanceActivityListResponseSchema = WebOkSchema(
  InstanceActivityInfoSchema.array().describe("实例活跃度列表。"),
).describe("实例活跃度列表响应。");

export type InstanceInfo = z.infer<typeof InstanceInfoSchema>;
export type InstanceActivityInfo = z.infer<typeof InstanceActivityInfoSchema>;
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>;
export type InstanceActivityQuery = z.infer<typeof InstanceActivityQuerySchema>;
export type SpawnInstanceFromEnvironmentRequest = z.infer<typeof SpawnInstanceFromEnvironmentRequestSchema>;
export type SpawnInstanceFromEnvironmentResponse = z.infer<typeof SpawnInstanceFromEnvironmentResponseSchema>;
export type InstanceListResponse = z.infer<typeof InstanceListResponseSchema>;
export type InstanceActivityListResponse = z.infer<typeof InstanceActivityListResponseSchema>;
