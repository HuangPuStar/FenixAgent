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

describe("OpenSandbox Cluster routes", () => {
  test("returns healthy status", async () => {
    const response = await createApp(config).handle(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "healthy" });
  });

  test("protects management routes and never returns server API keys", async () => {
    const databasePath = `/tmp/opensandbox-cluster-routes-${Date.now()}.db`;
    migrateDatabase(databasePath);
    const app = createApp({ ...config, databasePath });

    const unauthorized = await app.handle(new Request("http://localhost/api/v1/pools"));
    expect(unauthorized.status).toBe(401);

    const headers = { Authorization: "Bearer test-key", "Content-Type": "application/json" };
    const pool = await app.handle(
      new Request("http://localhost/api/v1/pools", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "pool-route", name: "Route pool" }),
      }),
    );
    expect(pool.status).toBe(200);

    const server = await app.handle(
      new Request("http://localhost/api/v1/servers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "server-route",
          pool_id: "pool-route",
          name: "Route server",
          base_url: "http://localhost:65535",
          workspace_root: "/data/opensandbox/sandboxes",
          api_key: "secret-api-key",
          max_sandboxes: 2,
        }),
      }),
    );
    expect(server.status).toBe(200);
    const serverBody = (await server.json()) as { healthStatus: string };
    expect(serverBody.healthStatus).toBe("unhealthy");
    expect(JSON.stringify(serverBody)).not.toContain("secret-api-key");
  });
});
