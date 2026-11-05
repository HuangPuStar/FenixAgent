import { afterEach } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { loadConfig } from "../config";
import { createDatabase } from "../db/client";
import { opensandboxServer } from "../db/schema";
import { createSecretBox } from "../security/secret-box";
import { PoolService } from "../services/pool-service";
import { type ManagedCreate, SandboxLifecycleService } from "../services/sandbox-lifecycle-service";
import { ServerService } from "../services/server-service";

const handles: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.sqlite.close();
});
/** Resource-mode fixture; SQLite handles are closed after each test. */
export function fixture(
  fetchImpl: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response> = async () =>
    Response.json({ id: "native-1" }),
) {
  const handle = createDatabase(":memory:");
  handles.push(handle);
  const { db, sqlite } = handle;
  migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  const config = {
    ...loadConfig({
      SERVER_API_KEY_ENCRYPTION_KEY: "0".repeat(32),
      CLUSTER_SERVICE_API_KEY: "test-key",
      FRP_TOKEN: "test",
      FRP_PUBLIC_ADDRESS: "localhost",
    }),
    databasePath: ":memory:",
  };
  const pools = new PoolService(db);
  pools.create({
    id: "p",
    name: "P",
    scheduling_mode: "resources",
    default_lease_seconds: 60,
    max_lease_seconds: 3600,
  });
  const servers = new ServerService(db, createSecretBox(config.serverApiKeyEncryptionKey));
  servers.create({
    id: "n",
    pool_id: "p",
    name: "N",
    base_url: "http://node",
    workspace_root: "/data/ws",
    api_key: "test",
    cpu_capacity: 0.3,
    memory_capacity_mb: 100,
    disk_capacity_gb: 10,
    gpu_capacity: 1,
  });
  db.update(opensandboxServer).set({ healthStatus: "healthy" }).run();
  const lifecycle = new SandboxLifecycleService(
    db,
    sqlite,
    config,
    servers,
    Object.assign(fetchImpl, { preconnect: fetch.preconnect }),
  );
  return { db, sqlite, config, pools, servers, lifecycle };
}
/** Minimal managed sandbox request with configurable CPU and GPU. */
export const input = (id: string, cpu = 0.1, gpuCount = 0): ManagedCreate => ({
  sandbox_id: id,
  resources: { cpu, memoryMb: 10, diskGb: 1, gpuCount },
  sandbox: { image: { uri: "alpine" } },
});
