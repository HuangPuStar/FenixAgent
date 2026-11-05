import { Elysia } from "elysia";
import { createConsoleRoutes } from "./console";
import { createDatabase } from "./db/client";
import { createRequestLogging, type HttpLogSink } from "./logging/http-logger";
import { createOpenApi } from "./openapi";
import { createAdminRoutes } from "./routes/admin";
import { createAllocationRoutes } from "./routes/allocation";
import { createFrpPluginRoutes } from "./routes/frp-plugin";
import { createManagedRoutes } from "./routes/managed-sandboxes";
import { handleProxyRequest } from "./routes/proxy";
import { createSandboxManagementRoutes } from "./routes/sandbox-management";
import { createTunnelRoutes } from "./routes/tunnel";
import { createSecretBox } from "./security/secret-box";
import { AllocationService } from "./services/allocation-service";
import { CountRecoveryService } from "./services/count-recovery-service";
import { FrpPluginService } from "./services/frp-plugin-service";
import { PoolService } from "./services/pool-service";
import { ProxyService } from "./services/proxy-service";
import { SandboxLifecycleService } from "./services/sandbox-lifecycle-service";
import { SandboxManagementService } from "./services/sandbox-management-service";
import { ServerService } from "./services/server-service";
import { TunnelConfigService } from "./services/tunnel-config-service";
import type { ClusterConfig, HealthResponse } from "./types";

export interface AppDependencies {
  fetch?: typeof fetch;
  recoverTunnel?: (serverId: string) => Promise<boolean>;
  lifecycle?: SandboxLifecycleService;
  countRecovery?: CountRecoveryService;
  healthCheck?: (serverId: string) => Promise<"unknown" | "healthy" | "unhealthy">;
  httpLog?: HttpLogSink;
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
  const logging = createRequestLogging(
    [_config.clusterServiceApiKey, _config.frpToken, new TextDecoder().decode(_config.serverApiKeyEncryptionKey)],
    dependencies.httpLog,
  );
  const fetchImpl = dependencies.fetch ?? fetch;
  const pools = new PoolService(db);
  const servers = new ServerService(db, createSecretBox(_config.serverApiKeyEncryptionKey), fetchImpl);
  const tunnels = new TunnelConfigService(db, _config, createSecretBox(_config.serverApiKeyEncryptionKey), servers);
  const lifecycle = dependencies.lifecycle ?? new SandboxLifecycleService(db, sqlite, _config, servers, fetchImpl);
  const allocations = new AllocationService(db, sqlite, _config, lifecycle);
  const countRecovery =
    dependencies.countRecovery ?? new CountRecoveryService(db, _config, servers, allocations, fetchImpl);
  const proxy = new ProxyService(
    servers,
    allocations,
    _config.proxyConnectTimeoutMs,
    _config.proxyResponseTimeoutMs,
    fetchImpl,
    db,
    _config,
    dependencies.recoverTunnel,
    countRecovery,
  );
  return new Elysia({ name: "opensandbox-cluster" })
    .onRequest(logging.start)
    .mapResponse(logging.captureResponse)
    .onAfterResponse(logging.finish)
    .use(createOpenApi())
    .get("/health", (): HealthResponse => ({ status: "healthy" }))
    .use(createConsoleRoutes())
    .use(createAdminRoutes(_config, pools, servers, tunnels, dependencies.healthCheck))
    .use(createTunnelRoutes(_config, tunnels))
    .use(includePlugin ? createFrpPluginRoutes(_config, new FrpPluginService(db)) : new Elysia())
    .use(createManagedRoutes(_config, allocations, lifecycle))
    .use(createSandboxManagementRoutes(_config, new SandboxManagementService(db, allocations)))
    .use(createAllocationRoutes(_config, allocations))
    .all(
      "*",
      ({ request, set }) =>
        handleProxyRequest(_config, proxy, request, set) ?? new Response("Not Found", { status: 404 }),
    );
}
