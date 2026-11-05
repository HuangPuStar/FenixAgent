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
      if (!known && !invalid)
        console.error("cluster request failed", { errorKind: error instanceof Error ? error.name : "UnknownError" });
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
        detail: { summary: "Create a resource-managed sandbox" },
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
        detail: { summary: "Read managed allocation lifecycle" },
      },
    )
    .delete(
      "/api/v2/sandboxes/:sandboxId",
      async ({ params, set }) => {
        const row = await lifecycle.release(params.sandboxId);
        if (["released", "expired", "failed"].includes(row.state)) {
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
        detail: { summary: "Destroy a managed sandbox and return its reservation" },
      },
    )
    .get("/api/v1/servers/:serverId/resources", ({ params }) => allocations.serverResources(params.serverId), {
      params: t.Object({ serverId: t.String({ minLength: 1 }) }),
      headers: managedHeaders,
      response: { 200: serverResourcesSchema, ...managedErrorResponses },
      detail: { summary: "Read node resource accounting" },
    })
    .get("/api/v1/pools/:poolId/resources", ({ params }) => allocations.poolResources(params.poolId), {
      params: t.Object({ poolId: t.String({ minLength: 1 }) }),
      headers: managedHeaders,
      response: {
        200: t.Object({ pool_id: t.String(), servers: t.Array(serverResourcesSchema) }),
        ...managedErrorResponses,
      },
      detail: { summary: "Read resource accounting by node" },
    });
}
