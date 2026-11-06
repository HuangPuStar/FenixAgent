import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createAppWithDatabase } from "../app";
import { loadConfig } from "../config";
import { createDatabase } from "../db/client";
import { migrateConnection } from "../db/migrate";
import { opensandboxServer } from "../db/schema";
import { createSecretBox } from "../security/secret-box";
import { PoolService } from "../services/pool-service";
import { SandboxLifecycleService } from "../services/sandbox-lifecycle-service";
import { ServerService } from "../services/server-service";
import { createShutdown } from "../shutdown";

// 两个端口上的在途请求均可完成数据库写入，重复信号共用同一次资源关闭。
test("shutdown drains delayed HTTP DELETE and plugin requests before closing SQLite", async () => {
  const { db, sqlite } = createDatabase(":memory:");
  migrateConnection(db, sqlite);
  const config = loadConfig({
    SERVER_API_KEY_ENCRYPTION_KEY: "0".repeat(32),
    CLUSTER_SERVICE_API_KEY: "test-key",
    FRP_TOKEN: "test-frp",
    FRP_PUBLIC_ADDRESS: "localhost",
  });
  const deleting = Promise.withResolvers<void>();
  const releaseDelete = Promise.withResolvers<void>();
  const callback = Promise.withResolvers<void>();
  const releaseCallback = Promise.withResolvers<void>();
  let gone = false;
  const remote = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ id: "native" });
      if (init?.method === "DELETE") {
        deleting.resolve();
        await releaseDelete.promise;
        gone = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: gone ? 404 : 200 });
    },
    { preconnect: fetch.preconnect },
  );
  new PoolService(db).create({
    id: "pool",
    name: "Pool",
    scheduling_mode: "resources",
    default_lease_seconds: 60,
    max_lease_seconds: 60,
  });
  const servers = new ServerService(db, createSecretBox(config.serverApiKeyEncryptionKey));
  servers.create({
    id: "node",
    pool_id: "pool",
    name: "Node",
    base_url: "http://node",
    workspace_root: "/workspace",
    api_key: "node-key",
    cpu_capacity: 1,
    memory_capacity_mb: 100,
    disk_capacity_gb: 10,
    gpu_capacity: 0,
  });
  db.update(opensandboxServer).set({ healthStatus: "healthy" }).run();
  const lifecycle = new SandboxLifecycleService(db, sqlite, config, servers, remote);
  await lifecycle.create("pool", {
    sandbox_id: "sandbox",
    resources: { cpu: 1, memoryMb: 10, diskGb: 1, gpuCount: 0 },
    sandbox: { image: { uri: "alpine" } },
  });
  const api = createAppWithDatabase(config, db, sqlite, { fetch: remote, lifecycle }, false).listen({
    hostname: "127.0.0.1",
    port: 0,
  });
  const plugin = new Elysia()
    .post("/callback", async () => {
      callback.resolve();
      await releaseCallback.promise;
      sqlite.query("UPDATE opensandbox_server SET name = 'Callback finished' WHERE id = 'node'").run();
      return { ok: true };
    })
    .listen({ hostname: "127.0.0.1", port: 0 });
  let closes = 0;
  const shutdown = createShutdown(
    {
      monitor: { stop() {} },
      async close() {
        closes++;
        sqlite.close();
      },
    },
    api,
    plugin,
  );
  const deletion = fetch(`http://127.0.0.1:${api.server!.port}/api/v2/sandboxes/sandbox`, {
    method: "DELETE",
    headers: { Authorization: "Bearer test-key" },
  });
  const notification = fetch(`http://127.0.0.1:${plugin.server!.port}/callback`, { method: "POST" });
  try {
    await Promise.all([deleting.promise, callback.promise]);
    const stopping = shutdown();
    const repeated = shutdown();
    releaseDelete.resolve();
    expect((await deletion).status).toBe(204);
    expect(lifecycle.find("sandbox")).toBeUndefined();
    releaseCallback.resolve();
    expect(await (await notification).json()).toEqual({ ok: true });
    await stopping;
    expect(repeated).toBe(stopping);
    expect(closes).toBe(1);
    expect(() => sqlite.query("SELECT 1").get()).toThrow();
  } finally {
    releaseDelete.resolve();
    releaseCallback.resolve();
    await Promise.allSettled([
      deletion,
      notification,
      api.server ? api.stop() : undefined,
      plugin.server ? plugin.stop() : undefined,
    ]);
    sqlite.close();
  }
});
