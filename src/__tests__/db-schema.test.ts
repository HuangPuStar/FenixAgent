import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";

let sqlite: Database;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  db = drizzle(sqlite, { schema });

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
      last_poll_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX idx_environment_user_id ON environment(user_id);
    CREATE UNIQUE INDEX idx_environment_secret ON environment(secret);
    CREATE UNIQUE INDEX idx_environment_name ON environment(name);
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
    sqlite.prepare("INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("u1", "Test", "test@test.com", now, now);

    sqlite.prepare(
      "INSERT INTO environment (id, name, workspace_path, secret, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("e1", "env-a", "/tmp/ws", "secret1", "u1", now, now);

    expect(() => {
      sqlite.prepare(
        "INSERT INTO environment (id, name, workspace_path, secret, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("e2", "env-a", "/tmp/ws2", "secret2", "u1", now, now);
    }).toThrow();
  });

  test("secret unique constraint", () => {
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("u1", "Test", "test@test.com", now, now);

    sqlite.prepare(
      "INSERT INTO environment (id, name, workspace_path, secret, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("e1", "env-a", "/tmp/ws", "secret1", "u1", now, now);

    expect(() => {
      sqlite.prepare(
        "INSERT INTO environment (id, name, workspace_path, secret, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("e2", "env-b", "/tmp/ws2", "secret1", "u1", now, now);
    }).toThrow();
  });

  test("userId foreign key cascade delete", () => {
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("u1", "Test", "test@test.com", now, now);

    sqlite.prepare(
      "INSERT INTO environment (id, name, workspace_path, secret, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("e1", "env-a", "/tmp/ws", "secret1", "u1", now, now);

    sqlite.prepare("DELETE FROM user WHERE id = ?").run("u1");

    const rows = sqlite.prepare("SELECT * FROM environment WHERE id = ?").all("e1");
    expect(rows.length).toBe(0);
  });
});
