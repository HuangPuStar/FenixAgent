import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { BindingRepository } from "../repositories/binding-repository";
import { PoolRepository } from "../repositories/pool-repository";
import { ServerRepository } from "../repositories/server-repository";

let sqlite: Database;
let poolRepository: PoolRepository;
let serverRepository: ServerRepository;
let bindingRepository: BindingRepository;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE sandbox_pool (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE opensandbox_server (id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES sandbox_pool(id), name TEXT NOT NULL, base_url TEXT NOT NULL, workspace_root TEXT NOT NULL, api_key_ciphertext TEXT NOT NULL, max_sandboxes INTEGER NOT NULL, status TEXT NOT NULL, health_status TEXT NOT NULL, last_health_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sandbox_binding (sandbox_id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES sandbox_pool(id), server_id TEXT NOT NULL REFERENCES opensandbox_server(id), created_at INTEGER NOT NULL);
  `);
  poolRepository = new PoolRepository(db);
  serverRepository = new ServerRepository(db);
  bindingRepository = new BindingRepository(db);
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
});
