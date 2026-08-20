import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { migrateDatabase } from "../db/migrate";
import type { ClusterConfig } from "../types";

const config: ClusterConfig = {
  port: 8080,
  host: "127.0.0.1",
  databasePath: ":memory:",
  clusterServiceApiKey: "cluster-key",
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

describe("OpenSandbox proxy", () => {
  test("routes by sandbox binding and overrides target API key", async () => {
    let receivedKey = "";
    const mockServer = Bun.serve({
      port: 0,
      async fetch(request) {
        receivedKey = request.headers.get("OPEN-SANDBOX-API-KEY") ?? "";
        if (new URL(request.url).pathname === "/health") return Response.json({ status: "healthy" });
        return new Response(`echo:${await request.text()}`, { status: 207, headers: { "x-provider": "ok" } });
      },
    });
    const databasePath = `/tmp/opensandbox-cluster-proxy-${Date.now()}.db`;
    migrateDatabase(databasePath);
    const app = createApp({ ...config, databasePath }, { fetch: Bun.fetch });
    const headers = { Authorization: "Bearer cluster-key", "Content-Type": "application/json" };
    const request = (path: string, init?: RequestInit) =>
      app.handle(new Request(`http://localhost${path}`, { ...init, headers: { ...headers, ...init?.headers } }));

    await request("/api/v1/pools", { method: "POST", body: JSON.stringify({ id: "pool-proxy", name: "Pool" }) });
    await request("/api/v1/servers", {
      method: "POST",
      body: JSON.stringify({
        id: "server-proxy",
        pool_id: "pool-proxy",
        name: "Server",
        base_url: `http://127.0.0.1:${mockServer.port}`,
        workspace_root: "/data/opensandbox/sandboxes",
        api_key: "provider-secret",
        max_sandboxes: 1,
      }),
    });
    await request("/api/v1/servers/server-proxy/health-check", { method: "POST" });
    await request("/api/v1/pools/pool-proxy/sandboxes/sbi-proxy/allocate", { method: "POST" });

    const response = await request("/api/v1/sandboxes/sbi-proxy/proxy/echo?value=1", {
      method: "POST",
      headers: { Authorization: "Bearer cluster-key", "OPEN-SANDBOX-API-KEY": "caller-key" },
      body: "streamed-body",
    });
    expect(response.status).toBe(207);
    expect(response.headers.get("x-provider")).toBe("ok");
    expect(await response.text()).toBe("echo:streamed-body");
    expect(receivedKey).toBe("provider-secret");
    mockServer.stop();
  });

  test("rewrites host volume paths for sandbox creation", async () => {
    let receivedBody = "";
    const mockServer = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/health") return Response.json({ status: "healthy" });
        receivedBody = await request.text();
        return Response.json({ id: "provider-sandbox" }, { status: 201 });
      },
    });
    const databasePath = `/tmp/opensandbox-cluster-volume-${Date.now()}.db`;
    migrateDatabase(databasePath);
    const app = createApp({ ...config, databasePath }, { fetch: Bun.fetch });
    const headers = { Authorization: "Bearer cluster-key", "Content-Type": "application/json" };
    const request = (path: string, init?: RequestInit) =>
      app.handle(new Request(`http://localhost${path}`, { ...init, headers: { ...headers, ...init?.headers } }));

    await request("/api/v1/pools", { method: "POST", body: JSON.stringify({ id: "pool-volume", name: "Pool" }) });
    await request("/api/v1/servers", {
      method: "POST",
      body: JSON.stringify({
        id: "server-volume",
        pool_id: "pool-volume",
        name: "Server",
        base_url: `http://127.0.0.1:${mockServer.port}`,
        workspace_root: "/data/opensandbox/sandboxes",
        api_key: "provider-secret",
        max_sandboxes: 1,
      }),
    });
    await request("/api/v1/servers/server-volume/health-check", { method: "POST" });
    await request("/api/v1/pools/pool-volume/sandboxes/sbi-volume/allocate", { method: "POST" });

    const response = await request("/api/v1/sandboxes/sbi-volume/proxy/v1/sandboxes", {
      method: "POST",
      body: JSON.stringify({
        volumes: [{ name: "workspace", host: { path: "./ws" }, mountPath: "/workspace" }],
      }),
    });

    expect(response.status).toBe(201);
    expect(JSON.parse(receivedBody)).toEqual({
      volumes: [
        {
          name: "workspace",
          host: { path: "/data/opensandbox/sandboxes/ws" },
          mountPath: "/workspace",
        },
      ],
    });
    mockServer.stop();
  });
});
