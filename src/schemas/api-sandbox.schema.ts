import * as z from "zod/v4";

const SandboxVolumeSchema = z.object({
  name: z.string().min(1),
  source: z.string().optional(),
  target: z.string().min(1),
  readOnly: z.boolean().optional(),
});

export const SandboxResourcesSchema = z.object({
  cpu: z.number().positive(),
  memoryMb: z.number().positive(),
  diskGb: z.number().positive(),
  gpuCount: z.number().nonnegative(),
  environment: z.record(z.string(), z.string()),
  volumes: SandboxVolumeSchema.array(),
});

export const SandboxResourceOverridesSchema = z
  .object({
    cpu: z.number().positive().optional(),
    memoryMb: z.number().positive().optional(),
    diskGb: z.number().positive().optional(),
    gpuCount: z.number().nonnegative().optional(),
    environment: z.record(z.string(), z.string()).optional(),
    volumes: SandboxVolumeSchema.array().optional(),
  })
  .nullable();

export const SandboxPoolCreateBodySchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().nullable().optional(),
  name: z.string().min(1),
  providerKey: z.string().min(1),
  image: z.string().min(1),
  defaultResources: SandboxResourcesSchema,
  extra: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const SandboxPoolUpdateBodySchema = SandboxPoolCreateBodySchema.omit({ id: true });
export const SandboxInstanceUpdateBodySchema = z.object({ resourceOverrides: SandboxResourceOverridesSchema });
export const SandboxInstanceRebuildBodySchema = z
  .object({
    sandboxPoolId: z.string().min(1),
    instanceIds: z.string().min(1).array().optional().default([]),
    userIds: z.string().min(1).array().optional().default([]),
    dryRun: z.boolean().optional().default(false),
  })
  .refine((body) => body.instanceIds.length === 0 || body.userIds.length === 0, {
    message: "instanceIds and userIds cannot both be non-empty",
    path: ["instanceIds"],
  });

export const SandboxPoolIdParamsSchema = z.object({ poolId: z.string().min(1) });
export const SandboxInstanceIdParamsSchema = z.object({ instanceId: z.string().min(1) });
export const SandboxPoolListQuerySchema = z.object({
  organization_id: z.string().optional(),
  provider_key: z.string().optional(),
});
export const SandboxInstanceListQuerySchema = z.object({
  user_id: z.string().optional(),
  sandbox_pool_id: z.string().optional(),
  provider_key: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(20),
});

export type SandboxPoolCreateBody = z.infer<typeof SandboxPoolCreateBodySchema>;
export type SandboxPoolUpdateBody = z.infer<typeof SandboxPoolUpdateBodySchema>;
export type SandboxInstanceUpdateBody = z.infer<typeof SandboxInstanceUpdateBodySchema>;
export type SandboxInstanceRebuildBody = z.infer<typeof SandboxInstanceRebuildBodySchema>;
