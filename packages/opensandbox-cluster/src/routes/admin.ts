import { Elysia } from "elysia";
import {
  bodyOf,
  type PoolInput,
  requirePositiveInteger,
  requireString,
  type ServerInput,
} from "../schemas/admin-schemas";
import { isValidClusterApiKey } from "../security/api-auth";
import { ConflictError, type PoolService } from "../services/pool-service";
import type { ServerService } from "../services/server-service";
import type { TunnelConfigService } from "../services/tunnel-config-service";
import type { ClusterConfig } from "../types";

export function createAdminRoutes(
  config: ClusterConfig,
  pools: PoolService,
  servers: ServerService,
  tunnels?: TunnelConfigService,
  healthCheck?: (serverId: string) => Promise<"unknown" | "healthy" | "unhealthy">,
) {
  return new Elysia({ name: "cluster-admin", prefix: "/api/v1" })
    .onBeforeHandle(({ request, set }) => {
      if (!isValidClusterApiKey(request, config)) {
        set.status = 401;
        return { error: { code: "UNAUTHORIZED", message: "invalid cluster service credentials" } };
      }
    })
    .onError(({ error, set }) => {
      if (error instanceof ConflictError) set.status = 409;
      else if (error instanceof Error && error.message.includes("not found")) set.status = 404;
      else set.status = 400;
      return {
        error: {
          code: error instanceof ConflictError ? "CONFLICT" : "INVALID_REQUEST",
          message: error instanceof Error ? error.message : "request failed",
        },
      };
    })
    .post("/pools", ({ body }) => {
      const input = bodyOf<PoolInput>(body);
      return pools.create({
        id: requireString(input.id, "id"),
        name: requireString(input.name, "name"),
        status: input.status,
      });
    })
    .get("/pools", () => pools.list())
    .get(
      "/pools/:poolId",
      ({ params }) =>
        pools.findById(params.poolId) ??
        (() => {
          throw new Error("pool not found");
        })(),
    )
    .put("/pools/:poolId", ({ params, body }) => {
      const input = bodyOf<Pick<PoolInput, "name" | "status">>(body);
      return pools.update(params.poolId, {
        name: input.name ? requireString(input.name, "name") : undefined,
        status: input.status,
      });
    })
    .delete("/pools/:poolId", ({ params }) => pools.delete(params.poolId))
    .post("/servers", async ({ body }) => {
      const input = bodyOf<ServerInput>(body);
      const transportMode = input.transport_mode ?? "direct";
      if (transportMode === "tunnel") {
        if (!tunnels) throw new Error("tunnel service unavailable");
        return tunnels.createTunnelServer({
          id: requireString(input.id, "id"),
          pool_id: requireString(input.pool_id, "pool_id"),
          name: requireString(input.name, "name"),
          workspace_root: requireString(input.workspace_root, "workspace_root"),
          api_key: requireString(input.api_key, "api_key"),
          max_sandboxes: requirePositiveInteger(input.max_sandboxes, "max_sandboxes"),
          status: input.status,
        });
      }
      const server = servers.create({
        id: requireString(input.id, "id"),
        pool_id: requireString(input.pool_id, "pool_id"),
        name: requireString(input.name, "name"),
        base_url: requireString(input.base_url, "base_url"),
        workspace_root: requireString(input.workspace_root, "workspace_root"),
        api_key: requireString(input.api_key, "api_key"),
        max_sandboxes: requirePositiveInteger(input.max_sandboxes, "max_sandboxes"),
        status: input.status,
      });
      return (await servers.healthCheck(server.id)) ?? server;
    })
    .get("/servers", ({ query }) => servers.list(query.pool_id))
    .get(
      "/servers/:serverId",
      ({ params }) =>
        servers.findById(params.serverId) ??
        (() => {
          throw new Error("server not found");
        })(),
    )
    .put("/servers/:serverId", ({ params, body }) => servers.update(params.serverId, bodyOf(body)))
    .delete("/servers/:serverId", ({ params }) => servers.delete(params.serverId))
    .post("/servers/:serverId/health-check", async ({ params }) => {
      const server = servers.findById(params.serverId);
      if (!server) throw new Error("server not found");
      if (server.transportMode === "tunnel" && healthCheck) {
        await healthCheck(params.serverId);
        return servers.findById(params.serverId) ?? server;
      }
      return servers.healthCheck(params.serverId);
    });
}
