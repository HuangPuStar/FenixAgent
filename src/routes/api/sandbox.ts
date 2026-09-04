import { SandboxProviderError } from "@fenix/sandbox-provider";
import Elysia, { status } from "elysia";
import type * as z from "zod/v4";
import { systemApiAuthPlugin } from "../../plugins/system-api-auth";
import { ApiErrorResponseSchema } from "../../schemas/api-common.schema";
import {
  SandboxDeleteResponseSchema,
  SandboxInstanceIdParamsSchema,
  SandboxInstanceListQuerySchema,
  SandboxInstanceListResponseSchema,
  SandboxInstanceRebuildBodySchema,
  SandboxInstanceRebuildResponseSchema,
  SandboxInstanceResponseSchema,
  SandboxInstanceUpdateBodySchema,
  SandboxPoolCreateBodySchema,
  SandboxPoolIdParamsSchema,
  SandboxPoolListQuerySchema,
  SandboxPoolListResponseSchema,
  SandboxPoolResponseSchema,
  SandboxPoolUpdateBodySchema,
} from "../../schemas/api-sandbox.schema";
import * as sandboxApi from "../../services/sandbox/sandbox-admin-service";
import { SandboxProviderNotConfiguredError, SandboxRuntimeNotReadyError } from "../../services/sandbox/sandbox-errors";

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" ||
    (typeof candidate.message === "string" &&
      (candidate.message.includes("duplicate key") || candidate.message.includes("unique constraint"))) ||
    isUniqueConstraintError(candidate.cause)
  );
}

export function mapSandboxApiError(error: unknown): {
  status: 400 | 404 | 409 | 502 | 503;
  body: { error: { code: string; message: string } };
} {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (error instanceof SandboxProviderNotConfiguredError || error instanceof SandboxRuntimeNotReadyError) {
    // message 固定通用文案：ProviderNotConfiguredError 携带 providerKey、
    // RuntimeNotReadyError 携带 sbi_* sandboxId，透传给 /api/system 调用方属泄漏
    return { status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: "Sandbox service is unavailable" } } };
  }
  if (error instanceof SandboxProviderError) {
    if (error.code === "NOT_FOUND") {
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "Sandbox resource was not found" } } };
    }
    if (error.code === "INVALID_REQUEST") {
      return { status: 400, body: { error: { code: "BAD_REQUEST", message: "Sandbox request is invalid" } } };
    }
    const unavailable = error.code === "UNAVAILABLE" || error.status === 503;
    return {
      status: unavailable ? 503 : 502,
      body: {
        error: {
          code: unavailable ? "SERVICE_UNAVAILABLE" : "BAD_GATEWAY",
          message: unavailable ? "Sandbox service is unavailable" : "Sandbox provider request failed",
        },
      },
    };
  }
  if (message.includes("not found")) return { status: 404, body: { error: { code: "NOT_FOUND", message } } };
  if (
    isUniqueConstraintError(error) ||
    message.includes("already exists") ||
    message.includes("existing sandbox instances")
  ) {
    return { status: 409, body: { error: { code: "CONFLICT", message } } };
  }
  return { status: 400, body: { error: { code: "BAD_REQUEST", message } } };
}

const app = new Elysia({ name: "api-sandbox", prefix: "/api/system" }).use(systemApiAuthPlugin).model({
  "sandbox-pool-id": SandboxPoolIdParamsSchema,
  "sandbox-instance-id": SandboxInstanceIdParamsSchema,
  "sandbox-pool-list-query": SandboxPoolListQuerySchema,
  "sandbox-instance-list-query": SandboxInstanceListQuerySchema,
  "sandbox-pool-create": SandboxPoolCreateBodySchema,
  "sandbox-pool-update": SandboxPoolUpdateBodySchema,
  "sandbox-instance-update": SandboxInstanceUpdateBodySchema,
  "sandbox-instance-rebuild": SandboxInstanceRebuildBodySchema,
  "sandbox-pool": SandboxPoolResponseSchema,
  "sandbox-pool-list": SandboxPoolListResponseSchema,
  "sandbox-instance": SandboxInstanceResponseSchema,
  "sandbox-instance-list": SandboxInstanceListResponseSchema,
  "sandbox-instance-rebuild-response": SandboxInstanceRebuildResponseSchema,
  "sandbox-delete-response": SandboxDeleteResponseSchema,
});

