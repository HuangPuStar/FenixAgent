import { Elysia } from "elysia";
import { createDatabase } from "./db/client";
import { createAdminRoutes } from "./routes/admin";
import { createAllocationRoutes } from "./routes/allocation";
import { handleProxyRequest } from "./routes/proxy";
import { createSecretBox } from "./security/secret-box";
import { AllocationService } from "./services/allocation-service";
import { PoolService } from "./services/pool-service";
import { ProxyService } from "./services/proxy-service";
import { ServerService } from "./services/server-service";
import type { ClusterConfig, HealthResponse } from "./types";

export interface AppDependencies {
  fetch?: typeof fetch;
}

export function createApp(_config: ClusterConfig, dependencies: AppDependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const { db, sqlite } = createDatabase(_config.databasePath);
  const pools = new PoolService(db);
  const servers = new ServerService(db, createSecretBox(_config.serverApiKeyEncryptionKey), fetchImpl);
  const allocations = new AllocationService(db, sqlite);
  const proxy = new ProxyService(
    servers,
    allocations,
    _config.proxyConnectTimeoutMs,
    _config.proxyResponseTimeoutMs,
    fetchImpl,
  );
  return new Elysia({ name: "opensandbox-cluster" })
    .get("/health", (): HealthResponse => ({ status: "healthy" }))
    .use(createAdminRoutes(_config, pools, servers))
    .use(createAllocationRoutes(_config, allocations))
    .all(
      "*",
      ({ request, set }) =>
        handleProxyRequest(_config, proxy, request, set) ?? new Response("Not Found", { status: 404 }),
    );
}
