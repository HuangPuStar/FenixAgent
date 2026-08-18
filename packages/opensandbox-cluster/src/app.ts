import { Elysia } from "elysia";
import { createDatabase } from "./db/client";
import { createAdminRoutes } from "./routes/admin";
import { createAllocationRoutes } from "./routes/allocation";
import { createFrpPluginRoutes } from "./routes/frp-plugin";
import { handleProxyRequest } from "./routes/proxy";
import { createTunnelRoutes } from "./routes/tunnel";
import { createSecretBox } from "./security/secret-box";
import { AllocationService } from "./services/allocation-service";
import { FrpPluginService } from "./services/frp-plugin-service";
import { PoolService } from "./services/pool-service";
import { ProxyService } from "./services/proxy-service";
import { ServerService } from "./services/server-service";
import { TunnelConfigService } from "./services/tunnel-config-service";
import type { ClusterConfig, HealthResponse } from "./types";

export interface AppDependencies {
  fetch?: typeof fetch;
}

export function createApp(_config: ClusterConfig, dependencies: AppDependencies = {}) {
  const { db, sqlite } = createDatabase(_config.databasePath);
  return createAppWithDatabase(_config, db, sqlite, dependencies);
}

export function createAppWithDatabase(
  _config: ClusterConfig,
  db: ReturnType<typeof createDatabase>["db"],
  sqlite: ReturnType<typeof createDatabase>["sqlite"],
  dependencies: AppDependencies = {},
  includePlugin = true,
) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const pools = new PoolService(db);
  const servers = new ServerService(db, createSecretBox(_config.serverApiKeyEncryptionKey), fetchImpl);
  const tunnels = new TunnelConfigService(db, _config, createSecretBox(_config.serverApiKeyEncryptionKey), servers);
  const allocations = new AllocationService(db, sqlite, _config);
  const proxy = new ProxyService(
    servers,
    allocations,
    _config.proxyConnectTimeoutMs,
    _config.proxyResponseTimeoutMs,
    fetchImpl,
    db,
    _config,
  );
  return new Elysia({ name: "opensandbox-cluster" })
    .get("/health", (): HealthResponse => ({ status: "healthy" }))
    .use(createAdminRoutes(_config, pools, servers, tunnels))
    .use(createTunnelRoutes(_config, tunnels))
    .use(includePlugin ? createFrpPluginRoutes(_config, new FrpPluginService(db)) : new Elysia())
    .use(createAllocationRoutes(_config, allocations))
    .all(
      "*",
      ({ request, set }) =>
        handleProxyRequest(_config, proxy, request, set) ?? new Response("Not Found", { status: 404 }),
    );
}
