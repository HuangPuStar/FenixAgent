// GET /api/system/people-tree 的系统级人员层级视图响应 schema。

import * as z from "zod/v4";

export const SystemPeopleAgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  machineId: z.string().nullable(),
  engineType: z.string().nullable(),
});

export const SystemPeopleUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string().nullable(),
  agents: SystemPeopleAgentSchema.array(),
});

export const SystemPeopleOrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  users: SystemPeopleUserSchema.array(),
});

export const SystemPeopleTreeResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ organizations: SystemPeopleOrganizationSchema.array() }),
});
