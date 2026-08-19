import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { BindingRepository } from "../repositories/binding-repository";
import { PoolRepository } from "../repositories/pool-repository";
import { ServerRepository } from "../repositories/server-repository";
import { TunnelConnectionRepository } from "../repositories/tunnel-connection-repository";

let sqlite: Database;
let poolRepository: PoolRepository;
let serverRepository: ServerRepository;
let bindingRepository: BindingRepository;
let tunnelConnectionRepository: TunnelConnectionRepository;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE sandbox_pool (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE opensandbox_server (id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES sandbox_pool(id), name TEXT NOT NULL, transport_mode TEXT NOT NULL DEFAULT 'direct', base_url TEXT NOT NULL, route_host TEXT UNIQUE, workspace_root TEXT NOT NULL, api_key_ciphertext TEXT NOT NULL, max_sandboxes INTEGER NOT NULL, status TEXT NOT NULL, health_status TEXT NOT NULL, last_health_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE opensandbox_server_credential (server_id TEXT PRIMARY KEY REFERENCES opensandbox_server(id) ON DELETE CASCADE, token_hash TEXT NOT NULL, token_ciphertext TEXT NOT NULL, token_prefix TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, rotated_at INTEGER, revoked_at INTEGER, last_used_at INTEGER, CHECK (status IN ('active', 'revoked')));
    CREATE TABLE opensandbox_tunnel_connection (server_id TEXT PRIMARY KEY REFERENCES opensandbox_server(id) ON DELETE CASCADE, frp_run_id TEXT NOT NULL, status TEXT NOT NULL, connected_at INTEGER, disconnected_at INTEGER, last_seen_at INTEGER NOT NULL, health_status TEXT NOT NULL, last_health_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK (status IN ('connecting', 'connected', 'disconnected')), CHECK (health_status IN ('unknown', 'healthy', 'unhealthy')));
    CREATE TABLE sandbox_binding (sandbox_id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES sandbox_pool(id), server_id TEXT NOT NULL REFERENCES opensandbox_server(id), created_at INTEGER NOT NULL);
  `);
  poolRepository = new PoolRepository(db);
  serverRepository = new ServerRepository(db);
  bindingRepository = new BindingRepository(db);
  tunnelConnectionRepository = new TunnelConnectionRepository(db);
});

describe("OpenSandbox Cluster repositories", () => {
  test("stores pools, servers and bindings", () => {
    const now = Date.now();
    poolRepository.insert({ id: "pool-1", name: "Default", status: "active", createdAt: now, updatedAt: now });
    serverRepository.insert({
      id: "server-1",
      poolId: "pool-1",
      name: "node-1",
      baseUrl: "http://node-1:8080",
      workspaceRoot: "/data/opensandbox/sandboxes",
      apiKeyCiphertext: "ciphertext",
      maxSandboxes: 2,
      status: "active",
      healthStatus: "healthy",
      createdAt: now,
      updatedAt: now,
    });
    bindingRepository.insert({ sandboxId: "sbi-1", poolId: "pool-1", serverId: "server-1", createdAt: now });

    expect(poolRepository.findById("pool-1")?.name).toBe("Default");
    expect(serverRepository.listByPool("pool-1")).toHaveLength(1);
    expect(bindingRepository.countByPool("pool-1")).toBe(1);
    expect(bindingRepository.countByServer("server-1")).toBe(1);
  });

  test("enforces globally unique sandbox ids", () => {
    const now = Date.now();
    poolRepository.insert({ id: "pool-1", name: "Default", status: "active", createdAt: now, updatedAt: now });
    serverRepository.insert({
      id: "server-1",
      poolId: "pool-1",
      name: "node-1",
      baseUrl: "http://node-1:8080",
      workspaceRoot: "/data/opensandbox/sandboxes",
      apiKeyCiphertext: "ciphertext",
      maxSandboxes: 2,
      status: "active",
      healthStatus: "healthy",
      createdAt: now,
      updatedAt: now,
    });
    bindingRepository.insert({ sandboxId: "sbi-1", poolId: "pool-1", serverId: "server-1", createdAt: now });

    expect(() =>
      bindingRepository.insert({ sandboxId: "sbi-1", poolId: "pool-1", serverId: "server-1", createdAt: now }),
    ).toThrow();
  });

  // 存量 Server 迁移后保持 direct 模式与原始地址。
  test("keeps existing servers in direct mode", () => {
    const now = Date.now();
    poolRepository.insert({ id: "pool-1", name: "Default", status: "active", createdAt: now, updatedAt: now });
    const server = serverRepository.insert({
      id: "server-a",
      poolId: "pool-1",
      name: "node-a",
      baseUrl: "http://server-a:8080",
      workspaceRoot: "/data",
      apiKeyCiphertext: "ciphertext",
      maxSandboxes: 1,
      status: "active",
      healthStatus: "healthy",
      createdAt: now,
      updatedAt: now,
    });
    expect(server.transportMode).toBe("direct");
    expect(server.baseUrl).toBe("http://server-a:8080");
  });

  // 每台 Server 的连接表最多保留一个当前租约。
  test("enforces one tunnel connection per server", () => {
    const now = Date.now();
    poolRepository.insert({ id: "pool-1", name: "Default", status: "active", createdAt: now, updatedAt: now });
    serverRepository.insert({
      id: "server-a",
      poolId: "pool-1",
      name: "node-a",
      baseUrl: "http://server-a:8080",
      workspaceRoot: "/data",
      apiKeyCiphertext: "ciphertext",
      maxSandboxes: 1,
      status: "active",
      healthStatus: "healthy",
      createdAt: now,
      updatedAt: now,
    });
    sqlite.exec(
      "INSERT INTO opensandbox_tunnel_connection (server_id, frp_run_id, status, last_seen_at, health_status, created_at, updated_at) VALUES ('server-a', 'run-1', 'connected', 1, 'healthy', 1, 1)",
    );
    expect(() =>
      sqlite.exec(
        "INSERT INTO opensandbox_tunnel_connection (server_id, frp_run_id, status, last_seen_at, health_status, created_at, updated_at) VALUES ('server-a', 'run-2', 'connected', 2, 'healthy', 2, 2)",
      ),
    ).toThrow();
  });

  // 删除 Server 时，凭证和连接租约随外键级联删除。
  test("cascades tunnel records when server is deleted", () => {
    const now = Date.now();
    poolRepository.insert({ id: "pool-1", name: "Default", status: "active", createdAt: now, updatedAt: now });
    serverRepository.insert({
      id: "server-a",
      poolId: "pool-1",
      name: "node-a",
      baseUrl: "http://server-a:8080",
      workspaceRoot: "/data",
      apiKeyCiphertext: "ciphertext",
      maxSandboxes: 1,
      status: "active",
      healthStatus: "healthy",
      createdAt: now,
      updatedAt: now,
    });
    sqlite.exec(
      "INSERT INTO opensandbox_server_credential (server_id, token_hash, token_ciphertext, token_prefix, status, created_at) VALUES ('server-a', 'hash', 'cipher', 'osn_', 'active', 1)",
    );
    sqlite.exec(
      "INSERT INTO opensandbox_tunnel_connection (server_id, frp_run_id, status, last_seen_at, health_status, created_at, updated_at) VALUES ('server-a', 'run-1', 'connected', 1, 'healthy', 1, 1)",
    );
    serverRepository.delete("server-a");
    expect(sqlite.query("SELECT * FROM opensandbox_server_credential WHERE server_id = 'server-a'").get()).toBeNull();
    expect(sqlite.query("SELECT * FROM opensandbox_tunnel_connection WHERE server_id = 'server-a'").get()).toBeNull();
  });

  // 旧连接的回调不能覆盖新连接租约。
  test("fences updates from an obsolete FRP run", () => {
    const now = Date.now();
    poolRepository.insert({ id: "pool-1", name: "Default", status: "active", createdAt: now, updatedAt: now });
    serverRepository.insert({
      id: "server-a",
      poolId: "pool-1",
      name: "node-a",
      baseUrl: "http://server-a:8080",
      workspaceRoot: "/data",
      apiKeyCiphertext: "ciphertext",
      maxSandboxes: 1,
      status: "active",
      healthStatus: "healthy",
      createdAt: now,
      updatedAt: now,
    });
    tunnelConnectionRepository.upsertLogin("server-a", "run-new", now);
    expect(tunnelConnectionRepository.markDisconnected("server-a", "run-old", now + 1)).toBe(false);
    expect(tunnelConnectionRepository.findByServerId("server-a")?.frpRunId).toBe("run-new");
  });

  // 健康探测成功时续租，避免未回调 Ping 的 FRP 版本被误判为断线。
  test("renews the tunnel lease after a healthy probe", () => {
    const now = Date.now();
    poolRepository.insert({ id: "pool-1", name: "Default", status: "active", createdAt: now, updatedAt: now });
    serverRepository.insert({
      id: "server-a",
      poolId: "pool-1",
      name: "node-a",
      baseUrl: "http://server-a:8080",
      workspaceRoot: "/data",
      apiKeyCiphertext: "ciphertext",
      maxSandboxes: 1,
      status: "active",
      healthStatus: "healthy",
      createdAt: now,
      updatedAt: now,
    });
    tunnelConnectionRepository.upsertLogin("server-a", "run-1", now);
    tunnelConnectionRepository.markConnected("server-a", "run-1", now);
    tunnelConnectionRepository.updateHealth("server-a", "run-1", "healthy", now + 1000);
    expect(tunnelConnectionRepository.findByServerId("server-a")?.lastSeenAt).toBe(now + 1000);
  });

  // stale 后健康探测成功应恢复连接状态，而不是只更新健康字段。
  test("restores a stale tunnel connection after a healthy probe", () => {
    const now = Date.now();
    poolRepository.insert({ id: "pool-1", name: "Default", status: "active", createdAt: now, updatedAt: now });
    serverRepository.insert({
      id: "server-a",
      poolId: "pool-1",
      name: "node-a",
      baseUrl: "http://server-a:8080",
      workspaceRoot: "/data",
      apiKeyCiphertext: "ciphertext",
      maxSandboxes: 1,
      status: "active",
      healthStatus: "healthy",
      createdAt: now,
      updatedAt: now,
    });
    tunnelConnectionRepository.upsertLogin("server-a", "run-1", now);
    tunnelConnectionRepository.markConnected("server-a", "run-1", now);
    tunnelConnectionRepository.markStaleDisconnected(now + 1, now + 1);
    tunnelConnectionRepository.updateHealth("server-a", "run-1", "healthy", now + 2);
    expect(tunnelConnectionRepository.findByServerId("server-a")).toMatchObject({
      status: "connected",
      disconnectedAt: null,
      healthStatus: "healthy",
      lastError: null,
    });
  });
});
