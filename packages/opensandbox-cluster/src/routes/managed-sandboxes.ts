import { Elysia, t } from "elysia";
import {
  managedErrorResponses,
  managedHeaders,
  managedSandboxSchema,
  serverResourcesSchema,
} from "../schemas/managed-schemas";
import { isValidClusterApiKey } from "../security/api-auth";
import type { AllocationService } from "../services/allocation-service";
import { LifecycleError } from "../services/resource-allocation";
import type { SandboxLifecycleService } from "../services/sandbox-lifecycle-service";
import { SandboxVolumeRewriteError } from "../services/sandbox-volume-rewriter";
import type { ClusterConfig } from "../types";
/** Managed lifecycle and resource statistics retain the raw Cluster response contract. */
export function createManagedRoutes(
  config: ClusterConfig,
  allocations: AllocationService,
  lifecycle: SandboxLifecycleService,
) {
  return new Elysia({ name: "managed-sandboxes" })
    .onBeforeHandle(({ request, set }) => {
      if (!isValidClusterApiKey(request, config)) {
        set.status = 401;
        return { error: { code: "UNAUTHORIZED", message: "invalid cluster service credentials" } };
      }
    })
    .onError(({ error, code, set }) => {
      const known = error instanceof LifecycleError;
      const invalid = code === "VALIDATION" || error instanceof SandboxVolumeRewriteError;
      set.status = known ? error.status : invalid ? 400 : 500;
      return {
        error: {
          code: known ? error.code : invalid ? "INVALID_REQUEST" : "INTERNAL_ERROR",
          message: known ? error.message : invalid ? "invalid request" : "internal Cluster error",
        },
      };
    })
    .post(
      "/api/v2/pools/:poolId/sandboxes",
      async ({ params, body, set }) => {
        const result = await lifecycle.create(params.poolId, body);
        set.status = result.state === "active" ? 201 : 202;
        set.headers.Location = `/api/v2/sandboxes/${encodeURIComponent(result.sandbox_id)}`;
        return result;
      },
      {
        params: t.Object({ poolId: t.String({ minLength: 1 }) }),
        headers: managedHeaders,
        response: { 201: managedSandboxSchema, 202: managedSandboxSchema, ...managedErrorResponses },
        body: t.Object(
          {
            sandbox_id: t.String({ minLength: 1 }),
            lease_seconds: t.Optional(t.Integer({ minimum: 60 })),
            resources: t.Object({
              cpu: t.Number({ exclusiveMinimum: 0 }),
              memoryMb: t.Number({ exclusiveMinimum: 0 }),
              diskGb: t.Number({ exclusiveMinimum: 0 }),
              gpuCount: t.Integer({ minimum: 0 }),
              environment: t.Optional(t.Record(t.String(), t.String())),
              volumes: t.Optional(
                t.Array(
                  t.Object(
                    {
                      name: t.String({ minLength: 1 }),
                      source: t.String({ minLength: 1 }),
                      target: t.String({ minLength: 1 }),
                      readOnly: t.Optional(t.Boolean()),
                    },
                    { additionalProperties: false },
                  ),
                ),
              ),
            }),
            sandbox: t.Object(
              {
                image: t.Unknown(),
                entrypoint: t.Optional(t.Array(t.String())),
                metadata: t.Optional(t.Record(t.String(), t.String())),
              },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
        detail: {
          tags: ["沙盒"],
          summary: "创建资源模式沙盒",
          description:
            "预留同一节点的 CPU（核）、内存（MB）、硬盘（GB）和 GPU（数量）。201 创建成功；202 结果待确认，通过 Location 查询。lease_seconds 省略时使用池默认租期，重试不会延长租期。",
        },
      },
    )
    .get(
      "/api/v2/sandboxes/:sandboxId",
      ({ params }) => {
        const row = lifecycle.find(params.sandboxId);
        if (!row) throw new LifecycleError("NOT_FOUND", 404, "allocation not found");
        return row;
      },
      {
        params: t.Object({ sandboxId: t.String({ minLength: 1 }) }),
        headers: managedHeaders,
        response: { 200: managedSandboxSchema, ...managedErrorResponses },
        detail: {
          tags: ["沙盒"],
          summary: "查询资源模式沙盒",
          description: "返回 Cluster 生命周期与预留资源。原生运行状态通过 proxy_url 查询。",
        },
      },
    )
    .delete(
      "/api/v2/sandboxes/:sandboxId",
      async ({ params, set }) => {
        const row = await lifecycle.remove(params.sandboxId);
        if (!row) {
          set.status = 204;
          return new Response(null, { status: 204 });
        }
        set.status = 202;
        return row;
      },
      {
        params: t.Object({ sandboxId: t.String({ minLength: 1 }) }),
        headers: managedHeaders,
        response: { 202: managedSandboxSchema, 204: t.Void(), ...managedErrorResponses },
        detail: {
          tags: ["沙盒"],
          summary: "销毁资源模式沙盒并删除记录",
          description: "确认远端销毁后归还资源并删除记录，完成返回 204；回收中返回 202。终态记录可直接删除。",
        },
      },
    )
    .get("/api/v1/servers/:serverId/resources", ({ params }) => allocations.serverResources(params.serverId), {
      params: t.Object({ serverId: t.String({ minLength: 1 }) }),
      headers: managedHeaders,
      response: { 200: serverResourcesSchema, ...managedErrorResponses },
      detail: {
        tags: ["资源"],
        summary: "查询节点资源",
        description:
          "容量、已分配、待确认与剩余资源。pending 已包含在 allocated 中。CPU 核数、内存 MB、硬盘 GB、GPU 数量。",
      },
    })
    .get("/api/v1/pools/:poolId/resources", ({ params }) => allocations.poolResources(params.poolId), {
      params: t.Object({ poolId: t.String({ minLength: 1 }) }),
      headers: managedHeaders,
      response: {
        200: t.Object({ pool_id: t.String(), servers: t.Array(serverResourcesSchema) }),
        ...managedErrorResponses,
      },
      detail: {
        tags: ["资源"],
        summary: "逐节点查询池资源",
        description: "按节点返回资源统计；跨节点剩余量不能合并用于单次分配。",
      },
    });
}
