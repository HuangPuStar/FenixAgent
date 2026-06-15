import * as z from "zod/v4";

/** 机器注册记录 */
export const MachineSchema = z.object({
  id: z.string().describe("机器 ID。"),
  organizationId: z.string().nullable().describe("所属组织 ID；没有组织隔离时为 null。"),
  userId: z.string().nullable().describe("关联用户 ID；未绑定时为 null。"),
  agentName: z.string().describe("机器展示名称。"),
  status: z.string().describe("机器当前状态，例如 online、offline。"),
  machineInfo: z.record(z.string(), z.unknown()).nullable().describe("机器基础信息，例如 hostname、ip、os、arch。"),
  labels: z.string().array().nullable().describe("机器标签列表。"),
  maxSessions: z.number().describe("机器允许的最大会话数。"),
  heartbeatIntervalMs: z.number().describe("心跳上报间隔，单位为毫秒。"),
  lastHeartbeatAt: z.number().nullable().describe("最近一次心跳时间戳，单位为秒；未收到时为 null。"),
  registeredAt: z.number().describe("机器注册时间戳，单位为秒。"),
  createdAt: z.number().describe("记录创建时间戳，单位为秒。"),
  updatedAt: z.number().describe("记录更新时间戳，单位为秒。"),
});

/** 注册表事件 */
export const RegistryEventSchema = z.object({
  id: z.string().describe("事件 ID。"),
  machineId: z.string().describe("所属机器 ID。"),
  type: z.string().describe("事件类型。"),
  detail: z.record(z.string(), z.unknown()).nullable().describe("事件详情负载。"),
  createdAt: z.number().describe("事件创建时间戳，单位为秒。"),
});

/** 机器详情 */
export const MachineDetailSchema = MachineSchema.extend({
  recentEvents: RegistryEventSchema.array().describe("该机器最近的事件列表。"),
});

/** 机器列表响应 */
export const MachineListResponseSchema = z.object({
  data: MachineSchema.array().describe("机器列表。"),
  total: z.number().describe("机器总数。"),
});

/** 机器详情响应 */
export const MachineDetailResponseSchema = z.object({
  data: MachineDetailSchema.describe("机器详情。"),
});

/** 机器事件列表响应 */
export const RegistryEventListResponseSchema = z.object({
  data: RegistryEventSchema.array().describe("事件列表。"),
  total: z.number().describe("事件总数。"),
});

/** 机器列表查询参数 */
export const MachineQuerySchema = z.object({
  status: z.string().optional().describe("按机器状态过滤。"),
  labels: z.string().optional().describe("按逗号分隔的标签过滤。"),
  tenantId: z.string().optional().describe("预留的租户 ID 过滤字段。"),
  userId: z.string().optional().describe("预留的用户 ID 过滤字段。"),
  limit: z.coerce.number().int().positive().max(100).optional().default(20).describe("分页大小。"),
  offset: z.coerce.number().int().min(0).optional().default(0).describe("分页偏移量。"),
});

/** 机器事件查询参数 */
export const EventQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(20).describe("分页大小。"),
  offset: z.coerce.number().int().min(0).optional().default(0).describe("分页偏移量。"),
});

export type Machine = z.infer<typeof MachineSchema>;
export type MachineDetail = z.infer<typeof MachineDetailSchema>;
export type RegistryEvent = z.infer<typeof RegistryEventSchema>;
export type MachineListResponse = z.infer<typeof MachineListResponseSchema>;
export type MachineDetailResponse = z.infer<typeof MachineDetailResponseSchema>;
export type RegistryEventListResponse = z.infer<typeof RegistryEventListResponseSchema>;
export type MachineQuery = z.infer<typeof MachineQuerySchema>;
export type EventQuery = z.infer<typeof EventQuerySchema>;
