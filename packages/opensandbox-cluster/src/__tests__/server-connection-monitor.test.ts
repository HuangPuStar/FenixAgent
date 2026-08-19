import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { createSecretBox } from "../security/secret-box";
import { ServerConnectionMonitor } from "../services/server-connection-monitor";
import type { ClusterConfig } from "../types";

const config = {
  frpConnectionStaleMs: 40000,
  frpHealthIntervalMs: 30000,
  frpInternalUrl: "http://frps:7080",
} as ClusterConfig;

function setup() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE opensandbox_server (
      id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, name TEXT NOT NULL,
      transport_mode TEXT NOT NULL, base_url TEXT NOT NULL, route_host TEXT,
      workspace_root TEXT NOT NULL, api_key_ciphertext TEXT NOT NULL,
      max_sandboxes INTEGER NOT NULL, status TEXT NOT NULL, health_status TEXT NOT NULL,
      last_health_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE opensandbox_tunnel_connection (
      server_id TEXT PRIMARY KEY, frp_run_id TEXT NOT NULL, status TEXT NOT NULL,
      connected_at INTEGER, disconnected_at INTEGER, last_seen_at INTEGER NOT NULL,
      health_status TEXT NOT NULL, last_health_at INTEGER, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

describe("server connection monitor", () => {
  // disconnected 连接仍可通过实际 vhost 探测自动恢复。
  test("probes a disconnected tunnel and restores it when healthy", async () => {
    const { db, sqlite } = setup();
    const now = Date.now();
    const secretBox = createSecretBox(new Uint8Array(32));
    sqlite.exec(
      `INSERT INTO opensandbox_server VALUES ('server-a', 'pool-a', 'A', 'tunnel', '', 'os-a.tunnel.internal', '/data', '${secretBox.encryptApiKey("api")}', 1, 'active', 'unknown', NULL, NULL, ${now}, ${now}); INSERT INTO opensandbox_tunnel_connection VALUES ('server-a', 'run-1', 'disconnected', ${now - 1000}, ${now - 500}, ${now - 1000}, 'healthy', ${now - 500}, 'connection lease expired', ${now}, ${now});`,
    );
    let calls = 0;
    const monitor = new ServerConnectionMonitor(db, config, secretBox, (async () => {
      calls += 1;
      return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
    }) as unknown as typeof fetch);

    await expect(monitor.checkServer("server-a", now)).resolves.toBe("healthy");
    expect(calls).toBe(1);
    expect(sqlite.query("SELECT status, disconnected_at, last_error FROM opensandbox_tunnel_connection").get()).toEqual(
      {
        status: "connected",
        disconnected_at: null,
        last_error: null,
      },
    );
  });
});
