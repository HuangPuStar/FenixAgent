import Elysia, { status } from "elysia";
import * as z from "zod/v4";
import { systemApiAuthPlugin } from "../../plugins/system-api-auth";
import { ApiErrorResponseSchema } from "../../schemas/api-common.schema";
import {
  SandboxClusterActionResponseSchema,
  SandboxClusterDeleteResponseSchema,
  SandboxClusterPoolCreateSchema,
  SandboxClusterPoolIdParamsSchema,
  SandboxClusterPoolListResponseSchema,
  SandboxClusterPoolSchema,
  SandboxClusterPoolUpdateSchema,
  SandboxClusterServerCreateSchema,
  SandboxClusterServerIdParamsSchema,
  SandboxClusterServerListQuerySchema,
  SandboxClusterServerListResponseSchema,
  SandboxClusterServerSchema,
  SandboxClusterServerUpdateSchema,
} from "../../schemas/api-sandbox-cluster.schema";
import {
  SandboxClusterAdminError,
  SandboxClusterUnavailableError,
  sandboxClusterAdminService,
} from "../../services/sandbox/sandbox-cluster-admin-service";

export function mapSandboxClusterAdminError(error: unknown): {
  status: 400 | 404 | 409 | 503;
  body: { error: { code: string; message: string } };
} {
  if (error instanceof SandboxClusterUnavailableError) {
    return { status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: error.message } } };
  }
  if (error instanceof SandboxClusterAdminError) {
    return {
      status: error.status >= 500 ? 503 : error.status === 404 ? 404 : error.status === 409 ? 409 : 400,
      body: { error: { code: error.status === 404 ? "NOT_FOUND" : "CLUSTER_ERROR", message: error.message } },
    };
  }
  return { status: 400, body: { error: { code: "BAD_REQUEST", message: "Cluster request failed" } } };
}

