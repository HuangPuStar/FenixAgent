import { Elysia, t } from "elysia";
import { recordRequestError } from "../logging/http-logger";
import { managedErrorResponses, managedHeaders, resourceViewSchema } from "../schemas/managed-schemas";
import { isValidClusterApiKey } from "../security/api-auth";
import type { NodeReconciliationService } from "../services/node-reconciliation-service";
import { LifecycleError } from "../services/resource-allocation";
import type { ClusterConfig } from "../types";

/** Live node reconciliation is restricted to the Cluster administrator key. */
export function createNodeReconciliationRoutes(config: ClusterConfig, reconciliation: NodeReconciliationService) {
  return new Elysia({ name: "node-reconciliation", prefix: "/api/v1/servers" })
    .onBeforeHandle(({ request, set }) => {
      if (!isValidClusterApiKey(request, config)) {
        set.status = 401;
        return { error: { code: "UNAUTHORIZED", message: "invalid cluster service credentials" } };
      }
    })
    .onError(({ error, code, set, request }) => {
      recordRequestError(request, error);
      set.status = error instanceof LifecycleError ? error.status : code === "VALIDATION" ? 400 : 502;
      return {
        error: {
          code:
            error instanceof LifecycleError
              ? error.code
              : code === "VALIDATION"
                ? "INVALID_REQUEST"
                : "NODE_REQUEST_FAILED",
          message:
            error instanceof LifecycleError
              ? error.message
              : code === "VALIDATION"
                ? "invalid request"
                : "node reconciliation failed",
        },
      };
    })
    .get(
      "/:serverId/unbound-sandboxes",
      ({ params, query }) => reconciliation.list(params.serverId, query.page, query.pageSize),
      {
        params: t.Object({ serverId: t.String({ minLength: 1 }) }),
        headers: managedHeaders,
        query: t.Object({
          page: t.Optional(t.Integer({ minimum: 1, maximum: 1000000 })),
          pageSize: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
        }),
        response: {
          200: t.Object({
            items: t.Array(
              t.Object({
                provider_sandbox_id: t.String(),
                created_at: t.Nullable(t.String()),
                expires_at: t.Nullable(t.String()),
                state: t.Nullable(t.String()),
                image: t.Nullable(t.String()),
                entrypoint: t.Array(t.String()),
                metadata: t.Record(t.String(), t.String()),
                attempt_id: t.Nullable(t.String()),
                resources: t.Nullable(resourceViewSchema),
              }),
            ),
            page: t.Number(),
            pageSize: t.Number(),
            hasNextPage: t.Boolean(),
          }),
          ...managedErrorResponses,
        },
        detail: {
          tags: ["沙盒"],
          summary: "查询节点未绑定沙盒",
          description:
            "逐页读取节点原生清单，排除真实 ID 或创建尝试标识已有绑定的沙盒。分页沿用节点清单，本页可能没有未绑定项。资源配额未由节点返回时为 null。",
        },
      },
    )
    .delete(
      "/:serverId/unbound-sandboxes/:sandboxId",
      async ({ params }) => {
        await reconciliation.remove(params.serverId, params.sandboxId);
        return new Response(null, { status: 204 });
      },
      {
        params: t.Object({ serverId: t.String({ minLength: 1 }), sandboxId: t.String({ minLength: 1 }) }),
        headers: managedHeaders,
        response: { 204: t.Void(), ...managedErrorResponses },
        detail: {
          tags: ["沙盒"],
          summary: "销毁节点未绑定沙盒",
          description: "销毁前重新核对绑定；已关联返回 409。确认节点返回不存在后返回 204。",
        },
      },
    );
}
