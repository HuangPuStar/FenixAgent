import { Elysia } from "elysia";
import { isValidClusterApiKey } from "../security/api-auth";
import { AllocationError, type AllocationService } from "../services/allocation-service";
import { LifecycleError } from "../services/resource-allocation";
import type { ClusterConfig } from "../types";

export function createAllocationRoutes(config: ClusterConfig, allocations: AllocationService) {
  return new Elysia({ name: "cluster-allocation", prefix: "/api/v1" })
    .onBeforeHandle(({ request, set }) => {
      if (!isValidClusterApiKey(request, config)) {
        set.status = 401;
        return { error: { code: "UNAUTHORIZED", message: "invalid cluster service credentials" } };
      }
    })
    .onError(({ error, set }) => {
      const message = error instanceof Error ? error.message : "request failed";
      const notFound = message === "pool not found" || message === "allocation not found";
      set.status =
        error instanceof LifecycleError ? error.status : error instanceof AllocationError ? 409 : notFound ? 404 : 400;
      return {
        error: {
          code:
            error instanceof LifecycleError
              ? error.code
              : error instanceof AllocationError
                ? "NO_CAPACITY"
                : notFound
                  ? "NOT_FOUND"
                  : "INVALID_REQUEST",
          message,
        },
      };
    })
    .post("/pools/:poolId/sandboxes/:sandboxId/allocate", ({ params, request }) =>
      allocations.allocate(params.poolId, params.sandboxId, request.headers.get("if-none-match") === "*"),
    )
    .get(
      "/sandboxes/:sandboxId/allocation",
      ({ params }) =>
        allocations.find(params.sandboxId) ??
        (() => {
          throw new Error("allocation not found");
        })(),
    )
    .delete("/sandboxes/:sandboxId/allocation", ({ params, request }) => {
      const match = request.headers.get("if-match");
      const expected: unknown = match === null ? undefined : JSON.parse(match);
      if (expected !== undefined && typeof expected !== "string") throw new Error("invalid If-Match");
      return allocations.release(params.sandboxId, expected);
    });
}
