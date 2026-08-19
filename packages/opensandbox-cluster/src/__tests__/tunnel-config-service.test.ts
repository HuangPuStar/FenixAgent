import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
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

describe("tunnel config service", () => {
  // tunnel 创建不需要 base_url，下载结果可以直接交给 frpc。
  test("downloads a ready-to-use frpc.toml", async () => {
    const databasePath = `/tmp/opensandbox-cluster-tunnel-${Date.now()}.db`;
    migrateDatabase(databasePath);
    const app = createApp({ ...config, databasePath });
    const headers = { Authorization: "Bearer cluster-key", "Content-Type": "application/json" };
    const request = (path: string, init?: RequestInit) =>
      app.handle(new Request(`http://localhost${path}`, { ...init, headers: { ...headers, ...init?.headers } }));
    await request("/api/v1/pools", { method: "POST", body: JSON.stringify({ id: "pool-tunnel", name: "Tunnel" }) });
    const created = await request("/api/v1/servers", {
      method: "POST",
      body: JSON.stringify({
        id: "server-tunnel",
        pool_id: "pool-tunnel",
        name: "Tunnel Server",
        transport_mode: "tunnel",
        workspace_root: "/data/sandboxes",
        api_key: "sandbox-key",
        max_sandboxes: 2,
      }),
    });
    expect(created.status).toBe(200);
    const response = await request("/api/v1/servers/server-tunnel/tunnel/frpc.toml");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/toml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const parsed = parse(await response.text()) as {
      serverAddr: string;
      loginFailExit: boolean;
      transport: {
        heartbeatInterval: number;
        heartbeatTimeout: number;
        dialServerKeepalive: number;
        tls: { enable: boolean };
      };
      metadatas: { server_id: string; node_token: string };
    };
    expect(parsed.serverAddr).toBe("cluster.example.com");
    expect(parsed.loginFailExit).toBe(false);
    expect(parsed.transport).toEqual({
      heartbeatInterval: 10,
      heartbeatTimeout: 30,
      dialServerKeepalive: 30,
      tls: { enable: true },
    });
    expect(parsed.metadatas.server_id).toBe("server-tunnel");
    expect(parsed.metadatas.node_token).toStartWith("osn1.");
  });

  // 已有 direct 节点只有在离线后才能一次性切换为 tunnel，重复调用必须保持幂等。
  test("switches an offline direct server to tunnel idempotently", async () => {
    const databasePath = `/tmp/opensandbox-cluster-tunnel-switch-${Date.now()}.db`;
    migrateDatabase(databasePath);
    const app = createApp({ ...config, databasePath });
    const headers = { Authorization: "Bearer cluster-key", "Content-Type": "application/json" };
    const request = (path: string, init?: RequestInit) =>
      app.handle(new Request(`http://localhost${path}`, { ...init, headers: { ...headers, ...init?.headers } }));

    await request("/api/v1/pools", { method: "POST", body: JSON.stringify({ id: "pool-switch", name: "Switch" }) });
    await request("/api/v1/servers", {
      method: "POST",
      body: JSON.stringify({
        id: "server-switch",
        pool_id: "pool-switch",
        name: "Switch Server",
        base_url: "http://127.0.0.1:1",
        workspace_root: "/data/sandboxes",
        api_key: "sandbox-key",
        max_sandboxes: 2,
      }),
    });

    const first = await request("/api/v1/servers/server-switch/tunnel", { method: "PUT" });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { routeHost: string; tokenPrefix: string };
    const server = await request("/api/v1/servers/server-switch");
    const serverBody = (await server.json()) as { transportMode: string; baseUrl: string; routeHost: string };
    expect(serverBody.transportMode).toBe("tunnel");
    expect(serverBody.baseUrl).toBe("http://127.0.0.1:1");
    expect(serverBody.routeHost).toBe(firstBody.routeHost);

    const second = await request("/api/v1/servers/server-switch/tunnel", { method: "PUT" });
    expect(second.status).toBe(200);
    expect((await second.json()) as { routeHost: string; tokenPrefix: string }).toEqual(firstBody);
  });

  // 运行中的 direct Server 不允许被 tunnel action 突然切换。
  test("rejects tunnel migration while direct server is reachable", async () => {
    const databasePath = `/tmp/opensandbox-cluster-tunnel-online-${Date.now()}.db`;
    migrateDatabase(databasePath);
    const app = createApp(
      { ...config, databasePath },
      { fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch },
    );
    const headers = { Authorization: "Bearer cluster-key", "Content-Type": "application/json" };
    const request = (path: string, init?: RequestInit) =>
      app.handle(new Request(`http://localhost${path}`, { ...init, headers: { ...headers, ...init?.headers } }));

    await request("/api/v1/pools", { method: "POST", body: JSON.stringify({ id: "pool-online", name: "Online" }) });
    await request("/api/v1/servers", {
      method: "POST",
      body: JSON.stringify({
        id: "server-online",
        pool_id: "pool-online",
        name: "Online Server",
        base_url: "http://server.internal:8080",
        workspace_root: "/data/sandboxes",
        api_key: "sandbox-key",
        max_sandboxes: 2,
      }),
    });

    const response = await request("/api/v1/servers/server-online/tunnel", { method: "PUT" });
    expect(response.status).toBe(409);
  });
});
