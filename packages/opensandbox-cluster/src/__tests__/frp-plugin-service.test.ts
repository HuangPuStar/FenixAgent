import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { createNodeRegistrationToken } from "../security/node-registration-token";
import { FrpPluginService } from "../services/frp-plugin-service";

function setup() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(
    `CREATE TABLE sandbox_pool (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE opensandbox_server (id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES sandbox_pool(id), name TEXT NOT NULL, transport_mode TEXT NOT NULL DEFAULT 'direct', base_url TEXT NOT NULL, route_host TEXT UNIQUE, workspace_root TEXT NOT NULL, api_key_ciphertext TEXT NOT NULL, max_sandboxes INTEGER NOT NULL, status TEXT NOT NULL, health_status TEXT NOT NULL, last_health_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE opensandbox_server_credential (server_id TEXT PRIMARY KEY REFERENCES opensandbox_server(id) ON DELETE CASCADE, token_hash TEXT NOT NULL, token_ciphertext TEXT NOT NULL, token_prefix TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, rotated_at INTEGER, revoked_at INTEGER, last_used_at INTEGER); CREATE TABLE opensandbox_tunnel_connection (server_id TEXT PRIMARY KEY REFERENCES opensandbox_server(id) ON DELETE CASCADE, frp_run_id TEXT NOT NULL, status TEXT NOT NULL, connected_at INTEGER, disconnected_at INTEGER, last_seen_at INTEGER NOT NULL, health_status TEXT NOT NULL, last_health_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
  const db = drizzle(sqlite, { schema });
  const now = Date.now();
  sqlite.exec(
    `INSERT INTO sandbox_pool VALUES ('pool-a', 'Pool', 'active', ${now}, ${now}); INSERT INTO opensandbox_server VALUES ('server-a', 'pool-a', 'Server', 'tunnel', '', 'os-a.tunnel.internal', '/data', 'key', 1, 'active', 'unknown', NULL, NULL, ${now}, ${now});`,
  );
  const token = createNodeRegistrationToken("server-a");
  sqlite.exec(
    `INSERT INTO opensandbox_server_credential VALUES ('server-a', '${token.hash}', 'cipher', '${token.prefix}', 'active', ${now}, NULL, NULL, NULL);`,
  );
  return { db, token };
}

describe("FRP plugin service", () => {
  // Login 建立连接，Ping 更新时间，旧 run 的 CloseProxy 不得影响新连接。
  test("authenticates and fences callbacks", () => {
    const { db, token } = setup();
    const service = new FrpPluginService(db);
    const metadata = { user: { metas: { server_id: "server-a", node_token: token.value } }, run_id: "run-new" };
    expect(service.handle({ op: "Login", content: metadata })).toEqual({ reject: false, unchange: true });
    expect(
      service.handle({
        op: "NewProxy",
        content: {
          user: { metas: { server_id: "server-a", node_token: token.value }, run_id: "run-new" },
          proxy_name: "os-server-a",
          proxy_type: "http",
          custom_domains: ["os-a.tunnel.internal"],
        },
      }),
    ).toEqual({ reject: false, unchange: true });
    expect(service.handle({ op: "Ping", content: metadata })).toEqual({ reject: false, unchange: true });
    expect(service.handle({ op: "CloseProxy", content: { ...metadata, run_id: "run-old" } })).toEqual({
      reject: false,
      unchange: true,
    });
  });

  // 错误 token 和非法代理参数必须被拒绝。
  test("rejects invalid credentials and proxies", () => {
    const { db, token } = setup();
    const service = new FrpPluginService(db);
    expect(
      service.handle({
        op: "Login",
        content: { user: { metas: { server_id: "server-a", node_token: `${token.value}x` } }, run_id: "run" },
      }).reject,
    ).toBe(true);
    expect(
      service.handle({
        op: "NewProxy",
        content: {
          user: { metas: { server_id: "server-a", node_token: token.value } },
          run_id: "run",
          proxy: { type: "tcp", name: "bad", custom_domains: [] },
        },
      }).reject,
    ).toBe(true);
  });
});
