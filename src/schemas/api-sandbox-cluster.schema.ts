import * as z from "zod/v4";

export const SandboxClusterPoolIdParamsSchema = z.object({ poolId: z.string().min(1).describe("Cluster Pool ID。") });
export const SandboxClusterServerIdParamsSchema = z.object({
  serverId: z.string().min(1).describe("Cluster Server ID。"),
});
export const SandboxClusterServerListQuerySchema = z.object({
  pool_id: z.string().optional().describe("按 Cluster Pool ID 筛选。"),
});

export const SandboxClusterPoolCreateSchema = z.object({
  id: z.string().min(1).describe("Cluster Pool ID。"),
  name: z.string().min(1).describe("Cluster Pool 名称。"),
  status: z.string().optional().describe("Pool 状态。"),
});
export const SandboxClusterPoolUpdateSchema = z.object({
  name: z.string().min(1).optional().describe("Cluster Pool 名称。"),
  status: z.string().optional().describe("Pool 状态。"),
});
export const SandboxClusterServerCreateSchema = z.object({
  id: z.string().min(1).describe("Cluster Server ID。"),
  pool_id: z.string().min(1).describe("所属 Cluster Pool ID。"),
  name: z.string().min(1).describe("Cluster Server 名称。"),
  base_url: z.string().optional().describe("Cluster Server 基础 URL。"),
  workspace_root: z.string().min(1).describe("工作区根目录。"),
  api_key: z.string().min(1).describe("Cluster Server API Key。"),
  max_sandboxes: z.number().int().positive().describe("最大沙盒数量。"),
  status: z.string().optional().describe("Server 状态。"),
  transport_mode: z.enum(["direct", "tunnel"]).optional().describe("连接模式。"),
});
export const SandboxClusterServerUpdateSchema = SandboxClusterServerCreateSchema.partial().omit({ id: true });

export const SandboxClusterPoolSchema = z
  .object({
    id: z.string().describe("Cluster Pool ID。"),
    name: z.string().describe("Cluster Pool 名称。"),
    status: z.string().describe("Pool 状态。"),
  })
  .passthrough();
export const SandboxClusterPoolListResponseSchema = SandboxClusterPoolSchema.array().describe("Cluster Pool 列表。");
export const SandboxClusterServerSchema = z
  .object({
    id: z.string().describe("Cluster Server ID。"),
    poolId: z.string().describe("所属 Cluster Pool ID。"),
    name: z.string().describe("Cluster Server 名称。"),
    baseUrl: z.string().describe("Cluster Server 基础 URL。"),
    workspaceRoot: z.string().describe("工作区根目录。"),
    maxSandboxes: z.number().int().positive().describe("最大沙盒数量。"),
    status: z.string().describe("Server 状态。"),
    transportMode: z.enum(["direct", "tunnel"]).describe("连接模式。"),
    routeHost: z.string().nullable().describe("Tunnel 路由主机。"),
    healthStatus: z.string().describe("健康状态。"),
    lastHealthAt: z.number().nullable().describe("上次健康检查时间。"),
    lastError: z.string().nullable().describe("上次健康检查错误。"),
    currentSandboxes: z.number().int().nonnegative().describe("当前沙盒数量。"),
  })
  .passthrough();
export const SandboxClusterServerListResponseSchema = z
  .array(SandboxClusterServerSchema)
  .describe("Cluster Server 列表。");
export const SandboxClusterDeleteResponseSchema = z.unknown().describe("Cluster 删除操作响应。无响应体时为空。 ");
export const SandboxClusterActionResponseSchema = z
  .unknown()
  .describe("Cluster 操作响应。响应结构由 Cluster 服务决定。");
