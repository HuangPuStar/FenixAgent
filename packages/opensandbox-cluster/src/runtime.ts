import { createAppWithDatabase } from "./app";
import { createDatabase } from "./db/client";
import { createLoggedFrpPluginApp } from "./routes/frp-plugin";
import { createSecretBox } from "./security/secret-box";
import { AllocationService } from "./services/allocation-service";
import { CountRecoveryService } from "./services/count-recovery-service";
import { FrpPluginService } from "./services/frp-plugin-service";
import { ReconciliationWorker, SandboxLifecycleService } from "./services/sandbox-lifecycle-service";
import { ServerConnectionMonitor } from "./services/server-connection-monitor";
import { ServerService } from "./services/server-service";
import type { ClusterConfig } from "./types";

export interface ClusterRuntime {
  apiApp: ReturnType<typeof createAppWithDatabase>;
  pluginApp: ReturnType<typeof createLoggedFrpPluginApp>;
  monitor: ServerConnectionMonitor;
  worker: ReconciliationWorker;
  close(): Promise<void>;
}

export function createClusterRuntime(config: ClusterConfig): ClusterRuntime {
  const { db, sqlite } = createDatabase(config.databasePath);
  const monitor = new ServerConnectionMonitor(db, config, createSecretBox(config.serverApiKeyEncryptionKey));
  const lifecycle = new SandboxLifecycleService(
    db,
    sqlite,
    config,
    new ServerService(db, createSecretBox(config.serverApiKeyEncryptionKey)),
  );
  const servers = new ServerService(db, createSecretBox(config.serverApiKeyEncryptionKey));
  const countRecovery = new CountRecoveryService(
    db,
    config,
    servers,
    new AllocationService(db, sqlite, config, lifecycle),
  );
  const worker = new ReconciliationWorker(lifecycle, countRecovery);
  const apiApp = createAppWithDatabase(
    config,
    db,
    sqlite,
    {
      lifecycle,
      countRecovery,
      recoverTunnel: async (serverId) => (await monitor.checkServer(serverId)) === "healthy",
      healthCheck: (serverId) => monitor.checkServer(serverId),
    },
    false,
  );
  const pluginApp = createLoggedFrpPluginApp(config, new FrpPluginService(db));
  return {
    apiApp,
    pluginApp,
    monitor,
    worker,
    close: async () => {
      await worker.stop();
      sqlite.close();
    },
  };
}