app.get(
  "/sandbox-pools",
  async ({ query }) => {
    try {
      return (await sandboxApi.listPools(query)) as z.infer<typeof SandboxPoolListResponseSchema>;
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return status(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    query: "sandbox-pool-list-query",
    response: {
      200: "sandbox-pool-list",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      502: ApiErrorResponseSchema,
      503: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["System Sandbox"],
      summary: "获取沙盒资源池列表",
      description: "查询系统中的沙盒资源池，支持按组织和 Provider 筛选。",
    },
  },
);

app.post(
  "/sandbox-pools",
  async ({ body }) => {
    try {
      return (await sandboxApi.createPool(body)) as z.infer<typeof SandboxPoolResponseSchema>;
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return status(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    body: "sandbox-pool-create",
    response: {
      200: "sandbox-pool",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      502: ApiErrorResponseSchema,
      503: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["System Sandbox"],
      summary: "创建沙盒资源池",
      description: "创建一个新的沙盒资源池。资源池 ID 已存在时返回冲突错误。",
    },
  },
);

app.get(
  "/sandbox-pools/:poolId",
  async ({ params }) => {
    try {
      return (await sandboxApi.getPool(params.poolId)) as z.infer<typeof SandboxPoolResponseSchema>;
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return status(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "sandbox-pool-id",
    response: {
      200: "sandbox-pool",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      502: ApiErrorResponseSchema,
      503: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["System Sandbox"],
      summary: "获取沙盒资源池详情",
      description: "根据资源池 ID 获取完整配置，包括镜像、默认资源和 extra。",
    },
  },
);

app.put(
  "/sandbox-pools/:poolId",
  async ({ params, body }) => {
    try {
      return (await sandboxApi.updatePool(params.poolId, body)) as z.infer<typeof SandboxPoolResponseSchema>;
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return status(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "sandbox-pool-id",
    body: "sandbox-pool-update",
    response: {
      200: "sandbox-pool",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      502: ApiErrorResponseSchema,
      503: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["System Sandbox"],
      summary: "更新沙盒资源池",
      description: "更新指定资源池的组织、镜像、默认资源和 Provider 扩展配置。",
    },
  },
);

app.delete(
  "/sandbox-pools/:poolId",
  async ({ params }) => {
    try {
      return (await sandboxApi.deletePool(params.poolId)) as z.infer<typeof SandboxDeleteResponseSchema>;
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return status(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "sandbox-pool-id",
    response: {
      200: "sandbox-delete-response",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      502: ApiErrorResponseSchema,
      503: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["System Sandbox"],
      summary: "删除沙盒资源池",
      description: "删除指定资源池；资源池存在沙盒实例时不会删除。",
    },
  },
);

app.get(
  "/sandbox-instances",
  async ({ query }) => {
    try {
      return (await sandboxApi.listInstances(query)) as z.infer<typeof SandboxInstanceListResponseSchema>;
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return status(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    query: "sandbox-instance-list-query",
    response: {
      200: "sandbox-instance-list",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      502: ApiErrorResponseSchema,
      503: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["System Sandbox"],
      summary: "获取沙盒实例列表",
      description: "分页查询沙盒实例，支持按用户、资源池、Provider 和状态筛选。",
    },
  },
);

app.get(
  "/sandbox-instances/:instanceId",
  async ({ params }) => {
    try {
      return (await sandboxApi.getInstance(params.instanceId)) as z.infer<typeof SandboxInstanceResponseSchema>;
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return status(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "sandbox-instance-id",
    response: {
      200: "sandbox-instance",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      502: ApiErrorResponseSchema,
      503: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["System Sandbox"],
      summary: "获取沙盒实例详情",
      description: "根据实例 ID 获取实例状态、用户、Machine、Provider Payload 和当前生效配置。",
    },
  },
);

app.put(
  "/sandbox-instances/:instanceId",
  async ({ params, body }) => {
    try {
      return (await sandboxApi.updateInstance(params.instanceId, body.resourceOverrides)) as z.infer<
        typeof SandboxInstanceResponseSchema
      >;
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return status(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "sandbox-instance-id",
    body: "sandbox-instance-update",
    response: {
      200: "sandbox-instance",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      502: ApiErrorResponseSchema,
      503: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["System Sandbox"],
      summary: "修改沙盒实例资源覆盖",
      description: "修改实例 CPU、内存、磁盘和 GPU 覆盖值；传 null 可取消对应字段覆盖。",
    },
  },
);

app.delete(
  "/sandbox-instances/:instanceId",
  async ({ params }) => {
    try {
      return (await sandboxApi.deleteInstance(params.instanceId)) as z.infer<typeof SandboxDeleteResponseSchema>;
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return status(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "sandbox-instance-id",
    response: {
      200: "sandbox-delete-response",
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      400: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      502: ApiErrorResponseSchema,
      503: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["System Sandbox"],
      summary: "删除沙盒实例",
      description: "销毁 Provider 资源并删除指定沙盒实例。",
    },
  },
);

app.post(
  "/sandbox-instances/rebuild",
  async ({ body }) => {
    try {
      return (await sandboxApi.rebuildInstances(body)) as z.infer<typeof SandboxInstanceRebuildResponseSchema>;
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return status(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    body: "sandbox-instance-rebuild",
    response: {
      200: "sandbox-instance-rebuild-response",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      502: ApiErrorResponseSchema,
      503: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["System Sandbox"],
      summary: "重建沙盒实例",
      description: "按资源池最新配置销毁旧 Provider 资源并将实例置为 stopped，不会自动创建新资源。",
    },
  },
);

export default app;
