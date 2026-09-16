import * as z from "zod/v4";

export const SandboxServerIdParamsSchema = z.object({ serverId: z.string().min(1).describe("Cluster Server ID。") });
export const SandboxServerSandboxParamsSchema = z.object({
  serverId: z.string().min(1).describe("Cluster Server ID。"),
  sandboxId: z.string().min(1).describe("OpenSandbox 远程沙盒 ID。"),
});

export const RemoteSandboxListQuerySchema = z.object({
  state: z.string().optional().describe("按 OpenSandbox 生命周期状态筛选。"),
  metadata: z.string().optional().describe("OpenSandbox metadata 过滤表达式。"),
  page: z.coerce.number().int().min(1).default(1).describe("页码。"),
  page_size: z.coerce.number().int().min(1).max(200).default(20).describe("每页数量。"),
});

export const RemoteSandboxStatusSchema = z
  .object({
    state: z.string(),
    reason: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
    lastTransitionAt: z.string().nullable().optional(),
  })
  .passthrough();

export const RemoteSandboxSchema = z
  .object({
    id: z.string(),
    status: RemoteSandboxStatusSchema,
    createdAt: z.string(),
  })
  .passthrough();

export const RemoteSandboxListResponseSchema = z.object({
  items: RemoteSandboxSchema.array(),
  pagination: z
    .object({
      page: z.number().int(),
      pageSize: z.number().int(),
      totalItems: z.number().int(),
      totalPages: z.number().int(),
      hasNextPage: z.boolean(),
    })
    .passthrough(),
});

export const SandboxServerCommandBodySchema = z
  .object({
    command: z.string().min(1).max(10_000).describe("要执行的 Shell 命令。"),
    cwd: z.string().min(1).max(4_096).optional().describe("命令工作目录。"),
    background: z.boolean().optional().default(false).describe("是否后台执行。"),
    timeout: z.number().int().min(1_000).max(120_000).optional().default(30_000).describe("超时时间，单位毫秒。"),
  })
  .strict();

export type RemoteSandboxListQuery = z.infer<typeof RemoteSandboxListQuerySchema>;
export type SandboxServerCommandBody = z.infer<typeof SandboxServerCommandBodySchema>;
