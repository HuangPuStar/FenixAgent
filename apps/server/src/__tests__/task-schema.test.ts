import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { taskExecutionLog } from "../db/schema";

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

    CREATE TABLE IF NOT EXISTS task_execution_log (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
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
  });
});
