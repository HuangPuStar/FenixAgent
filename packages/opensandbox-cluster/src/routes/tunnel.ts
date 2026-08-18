import { Elysia } from "elysia";
import { isValidClusterApiKey } from "../security/api-auth";
import { ConflictError } from "../services/pool-service";
import type { TunnelConfigService } from "../services/tunnel-config-service";
import type { ClusterConfig } from "../types";

export function createTunnelRoutes(config: ClusterConfig, tunnels: TunnelConfigService) {
  return new Elysia({ name: "cluster-tunnel", prefix: "/api/v1" })
    .onBeforeHandle(({ request, set }) => {
      if (!isValidClusterApiKey(request, config)) {
        set.status = 401;
        return { error: { code: "UNAUTHORIZED", message: "invalid cluster service credentials" } };
      }
    })
    .onError(({ error, set }) => {
      if (error instanceof ConflictError) set.status = 409;
      else set.status = error instanceof Error && error.message.includes("not found") ? 404 : 400;
      return { error: { code: "INVALID_REQUEST", message: error instanceof Error ? error.message : "request failed" } };
    })
    .put("/servers/:serverId/tunnel", ({ params }) => tunnels.prepare(params.serverId))
    .get("/servers/:serverId/tunnel/frpc.toml", async ({ params, set }) => {
      const result = await tunnels.downloadFrpcToml(params.serverId);
      set.status = 200;
      set.headers["content-type"] = "application/toml; charset=utf-8";
      set.headers["content-disposition"] = `attachment; filename="${result.filename}"`;
      set.headers["cache-control"] = "no-store";
      set.headers["x-content-type-options"] = "nosniff";
      return result.content;
    })
    .post("/servers/:serverId/tunnel/token", ({ params }) => tunnels.rotateToken(params.serverId))
    .delete("/servers/:serverId/tunnel/token", ({ params }) => tunnels.revokeToken(params.serverId));
}
