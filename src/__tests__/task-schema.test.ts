import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { environment, scheduledTask, taskExecutionLog } from "../db/schema";

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

    CREATE TABLE IF NOT EXISTS environment (
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

    CREATE TABLE IF NOT EXISTS scheduled_task (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      cron TEXT NOT NULL,
      timezone TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      environment_id TEXT NOT NULL REFERENCES environment(id) ON DELETE CASCADE,
      task TEXT NOT NULL,
      timeout_minutes INTEGER NOT NULL DEFAULT 30,
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
      environment_id TEXT,
      environment_name TEXT,
      task_snapshot TEXT,
      skip_reason TEXT,
      result_summary TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

describe("Task Schema", () => {
  it("should export scheduledTask with agent task columns", () => {
    expect(scheduledTask).toBeTruthy();
    const columns = getColumnNames(scheduledTask);
    expect(columns).toContain("id");
    expect(columns).toContain("environmentId");
    expect(columns).toContain("task");
    expect(columns).toContain("timeoutMinutes");
    expect(columns).toContain("lastRunAt");
    expect(columns).toContain("enabled");
  });

  it("should export taskExecutionLog with agent task columns", () => {
    expect(taskExecutionLog).toBeTruthy();
    const columns = getColumnNames(taskExecutionLog);
    expect(columns).toContain("workspacePath");
    expect(columns).toContain("workspaceName");
    expect(columns).toContain("environmentId");
    expect(columns).toContain("taskSnapshot");
    expect(columns).toContain("skipReason");
    expect(columns).toContain("resultSummary");
  });

  it("should export environment schema required by scheduled tasks", () => {
    expect(environment).toBeTruthy();
    const columns = getColumnNames(environment);
    expect(columns).toContain("id");
    expect(columns).toContain("workspacePath");
    expect(columns).toContain("agentName");
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

      expect(info.length).toBe(15);
      expect(colNames).toEqual([
        "id",
        "user_id",
        "name",
        "description",
        "cron",
        "timezone",
        "enabled",
        "environment_id",
        "task",
        "timeout_minutes",
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

      expect(info.length).toBe(14);
      expect(colNames).toEqual([
        "id",
        "task_id",
        "status",
        "error",
        "duration",
        "triggered_by",
        "workspace_path",
        "workspace_name",
        "environment_id",
        "environment_name",
        "task_snapshot",
        "skip_reason",
        "result_summary",
        "created_at",
      ]);
    });

    it("should cascade delete scheduled_task when user is deleted", () => {
      db.run("INSERT INTO user VALUES ('user1', 'test', 'test@test.com', 0, NULL, 1, 1)");
      db.run(
        "INSERT INTO environment VALUES ('env1', 'env-one', NULL, '/tmp/workspace', 'agent-a', 'idle', NULL, NULL, NULL, 1, 'acp', NULL, 'secret1', 'user1', NULL, 1, 1)",
      );
      db.run(
        "INSERT INTO scheduled_task VALUES ('task1', 'user1', 'test task', NULL, '* * * * *', NULL, 1, 'env1', 'echo ok', 30, NULL, NULL, NULL, 1, 1)",
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
        "INSERT INTO environment VALUES ('env1', 'env-one', NULL, '/tmp/workspace', 'agent-a', 'idle', NULL, NULL, NULL, 1, 'acp', NULL, 'secret1', 'user1', NULL, 1, 1)",
      );
      db.run(
        "INSERT INTO scheduled_task VALUES ('task1', 'user1', 'test task', NULL, '* * * * *', NULL, 1, 'env1', 'echo ok', 30, NULL, NULL, NULL, 1, 1)",
      );
      db.run(
        "INSERT INTO task_execution_log VALUES ('log1', 'task1', 'success', NULL, 125, 'cron', '/tmp/workspace/.scheduled-runs/task1/run1', 'run1', 'env1', 'env-one', 'echo ok', NULL, 'ok', 1)",
      );

      const before = db.query("SELECT count(*) as cnt FROM task_execution_log").get() as { cnt: number };
      expect(before.cnt).toBe(1);

      db.run("DELETE FROM scheduled_task WHERE id = 'task1'");

      const after = db.query("SELECT count(*) as cnt FROM task_execution_log").get() as { cnt: number };
      expect(after.cnt).toBe(0);
    });
  });
});
