import * as z from "zod/v4";

export const MachineSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  userId: z.string().nullable(),
  agentName: z.string(),
  status: z.string(),
  machineInfo: z.record(z.string(), z.unknown()).nullable(),
  labels: z.string().array().nullable(),
  supportedEngineTypes: z.array(z.object({ type: z.string(), cliPath: z.string().optional() })).nullable(),
  maxSessions: z.number(),
  heartbeatIntervalMs: z.number(),
  lastHeartbeatAt: z.number().nullable(),
  registeredAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const RegistryEventSchema = z.object({
  id: z.string(),
  machineId: z.string(),
  type: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.number(),
});

export const MachineDetailSchema = MachineSchema.extend({
  recentEvents: RegistryEventSchema.array(),
});

export const MachineListResponseSchema = z.object({
  data: MachineSchema.array(),
  total: z.number(),
});

export const MachineDetailResponseSchema = z.object({
  data: MachineDetailSchema,
});

export const RegistryEventListResponseSchema = z.object({
  data: RegistryEventSchema.array(),
  total: z.number(),
});

export const MachineQuerySchema = z.object({
  status: z.string().optional(),
  labels: z.string().optional(),
  tenantId: z.string().optional(),
  userId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const EventQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type Machine = z.infer<typeof MachineSchema>;
export type MachineDetail = z.infer<typeof MachineDetailSchema>;
export type RegistryEvent = z.infer<typeof RegistryEventSchema>;
export type MachineListResponse = z.infer<typeof MachineListResponseSchema>;
export type MachineDetailResponse = z.infer<typeof MachineDetailResponseSchema>;
export type RegistryEventListResponse = z.infer<typeof RegistryEventListResponseSchema>;
export type MachineQuery = z.infer<typeof MachineQuerySchema>;
export type EventQuery = z.infer<typeof EventQuerySchema>;