const app = new Elysia({ name: "api-sandbox-cluster", prefix: "/api/system/sandbox-cluster" })
  .use(systemApiAuthPlugin)
  .model({
    "sandbox-cluster-pool": SandboxClusterPoolSchema,
    "sandbox-cluster-pool-list": SandboxClusterPoolListResponseSchema,
    "sandbox-cluster-server": SandboxClusterServerSchema,
    "sandbox-cluster-server-list": SandboxClusterServerListResponseSchema,
  })
  .get(
    "/pools",
    async () => {
      try {
        return (await sandboxClusterAdminService.listPools()) as z.infer<typeof SandboxClusterPoolListResponseSchema>;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      response: {
        200: "sandbox-cluster-pool-list",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "获取 Cluster Pool 列表",
        description: "查询沙盒 Cluster 服务中的资源池列表。",
      },
    },
  )
  .post(
    "/pools",
    async ({ body }) => {
      try {
        return (await sandboxClusterAdminService.createPool(body)) as z.infer<typeof SandboxClusterPoolSchema>;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      body: SandboxClusterPoolCreateSchema,
      response: {
        200: "sandbox-cluster-pool",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "创建 Cluster Pool",
        description: "在沙盒 Cluster 服务中创建资源池。",
      },
    },
  )
  .get(
    "/pools/:poolId",
    async ({ params }) => {
      try {
        return (await sandboxClusterAdminService.getPool(params.poolId)) as z.infer<typeof SandboxClusterPoolSchema>;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxClusterPoolIdParamsSchema,
      response: {
        200: "sandbox-cluster-pool",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "获取 Cluster Pool 详情",
        description: "根据 Pool ID 查询 Cluster Pool 详情。",
      },
    },
  )
  .put(
    "/pools/:poolId",
    async ({ params, body }) => {
      try {
        return (await sandboxClusterAdminService.updatePool(params.poolId, body)) as z.infer<
          typeof SandboxClusterPoolSchema
        >;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxClusterPoolIdParamsSchema,
      body: SandboxClusterPoolUpdateSchema,
      response: {
        200: "sandbox-cluster-pool",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "更新 Cluster Pool",
        description: "更新指定 Cluster Pool 的名称或状态。",
      },
    },
  )
  .delete(
    "/pools/:poolId",
    async ({ params }) => {
      try {
        return (await sandboxClusterAdminService.deletePool(params.poolId)) as z.infer<
          typeof SandboxClusterDeleteResponseSchema
        >;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxClusterPoolIdParamsSchema,
      response: {
        200: SandboxClusterDeleteResponseSchema,
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "删除 Cluster Pool",
        description: "删除指定 Cluster Pool。",
      },
    },
  )
  .get(
    "/servers",
    async ({ query }) => {
      try {
        return (await sandboxClusterAdminService.listServers(query.pool_id)) as z.infer<
          typeof SandboxClusterServerListResponseSchema
        >;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      query: SandboxClusterServerListQuerySchema,
      response: {
        200: "sandbox-cluster-server-list",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "获取 Cluster Server 列表",
        description: "查询 Cluster Server 列表，可按 Pool ID 筛选。",
      },
    },
  )
  .post(
    "/servers",
    async ({ body }) => {
      try {
        return (await sandboxClusterAdminService.createServer(body)) as z.infer<typeof SandboxClusterServerSchema>;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      body: SandboxClusterServerCreateSchema,
      response: {
        200: "sandbox-cluster-server",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "创建 Cluster Server",
        description: "在沙盒 Cluster 服务中注册 Server。",
      },
    },
  )
  .get(
    "/servers/:serverId",
    async ({ params }) => {
      try {
        return (await sandboxClusterAdminService.getServer(params.serverId)) as z.infer<
          typeof SandboxClusterServerSchema
        >;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxClusterServerIdParamsSchema,
      response: {
        200: "sandbox-cluster-server",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "获取 Cluster Server 详情",
        description: "根据 Server ID 查询 Cluster Server 详情。",
      },
    },
  )
  .put(
    "/servers/:serverId",
    async ({ params, body }) => {
      try {
        return (await sandboxClusterAdminService.updateServer(params.serverId, body)) as z.infer<
          typeof SandboxClusterServerSchema
        >;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxClusterServerIdParamsSchema,
      body: SandboxClusterServerUpdateSchema,
      response: {
        200: "sandbox-cluster-server",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "更新 Cluster Server",
        description: "更新指定 Cluster Server 的连接和运行参数。",
      },
    },
  )
  .delete(
    "/servers/:serverId",
    async ({ params }) => {
      try {
        return (await sandboxClusterAdminService.deleteServer(params.serverId)) as z.infer<
          typeof SandboxClusterDeleteResponseSchema
        >;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxClusterServerIdParamsSchema,
      response: {
        200: SandboxClusterDeleteResponseSchema,
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "删除 Cluster Server",
        description: "删除指定 Cluster Server。",
      },
    },
  )
  .post(
    "/servers/:serverId/health-check",
    async ({ params }) => {
      try {
        return (await sandboxClusterAdminService.healthCheck(params.serverId)) as z.infer<
          typeof SandboxClusterServerSchema
        >;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxClusterServerIdParamsSchema,
      response: {
        200: SandboxClusterActionResponseSchema,
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "检查 Cluster Server 健康状态",
        description: "请求 Cluster 服务检查指定 Server 的健康状态。",
      },
    },
  )
  .put(
    "/servers/:serverId/tunnel",
    async ({ params }) => {
      try {
        return (await sandboxClusterAdminService.prepareTunnel(params.serverId)) as z.infer<
          typeof SandboxClusterActionResponseSchema
        >;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxClusterServerIdParamsSchema,
      response: {
        200: SandboxClusterActionResponseSchema,
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "准备 Cluster Server Tunnel",
        description: "为指定 Cluster Server 准备 Tunnel 连接。",
      },
    },
  )
  .get(
    "/servers/:serverId/tunnel/frpc.toml",
    async ({ params, set }) => {
      try {
        const content = await sandboxClusterAdminService.downloadTunnelConfig(params.serverId);
        set.headers["content-type"] = "application/toml; charset=utf-8";
        set.headers["content-disposition"] = `attachment; filename="${params.serverId}.frpc.toml"`;
        set.headers["cache-control"] = "no-store";
        return content;
      } catch (err) {
        const mapped = mapSandboxClusterAdminError(err);
        return status(mapped.status, mapped.body);
      }
    },
    {
      systemApiKeyAuth: true,
      params: SandboxClusterServerIdParamsSchema,
      response: {
        200: z.string(),
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["System Sandbox"],
        summary: "下载 Cluster Server Tunnel 配置",
        description: "下载指定 Cluster Server 的 frpc TOML 配置文件。",
      },
    },
  );

export default app;
