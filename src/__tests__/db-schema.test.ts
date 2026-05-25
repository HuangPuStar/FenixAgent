import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";

let sqlite: Database;
let _db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  _db = drizzle(sqlite, { schema });

  // Create tables
  sqlite.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE environment (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      workspace_path TEXT NOT NULL,
      agent_name TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      machine_name TEXT,
      branch TEXT,
      git_repo_url TEXT,
      max_sessions INTEGER NOT NULL DEFAULT 1,
      worker_type TEXT NOT NULL DEFAULT 'acp',
      capabilities TEXT,
      secret TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      auto_start INTEGER NOT NULL DEFAULT 0,
      last_poll_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE knowledge_base (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT,
      provider TEXT NOT NULL DEFAULT 'openviking',
      remote_id TEXT,
      remote_account_id TEXT,
      remote_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'empty',
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE knowledge_resource (
      id TEXT PRIMARY KEY,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_path TEXT,
      remote_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE agent_knowledge_binding (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX idx_environment_user_id ON environment(user_id);
    CREATE UNIQUE INDEX idx_environment_secret ON environment(secret);
    CREATE UNIQUE INDEX idx_environment_name ON environment(name);
    CREATE UNIQUE INDEX idx_knowledge_base_user_slug ON knowledge_base(user_id, slug);
    CREATE INDEX idx_knowledge_resource_kb ON knowledge_resource(knowledge_base_id);
    CREATE INDEX idx_agent_knowledge_binding_agent ON agent_knowledge_binding(agent_name);
  `);
});

describe("environment table schema", () => {
  test("table has correct columns", () => {
    const cols = sqlite.prepare("PRAGMA table_info(environment)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("name");
    expect(colNames).toContain("workspace_path");
    expect(colNames).toContain("secret");
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("status");
    expect(colNames).toContain("description");
    expect(colNames).toContain("agent_name");
    expect(colNames).toContain("capabilities");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
  });

  test("name unique constraint", () => {
    const now = Math.floor(Date.now() / 1000);
    sqlite
      .prepare("INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("u1", "Test", "test@test.com", now, now);

    sqlite
      .prepare(
        "INSERT INTO environment (id, name, workspace_path, secret, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("e1", "env-a", "/tmp/ws", "secret1", "u1", now, now);

    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO environment (id, name, workspace_path, secret, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("e2", "env-a", "/tmp/ws2", "secret2", "u1", now, now);
    }).toThrow();
  });

  test("secret unique constraint", () => {
    const now = Math.floor(Date.now() / 1000);
    sqlite
      .prepare("INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("u1", "Test", "test@test.com", now, now);

    sqlite
      .prepare(
        "INSERT INTO environment (id, name, workspace_path, secret, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("e1", "env-a", "/tmp/ws", "secret1", "u1", now, now);

    expect(() => {
      sqlite
        .prepare(
          "INSERT INTO environment (id, name, workspace_path, secret, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("e2", "env-b", "/tmp/ws2", "secret1", "u1", now, now);
    }).toThrow();
  });

  test("userId foreign key cascade delete", () => {
    const now = Math.floor(Date.now() / 1000);
    sqlite
      .prepare("INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("u1", "Test", "test@test.com", now, now);

    sqlite
      .prepare(
        "INSERT INTO environment (id, name, workspace_path, secret, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("e1", "env-a", "/tmp/ws", "secret1", "u1", now, now);

    sqlite.prepare("DELETE FROM user WHERE id = ?").run("u1");

    const rows = sqlite.prepare("SELECT * FROM environment WHERE id = ?").all("e1");
    expect(rows.length).toBe(0);
  });

  test("knowledge_base has expected columns", () => {
    const cols = sqlite.prepare("PRAGMA table_info(knowledge_base)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("slug");
    expect(colNames).toContain("status");
    expect(colNames).toContain("remote_id");
    expect(colNames).toContain("remote_account_id");
    expect(colNames).toContain("remote_user_id");
    expect(colNames).toContain("last_error");
  });

  test("knowledge_resource cascades when deleting knowledge_base", () => {
    const now = Math.floor(Date.now() / 1000);
    sqlite
      .prepare("INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("u1", "Test", "test@test.com", now, now);
    sqlite
      .prepare(
        "INSERT INTO knowledge_base (id, user_id, name, slug, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("kb1", "u1", "Docs", "docs", "openviking", "empty", now, now);
    sqlite
      .prepare(
        "INSERT INTO knowledge_resource (id, knowledge_base_id, source_type, source_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("res1", "kb1", "upload", "README.md", "pending", now, now);

    sqlite.prepare("DELETE FROM knowledge_base WHERE id = ?").run("kb1");

    const rows = sqlite.prepare("SELECT * FROM knowledge_resource WHERE id = ?").all("res1");
    expect(rows.length).toBe(0);
  });

  test("agent_knowledge_binding can be queried by agent_name", () => {
    const now = Math.floor(Date.now() / 1000);
    sqlite
      .prepare("INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("u1", "Test", "test@test.com", now, now);
    sqlite
      .prepare(
        "INSERT INTO knowledge_base (id, user_id, name, slug, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("kb1", "u1", "Docs", "docs", "openviking", "empty", now, now);
    sqlite
      .prepare(
        "INSERT INTO agent_knowledge_binding (id, agent_name, knowledge_base_id, priority, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("bind1", "build", "kb1", 0, 1, now, now);

    const rows = sqlite.prepare("SELECT * FROM agent_knowledge_binding WHERE agent_name = ?").all("build");
    expect(rows).toHaveLength(1);
  });
});
