import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { ServerTargetError, ServerTargetResolver } from "../services/server-target-resolver";
import type { ClusterConfig } from "../types";

const config = { frpConnectionStaleMs: 40000, frpInternalUrl: "http://frps:7080" } as ClusterConfig;

describe("server target resolver", () => {
  // tunnel 目标统一指向 frps vhost，并携带不可预测 Host。
  test("resolves a healthy tunnel target", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      "CREATE TABLE sandbox_pool (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE opensandbox_server (id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, name TEXT NOT NULL, transport_mode TEXT NOT NULL, base_url TEXT NOT NULL, route_host TEXT, workspace_root TEXT NOT NULL, api_key_ciphertext TEXT NOT NULL, max_sandboxes INTEGER NOT NULL, status TEXT NOT NULL, health_status TEXT NOT NULL, last_health_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE opensandbox_tunnel_connection (server_id TEXT PRIMARY KEY, frp_run_id TEXT NOT NULL, status TEXT NOT NULL, connected_at INTEGER, disconnected_at INTEGER, last_seen_at INTEGER NOT NULL, health_status TEXT NOT NULL, last_health_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    );
    const db = drizzle(sqlite, { schema });
    const now = Date.now();
    sqlite.exec(
      `INSERT INTO opensandbox_server VALUES ('server-a', 'pool-a', 'A', 'tunnel', '', 'os-a.tunnel.internal', '/data', 'cipher', 1, 'active', 'unknown', NULL, NULL, ${now}, ${now}); INSERT INTO opensandbox_tunnel_connection VALUES ('server-a', 'run-1', 'connected', ${now}, NULL, ${now}, 'healthy', ${now}, NULL, ${now}, ${now});`,
    );
    expect(new ServerTargetResolver(db, config).resolve("server-a", now)).toEqual({
      baseUrl: "http://frps:7080",
      hostHeader: "os-a.tunnel.internal",
      transportMode: "tunnel",
    });
  });

  // 连接过期时拒绝代理，避免请求进入已失效的 frp vhost。
  test("rejects stale tunnel target", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      "CREATE TABLE opensandbox_server (id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, name TEXT NOT NULL, transport_mode TEXT NOT NULL, base_url TEXT NOT NULL, route_host TEXT, workspace_root TEXT NOT NULL, api_key_ciphertext TEXT NOT NULL, max_sandboxes INTEGER NOT NULL, status TEXT NOT NULL, health_status TEXT NOT NULL, last_health_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE opensandbox_tunnel_connection (server_id TEXT PRIMARY KEY, frp_run_id TEXT NOT NULL, status TEXT NOT NULL, connected_at INTEGER, disconnected_at INTEGER, last_seen_at INTEGER NOT NULL, health_status TEXT NOT NULL, last_health_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    );
    const db = drizzle(sqlite, { schema });
    const now = Date.now();
    sqlite.exec(
      `INSERT INTO opensandbox_server VALUES ('server-a', 'pool-a', 'A', 'tunnel', '', 'os-a.tunnel.internal', '/data', 'cipher', 1, 'active', 'unknown', NULL, NULL, ${now}, ${now}); INSERT INTO opensandbox_tunnel_connection VALUES ('server-a', 'run-1', 'connected', ${now - 50000}, NULL, ${now - 50000}, 'healthy', ${now - 50000}, NULL, ${now}, ${now});`,
    );
    expect(() => new ServerTargetResolver(db, config).resolve("server-a", now)).toThrow(ServerTargetError);
  });
});
