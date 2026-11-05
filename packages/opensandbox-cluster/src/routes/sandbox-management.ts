import { Elysia, t } from "elysia";
import { managedErrorResponses, managedHeaders } from "../schemas/managed-schemas";
import { isValidClusterApiKey } from "../security/api-auth";
import { ProxyError } from "../services/proxy-service";
import { LifecycleError } from "../services/resource-allocation";
import type { SandboxManagementService } from "../services/sandbox-management-service";
import type { ClusterConfig } from "../types";

const paging = {
  page: t.Optional(t.Numeric({ minimum: 1, maximum: 1000000, multipleOf: 1 })),
  pageSize: t.Optional(t.Numeric({ minimum: 1, maximum: 200, multipleOf: 1 })),
};
const allocation = t.Object({
  sandbox_id: t.String(),
  pool_id: t.String(),
  server_id: t.String(),
  proxy_url: t.String(),
  allocation_mode: t.String(),
  allocation_etag: t.String(),
  provider_sandbox_id: t.Nullable(t.String()),
  state: t.String(),
  expires_at: t.Nullable(t.Number()),
});
/** Authenticated allocation queries for the management UI. */
export function createSandboxManagementRoutes(config: ClusterConfig, management: SandboxManagementService) {
  return new Elysia({ name: "sandbox-management", prefix: "/api/v1" })
    .onBeforeHandle(({ request, set }) => {
      if (!isValidClusterApiKey(request, config)) {
        set.status = 401;
        return { error: { code: "UNAUTHORIZED", message: "invalid cluster service credentials" } };
      }
    })
    .onError(({ error, code, set }) => {
      const known = error instanceof LifecycleError || error instanceof ProxyError;
      set.status = known ? error.status : code === "VALIDATION" ? 400 : 500;
      return {
        error: {
          code: known ? error.code : code === "VALIDATION" ? "INVALID_REQUEST" : "INTERNAL_ERROR",
          message: known ? error.message : code === "VALIDATION" ? "invalid request" : "sandbox management failed",
        },
      };
    })
    .get("/sandbox-allocations", ({ query }) => management.list(query), {
      headers: managedHeaders,
      query: t.Object({
        ...paging,
        pool_id: t.Optional(t.String()),
        server_id: t.Optional(t.String()),
        allocation_mode: t.Optional(t.Union([t.Literal("count"), t.Literal("resources")])),
        state: t.Optional(
          t.Union([
            t.Literal("creating"),
            t.Literal("active"),
            t.Literal("uncertain"),
            t.Literal("releasing"),
            t.Literal("released"),
            t.Literal("expired"),
            t.Literal("failed"),
          ]),
        ),
      }),
      response: {
        200: t.Object({
          items: t.Array(
            t.Intersect([
              allocation,
              t.Object({
                resources: t.Nullable(
                  t.Object({
                    cpu: t.Nullable(t.Number()),
                    memoryMb: t.Nullable(t.Number()),
                    diskGb: t.Nullable(t.Number()),
                    gpuCount: t.Nullable(t.Number()),
                  }),
                ),
                created_at: t.Number(),
              }),
            ]),
          ),
          total: t.Number(),
          page: t.Number(),
          pageSize: t.Number(),
        }),
        ...managedErrorResponses,
      },
      detail: {
        tags: ["沙盒"],
        summary: "分页查询沙盒绑定",
        description:
          "支持数量模式和资源模式。resources 为已记录配额，历史数量绑定可能未记录；state 是绑定生命周期，原生运行状态通过 proxy_url 查询。",
      },
    });
}
