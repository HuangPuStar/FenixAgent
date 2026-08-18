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

function createMockServer(apiKey: string) {
  const paths: string[] = [];
  const receivedKeys: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      paths.push(`${request.method} ${url.pathname}`);
      receivedKeys.push(request.headers.get("OPEN-SANDBOX-API-KEY") ?? "");
      if (url.pathname === "/health") return Response.json({ status: "healthy" });
      if (request.method === "POST" && url.pathname === "/v1/sandboxes")
        return Response.json({ id: "remote-sandbox-a", status: "running" });
      if (url.pathname === "/v1/sandboxes/remote-sandbox-a/resume")
        return Response.json({ id: "remote-sandbox-a", status: "running" });
      if (url.pathname === "/v1/sandboxes/remote-sandbox-a") {
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({ id: "remote-sandbox-a", status: "running" });
      }
      if (receivedKeys[receivedKeys.length - 1] !== apiKey) return Response.json({ error: "bad key" }, { status: 401 });
      return new Response("not found", { status: 404 });
    },
  });
  return { server, paths, receivedKeys };
}

describe("OpenSandbox Cluster end-to-end flow", () => {
  test("allocates, proxies lifecycle calls and releases explicitly", async () => {
    const nodeA = createMockServer("node-a-key");
    const nodeB = createMockServer("node-b-key");
    const databasePath = `/tmp/opensandbox-cluster-e2e-${Date.now()}.db`;
    migrateDatabase(databasePath);
    const app = createApp({ ...config, databasePath }, { fetch: Bun.fetch });
    const auth = { Authorization: "Bearer cluster-key" };
    const json = { ...auth, "Content-Type": "application/json" };
    const request = (path: string, init?: RequestInit) =>
      app.handle(new Request(`http://localhost${path}`, { ...init, headers: { ...json, ...init?.headers } }));

    await request("/api/v1/pools", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ id: "pool-e2e", name: "E2E" }),
    });
    await request("/api/v1/servers", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        id: "server-a",
        pool_id: "pool-e2e",
        name: "A",
        base_url: `http://127.0.0.1:${nodeA.server.port}`,
        workspace_root: "/data/node-a/sandboxes",
        api_key: "node-a-key",
        max_sandboxes: 1,
      }),
    });
    await request("/api/v1/servers", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        id: "server-b",
        pool_id: "pool-e2e",
        name: "B",
        base_url: `http://127.0.0.1:${nodeB.server.port}`,
        workspace_root: "/data/node-b/sandboxes",
        api_key: "node-b-key",
        max_sandboxes: 1,
      }),
    });
    expect(nodeA.paths.filter((path) => path === "GET /health").length).toBe(1);
    expect(nodeB.paths.filter((path) => path === "GET /health").length).toBe(1);

    const allocation = await request("/api/v1/pools/pool-e2e/sandboxes/sandbox-a/allocate", {
      method: "POST",
      headers: auth,
    });
    expect(allocation.status).toBe(200);
    expect(((await allocation.json()) as { server_id: string }).server_id).toBe("server-a");

    const create = await request("/api/v1/sandboxes/sandbox-a/proxy/v1/sandboxes", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ image: "ubuntu" }),
    });
    expect(create.status).toBe(200);
    expect(nodeA.paths).toContain("POST /v1/sandboxes");
    expect(nodeB.paths).not.toContain("POST /v1/sandboxes");

    expect(
      (await request("/api/v1/sandboxes/sandbox-a/proxy/v1/sandboxes/remote-sandbox-a", { headers: auth })).status,
    ).toBe(200);
    expect(
      (
        await request("/api/v1/sandboxes/sandbox-a/proxy/v1/sandboxes/remote-sandbox-a/resume", {
          method: "POST",
          headers: auth,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/v1/sandboxes/sandbox-a/proxy/v1/sandboxes/remote-sandbox-a", {
          method: "DELETE",
          headers: auth,
        })
      ).status,
    ).toBe(204);
    expect((await request("/api/v1/sandboxes/sandbox-a/allocation", { headers: auth })).status).toBe(200);
    expect((await request("/api/v1/sandboxes/sandbox-a/allocation", { method: "DELETE", headers: auth })).status).toBe(
      200,
    );
    expect((await request("/api/v1/sandboxes/sandbox-a/allocation", { headers: auth })).status).toBe(404);
    expect(nodeA.receivedKeys.filter((key) => key === "node-a-key").length).toBeGreaterThan(0);
    nodeA.server.stop();
    nodeB.server.stop();
  });
});
