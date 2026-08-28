import { createAppWithDatabase } from "./app";
import { createDatabase } from "./db/client";
import { createFrpPluginRoutes } from "./routes/frp-plugin";
import { createSecretBox } from "./security/secret-box";
import { FrpPluginService } from "./services/frp-plugin-service";
import { ServerConnectionMonitor } from "./services/server-connection-monitor";
import type { ClusterConfig } from "./types";

export interface ClusterRuntime {
  apiApp: ReturnType<typeof createAppWithDatabase>;
  pluginApp: ReturnType<typeof createFrpPluginRoutes>;
  monitor: ServerConnectionMonitor;
  close(): void;
}

export function createClusterRuntime(config: ClusterConfig): ClusterRuntime {
  const { db, sqlite } = createDatabase(config.databasePath);
  const monitor = new ServerConnectionMonitor(db, config, createSecretBox(config.serverApiKeyEncryptionKey));
  const apiApp = createAppWithDatabase(
    config,
    db,
    sqlite,
    {
      recoverTunnel: async (serverId) => (await monitor.checkServer(serverId)) === "healthy",
      healthCheck: (serverId) => monitor.checkServer(serverId),
    },
    false,
  );
  const pluginApp = createFrpPluginRoutes(config, new FrpPluginService(db));
  return { apiApp, pluginApp, monitor, close: () => sqlite.close() };
}
