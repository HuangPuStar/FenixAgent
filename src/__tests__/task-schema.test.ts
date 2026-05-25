import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { scheduledTask, taskExecutionLog } from "../db/schema";

function getColumnNames(table: object): string[] {
  return Object.keys(table as Record<string, unknown>);
}

function createBaseTables(db: Database) {
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
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      cron TEXT NOT NULL,
      timezone TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'POST',
      headers TEXT,
      body TEXT,
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
      error TEXT,
      duration INTEGER,
      triggered_by TEXT NOT NULL DEFAULT 'cron',
      workspace_path TEXT,
      workspace_name TEXT,
      task_snapshot TEXT,
      skip_reason TEXT,
      result_summary TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

describe("Task Schema", () => {
  it("should export scheduledTask with HTTP cron task columns", () => {
    expect(scheduledTask).toBeTruthy();
    const columns = getColumnNames(scheduledTask);
    expect(columns).toContain("organizationId");
    expect(columns).toContain("url");
    expect(columns).toContain("method");
    expect(columns).toContain("headers");
    expect(columns).toContain("body");
    expect(columns).toContain("lastRunAt");
    expect(columns).toContain("enabled");
  });

  it("should export taskExecutionLog with agent task columns", () => {
    expect(taskExecutionLog).toBeTruthy();
    const columns = getColumnNames(taskExecutionLog);
    expect(columns).toContain("taskId");
    expect(columns).toContain("workspacePath");
    expect(columns).toContain("workspaceName");
    expect(columns).toContain("taskSnapshot");
    expect(columns).toContain("skipReason");
    expect(columns).toContain("resultSummary");
  });

  describe("CREATE TABLE SQL execution", () => {
    let db: Database;

    beforeEach(() => {
      db = new Database(":memory:");
      db.exec("PRAGMA foreign_keys = ON");
      createBaseTables(db);
    });

    it("should create scheduled_task with the expected columns", () => {
      const info = db.query("PRAGMA table_info(scheduled_task)").all() as Array<{ name: string }>;
      const colNames = info.map((column) => column.name);

      expect(colNames).toEqual([
        "id",
        "user_id",
        "organization_id",
        "name",
        "description",
        "cron",
        "timezone",
        "enabled",
        "url",
        "method",
        "headers",
        "body",
        "last_run_at",
        "next_run_at",
        "last_status",
        "created_at",
        "updated_at",
      ]);
    });

    it("should create task_execution_log with the expected columns", () => {
      const info = db.query("PRAGMA table_info(task_execution_log)").all() as Array<{ name: string }>;
      const colNames = info.map((column) => column.name);

      expect(colNames).toEqual([
        "id",
        "task_id",
        "status",
        "error",
        "duration",
        "triggered_by",
        "workspace_path",
        "workspace_name",
        "task_snapshot",
        "skip_reason",
        "result_summary",
        "created_at",
      ]);
    });

    it("should cascade delete scheduled_task when user is deleted", () => {
      db.run("INSERT INTO user VALUES ('user1', 'test', 'test@test.com', 0, NULL, 1, 1)");
      db.run(
        "INSERT INTO scheduled_task VALUES ('task1', 'user1', 'org1', 'test task', NULL, '* * * * *', NULL, 1, 'https://example.com/hook', 'POST', NULL, NULL, NULL, NULL, NULL, 1, 1)",
      );

      const before = db.query("SELECT count(*) as cnt FROM scheduled_task").get() as { cnt: number };
      expect(before.cnt).toBe(1);

      db.run("DELETE FROM user WHERE id = 'user1'");

      const after = db.query("SELECT count(*) as cnt FROM scheduled_task").get() as { cnt: number };
      expect(after.cnt).toBe(0);
    });

    it("should cascade delete task_execution_log when scheduled_task is deleted", () => {
      db.run("INSERT INTO user VALUES ('user1', 'test', 'test@test.com', 0, NULL, 1, 1)");
      db.run(
        "INSERT INTO scheduled_task VALUES ('task1', 'user1', 'org1', 'test task', NULL, '* * * * *', NULL, 1, 'https://example.com/hook', 'POST', NULL, NULL, NULL, NULL, NULL, 1, 1)",
      );
      db.run(
        "INSERT INTO task_execution_log VALUES ('log1', 'task1', 'success', NULL, 125, 'cron', '/tmp/workspace/.scheduled-runs/task1/run1', 'run1', 'echo ok', NULL, 'ok', 1)",
      );

      const before = db.query("SELECT count(*) as cnt FROM task_execution_log").get() as { cnt: number };
      expect(before.cnt).toBe(1);

      db.run("DELETE FROM scheduled_task WHERE id = 'task1'");

      const after = db.query("SELECT count(*) as cnt FROM task_execution_log").get() as { cnt: number };
      expect(after.cnt).toBe(0);
    });
  });
});
