import { Elysia } from "elysia";
import { isValidClusterApiKey } from "../security/api-auth";
import { AllocationError, AllocationService } from "../services/allocation-service";
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
      set.status = error instanceof AllocationError ? 409 : notFound ? 404 : 400;
      return {
        error: {
          code: error instanceof AllocationError ? "NO_CAPACITY" : notFound ? "NOT_FOUND" : "INVALID_REQUEST",
          message,
        },
      };
    })
    .post("/pools/:poolId/sandboxes/:sandboxId/allocate", ({ params }) =>
      allocations.allocate(params.poolId, params.sandboxId),
    )
    .get(
      "/sandboxes/:sandboxId/allocation",
      ({ params }) =>
        allocations.find(params.sandboxId) ??
        (() => {
          throw new Error("allocation not found");
        })(),
    )
    .delete("/sandboxes/:sandboxId/allocation", ({ params }) => allocations.release(params.sandboxId));
}
