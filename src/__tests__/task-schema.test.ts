import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { scheduledTask, taskExecutionLog } from "../db/schema";

// Extract column names from schema for verification
function getColumnNames(table: any): string[] {
  return Object.keys(table);
}

describe("Task Schema", () => {
  it("should export scheduledTask with correct columns", () => {
    expect(scheduledTask).toBeTruthy();
    const columns = getColumnNames(scheduledTask);
    expect(columns).toContain("id");
    expect(columns).toContain("userId");
    expect(columns).toContain("name");
    expect(columns).toContain("cron");
    expect(columns).toContain("url");
    expect(columns).toContain("enabled");
    expect(columns).toContain("headers");
    expect(columns).toContain("body");
    expect(columns).toContain("timeout");
    expect(columns).toContain("retryEnabled");
    expect(columns).toContain("retryCount");
    expect(columns).toContain("retryInterval");
    expect(columns).toContain("lastRunAt");
    expect(columns).toContain("nextRunAt");
    expect(columns).toContain("lastStatus");
    expect(columns).toContain("createdAt");
    expect(columns).toContain("updatedAt");
  });

  it("should export taskExecutionLog with correct columns", () => {
    expect(taskExecutionLog).toBeTruthy();
    const columns = getColumnNames(taskExecutionLog);
    expect(columns).toContain("id");
    expect(columns).toContain("taskId");
    expect(columns).toContain("status");
    expect(columns).toContain("statusCode");
    expect(columns).toContain("responseBody");
    expect(columns).toContain("error");
    expect(columns).toContain("duration");
    expect(columns).toContain("attempt");
    expect(columns).toContain("triggeredBy");
    expect(columns).toContain("createdAt");
  });

  describe("CREATE TABLE SQL execution", () => {
    let db: Database;

    beforeEach(() => {
      db = new Database(":memory:");
      db.exec("PRAGMA foreign_keys = ON");
    });

    it("should create scheduled_task table successfully", () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          email_verified INTEGER NOT NULL DEFAULT 0,
          image TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scheduled_task (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          cron TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'UTC',
          enabled INTEGER NOT NULL DEFAULT 1,
          url TEXT NOT NULL,
          method TEXT NOT NULL DEFAULT 'GET',
          headers TEXT,
          body TEXT,
          timeout INTEGER NOT NULL DEFAULT 30000,
          retry_enabled INTEGER NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 3,
          retry_interval INTEGER NOT NULL DEFAULT 60,
          last_run_at INTEGER,
          next_run_at INTEGER,
          last_status TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      const info = db.query("PRAGMA table_info(scheduled_task)").all() as any[];
      expect(info.length).toBe(20); // 20 columns
      const colNames = info.map((c) => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("cron");
      expect(colNames).toContain("url");
    });

    it("should create task_execution_log table successfully", () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          email_verified INTEGER NOT NULL DEFAULT 0,
          image TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scheduled_task (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          cron TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'UTC',
          enabled INTEGER NOT NULL DEFAULT 1,
          url TEXT NOT NULL,
          method TEXT NOT NULL DEFAULT 'GET',
          headers TEXT,
          body TEXT,
          timeout INTEGER NOT NULL DEFAULT 30000,
          retry_enabled INTEGER NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 3,
          retry_interval INTEGER NOT NULL DEFAULT 60,
          last_run_at INTEGER,
          next_run_at INTEGER,
          last_status TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_execution_log (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES scheduled_task(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          status_code INTEGER,
          response_body TEXT,
          error TEXT,
          duration INTEGER,
          attempt INTEGER NOT NULL DEFAULT 1,
          triggered_by TEXT NOT NULL DEFAULT 'cron',
          created_at INTEGER NOT NULL
        );
      `);

      const info = db.query("PRAGMA table_info(task_execution_log)").all() as any[];
      expect(info.length).toBe(10); // 10 columns
      const colNames = info.map((c) => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("task_id");
      expect(colNames).toContain("status");
    });

    it("should cascade delete scheduled_task when user is deleted", () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          email_verified INTEGER NOT NULL DEFAULT 0,
          image TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scheduled_task (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          cron TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'UTC',
          enabled INTEGER NOT NULL DEFAULT 1,
          url TEXT NOT NULL,
          method TEXT NOT NULL DEFAULT 'GET',
          headers TEXT,
          body TEXT,
          timeout INTEGER NOT NULL DEFAULT 30000,
          retry_enabled INTEGER NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 3,
          retry_interval INTEGER NOT NULL DEFAULT 60,
          last_run_at INTEGER,
          next_run_at INTEGER,
          last_status TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      // Insert user
      db.run("INSERT INTO user VALUES ('user1', 'test', 'test@test.com', 0, NULL, 1, 1)");
      // Insert scheduled_task referencing user
      db.run("INSERT INTO scheduled_task VALUES ('task1', 'user1', 'test task', NULL, '* * * * *', 'UTC', 1, 'https://example.com', 'GET', NULL, NULL, 30000, 0, 3, 60, NULL, NULL, NULL, 1, 1)");

      // Verify task exists
      const before = db.query("SELECT count(*) as cnt FROM scheduled_task").get() as any;
      expect(before.cnt).toBe(1);

      // Delete user — should cascade
      db.run("DELETE FROM user WHERE id = 'user1'");

      const after = db.query("SELECT count(*) as cnt FROM scheduled_task").get() as any;
      expect(after.cnt).toBe(0);
    });
  });
});
