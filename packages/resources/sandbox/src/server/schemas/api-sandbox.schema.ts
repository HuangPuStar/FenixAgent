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
  .strict()
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
// 管理面只允许覆盖计算资源；环境变量和挂载卷由沙盒运行时维护，避免破坏工作空间与连接配置。
export const SandboxAdminResourceOverridesSchema = z
  .object({
    cpu: z.number().positive().nullable().optional(),
    memoryMb: z.number().positive().nullable().optional(),
    diskGb: z.number().positive().nullable().optional(),
    gpuCount: z.number().nonnegative().nullable().optional(),
  })
  .strict()
  .nullable();

export const SandboxInstanceUpdateBodySchema = z.object({
  resourceOverrides: SandboxAdminResourceOverridesSchema,
});
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

export const SandboxPoolResponseSchema = z
  .object({
    id: z.string().describe("资源池 ID。"),
    organizationId: z.string().nullable().describe("组织 ID；为空表示全局可用。"),
    organizationName: z.string().nullable().describe("组织名称；为空表示全局可用。"),
    name: z.string().describe("资源池名称。"),
    providerKey: z.string().describe("Provider 标识。"),
    image: z.string().describe("沙盒镜像。"),
    defaultResources: SandboxResourcesSchema.describe("资源池默认资源配置。"),
    extra: z.record(z.string(), z.unknown()).nullable().describe("Provider 扩展配置。"),
    createdAt: z.string().describe("创建时间。"),
    updatedAt: z.string().describe("更新时间。"),
  })
  .passthrough();
export const SandboxPoolListResponseSchema = SandboxPoolResponseSchema.array().describe("资源池列表。");

export const SandboxInstanceResponseSchema = z
  .object({
    id: z.string().describe("沙盒实例 ID。"),
    machineId: z.string().describe("Machine ID。"),
    providerKey: z.string().describe("Provider 标识。"),
    sandboxPoolId: z.string().describe("资源池 ID。"),
    userId: z.string().describe("用户 ID。"),
    externalSandboxId: z.string().nullable().describe("Provider 外部沙盒 ID。"),
    status: z.string().describe("实例状态。"),
    resolvedConfig: z.record(z.string(), z.unknown()).describe("当前生效的沙盒配置。"),
    resourceOverrides: SandboxAdminResourceOverridesSchema.describe("实例资源覆盖配置。"),
    providerPayload: z.unknown().describe("Provider 返回的诊断信息。"),
    lastHeartbeatAt: z.string().nullable().describe("上次心跳时间。"),
    createdAt: z.string().describe("创建时间。"),
    updatedAt: z.string().describe("更新时间。"),
    user: z.object({ id: z.string(), name: z.string(), email: z.string() }).describe("实例所属用户。"),
    machine: z
      .object({
        id: z.string(),
        name: z.string(),
        status: z.string(),
        lastHeartbeatAt: z.string().nullable(),
      })
      .describe("实例关联 Machine。"),
  })
  .passthrough();
export const SandboxInstanceListResponseSchema = z.object({
  items: SandboxInstanceResponseSchema.array().describe("沙盒实例列表。"),
  total: z.number().int().nonnegative().describe("实例总数。"),
  page: z.number().int().positive().describe("当前页码。"),
  pageSize: z.number().int().positive().describe("当前分页大小。"),
});
export const SandboxInstanceRebuildResponseSchema = z.object({
  items: z
    .object({
      instanceId: z.string().describe("实例 ID。"),
      changed: z.boolean().describe("配置是否发生变化。"),
      previousConfig: z.unknown().describe("重建前配置。"),
      nextConfig: z.unknown().describe("重建后配置。"),
      error: z.string().optional().describe("重建错误信息。"),
    })
    .array()
    .describe("重建结果列表。"),
});
export const SandboxDeleteResponseSchema = z.object({ deleted: z.boolean().describe("是否删除成功。") });

export type SandboxPoolCreateBody = z.infer<typeof SandboxPoolCreateBodySchema>;
export type SandboxPoolUpdateBody = z.infer<typeof SandboxPoolUpdateBodySchema>;
export type SandboxInstanceUpdateBody = z.infer<typeof SandboxInstanceUpdateBodySchema>;
export type SandboxInstanceRebuildBody = z.infer<typeof SandboxInstanceRebuildBodySchema>;
