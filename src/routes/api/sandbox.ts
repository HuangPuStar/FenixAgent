import { SandboxProviderError } from "@fenix/sandbox-provider";
import Elysia from "elysia";
import { systemApiAuthPlugin } from "../../plugins/system-api-auth";
import {
  SandboxInstanceIdParamsSchema,
  SandboxInstanceListQuerySchema,
  SandboxInstanceRebuildBodySchema,
  SandboxInstanceUpdateBodySchema,
  SandboxPoolCreateBodySchema,
  SandboxPoolIdParamsSchema,
  SandboxPoolListQuerySchema,
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
  status: number;
  body: { error: { code: string; message: string } };
} {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (error instanceof SandboxProviderNotConfiguredError || error instanceof SandboxRuntimeNotReadyError) {
    return { status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message } } };
  }
  if (error instanceof SandboxProviderError) {
    if (error.code === "NOT_FOUND") {
      return { status: 404, body: { error: { code: "NOT_FOUND", message } } };
    }
    if (error.code === "INVALID_REQUEST") {
      return { status: 400, body: { error: { code: "BAD_REQUEST", message } } };
    }
    const unavailable = error.code === "UNAVAILABLE" || error.status === 503;
    return {
      status: unavailable ? 503 : 502,
      body: { error: { code: unavailable ? "SERVICE_UNAVAILABLE" : "BAD_GATEWAY", message } },
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
});

app.get(
  "/sandbox-pools",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 上下文与 schema 组合时类型推断受限（同 acp/index.ts 模式）
  async ({ query, error }: any) => {
    try {
      return await sandboxApi.listPools(query);
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  { systemApiKeyAuth: true, query: "sandbox-pool-list-query" },
);

app.post(
  "/sandbox-pools",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 上下文与 schema 组合时类型推断受限（同 acp/index.ts 模式）
  async ({ body, error }: any) => {
    try {
      return await sandboxApi.createPool(body);
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  { systemApiKeyAuth: true, body: "sandbox-pool-create" },
);

app.get(
  "/sandbox-pools/:poolId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 上下文与 schema 组合时类型推断受限（同 acp/index.ts 模式）
  async ({ params, error }: any) => {
    try {
      return await sandboxApi.getPool(params.poolId);
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  { systemApiKeyAuth: true, params: "sandbox-pool-id" },
);

app.put(
  "/sandbox-pools/:poolId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 上下文与 schema 组合时类型推断受限（同 acp/index.ts 模式）
  async ({ params, body, error }: any) => {
    try {
      return await sandboxApi.updatePool(params.poolId, body);
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  { systemApiKeyAuth: true, params: "sandbox-pool-id", body: "sandbox-pool-update" },
);

app.delete(
  "/sandbox-pools/:poolId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 上下文与 schema 组合时类型推断受限（同 acp/index.ts 模式）
  async ({ params, error }: any) => {
    try {
      return await sandboxApi.deletePool(params.poolId);
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  { systemApiKeyAuth: true, params: "sandbox-pool-id" },
);

app.get(
  "/sandbox-instances",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 上下文与 schema 组合时类型推断受限（同 acp/index.ts 模式）
  async ({ query, error }: any) => {
    try {
      return await sandboxApi.listInstances(query);
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  { systemApiKeyAuth: true, query: "sandbox-instance-list-query" },
);

app.get(
  "/sandbox-instances/:instanceId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 上下文与 schema 组合时类型推断受限（同 acp/index.ts 模式）
  async ({ params, error }: any) => {
    try {
      return await sandboxApi.getInstance(params.instanceId);
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  { systemApiKeyAuth: true, params: "sandbox-instance-id" },
);

app.put(
  "/sandbox-instances/:instanceId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 上下文与 schema 组合时类型推断受限（同 acp/index.ts 模式）
  async ({ params, body, error }: any) => {
    try {
      return await sandboxApi.updateInstance(params.instanceId, body.resourceOverrides);
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  { systemApiKeyAuth: true, params: "sandbox-instance-id", body: "sandbox-instance-update" },
);

app.delete(
  "/sandbox-instances/:instanceId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 上下文与 schema 组合时类型推断受限（同 acp/index.ts 模式）
  async ({ params, error }: any) => {
    try {
      return await sandboxApi.deleteInstance(params.instanceId);
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  { systemApiKeyAuth: true, params: "sandbox-instance-id" },
);

app.post(
  "/sandbox-instances/rebuild",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 上下文与 schema 组合时类型推断受限（同 acp/index.ts 模式）
  async ({ body, error }: any) => {
    try {
      return await sandboxApi.rebuildInstances(body);
    } catch (err) {
      const mapped = mapSandboxApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  { systemApiKeyAuth: true, body: "sandbox-instance-rebuild" },
);

export default app;
