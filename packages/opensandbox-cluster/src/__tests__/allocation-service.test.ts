import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { migrateDatabase } from "../db/migrate";
import type { ClusterConfig } from "../types";

const config: ClusterConfig = {
  port: 8080,
  host: "127.0.0.1",
  databasePath: ":memory:",
  clusterServiceApiKey: "test-key",
  serverApiKeyEncryptionKey: new Uint8Array(32),
  proxyConnectTimeoutMs: 3000,
  proxyResponseTimeoutMs: 120000,
  frpPluginPort: 8081,
  frpPublicAddress: "cluster.example.com",
  frpBindPort: 7000,
  frpInternalUrl: "http://frps:7080",
  frpToken: "shared-token",
  frpConnectionStaleMs: 40000,
  frpHealthIntervalMs: 30000,
};

describe("sandbox allocation", () => {
  test("allocates idempotently and respects server capacity", async () => {
    const databasePath = `/tmp/opensandbox-cluster-allocation-${crypto.randomUUID()}.db`;
    migrateDatabase(databasePath);
    const app = createApp({ ...config, databasePath }, { fetch: Bun.fetch });
    const mockServer = Bun.serve({ port: 0, fetch: () => Response.json({ status: "healthy" }) });
    const headers = { Authorization: "Bearer test-key", "Content-Type": "application/json" };
    const request = (path: string, init?: RequestInit) =>
      app.handle(new Request(`http://localhost${path}`, { ...init, headers: { ...headers, ...init?.headers } }));

    await request("/api/v1/pools", { method: "POST", body: JSON.stringify({ id: "pool-alloc", name: "Pool" }) });
    await request("/api/v1/servers", {
      method: "POST",
      body: JSON.stringify({
        id: "server-alloc",
        pool_id: "pool-alloc",
        name: "Server",
        base_url: `http://127.0.0.1:${mockServer.port}`,
        workspace_root: "/data/opensandbox/sandboxes",
        api_key: "secret",
        max_sandboxes: 2,
        status: "active",
      }),
    });
    await request("/api/v1/servers/server-alloc/health-check", { method: "POST" });

    const first = await request("/api/v1/pools/pool-alloc/sandboxes/sbi-1/allocate", { method: "POST" });
    const second = await request("/api/v1/pools/pool-alloc/sandboxes/sbi-1/allocate", { method: "POST" });
    const third = await request("/api/v1/pools/pool-alloc/sandboxes/sbi-2/allocate", { method: "POST" });
    const fourth = await request("/api/v1/pools/pool-alloc/sandboxes/sbi-3/allocate", { method: "POST" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(third.status).toBe(200);
    expect(fourth.status).toBe(409);

    const release = await request("/api/v1/sandboxes/sbi-1/allocation", { method: "DELETE" });
    expect(release.status).toBe(200);
    const retry = await request("/api/v1/pools/pool-alloc/sandboxes/sbi-3/allocate", { method: "POST" });
    expect(retry.status).toBe(200);
    mockServer.stop();
  });
});
