import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const isTest =
  process.env.NODE_ENV === "test" ||
  (typeof Bun !== "undefined" && !!Bun.env.BUN_TEST);
const DB_PATH = process.env.RCS_DB_PATH || (isTest ? ":memory:" : "./data/rcs.db");

// Ensure data directory exists
const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const sqlite = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { sqlite };

function getTableColumns(tableName: string): string[] {
  return sqlite.query(`PRAGMA table_info(${tableName})`).all().map((row: any) => row.name);
}

function ensureScheduledTaskSchema() {
  const scheduledTaskColumns = getTableColumns("scheduled_task");
  const taskLogColumns = getTableColumns("task_execution_log");

  const scheduledTaskMismatch =
    scheduledTaskColumns.length > 0 &&
    (!scheduledTaskColumns.includes("environment_id") ||
      !scheduledTaskColumns.includes("task") ||
      !scheduledTaskColumns.includes("timeout_minutes"));

  const taskLogMismatch =
    taskLogColumns.length > 0 &&
    (!taskLogColumns.includes("workspace_path") ||
      !taskLogColumns.includes("task_snapshot") ||
      !taskLogColumns.includes("result_summary"));

  if (!scheduledTaskMismatch && !taskLogMismatch) {
    return;
  }

  sqlite.exec(`
    DROP TABLE IF EXISTS task_execution_log;
    DROP TABLE IF EXISTS scheduled_task;
  `);
}

// Run table creation on startup
export function initDb() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at INTEGER,
      refresh_token_expires_at INTEGER,
      scope TEXT,
      password TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS api_key (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_api_key_key ON api_key(key);
    CREATE INDEX IF NOT EXISTS idx_api_key_user_id ON api_key(user_id);
    CREATE INDEX IF NOT EXISTS idx_session_user_id ON session(user_id);
    CREATE INDEX IF NOT EXISTS idx_session_token ON session(token);

    CREATE TABLE IF NOT EXISTS mcp_tool (
      id TEXT PRIMARY KEY,
      server_name TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      description TEXT,
      input_schema TEXT,
      inspected_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_tool_server ON mcp_tool(server_name);
    CREATE INDEX IF NOT EXISTS idx_mcp_tool_server_tool ON mcp_tool(server_name, tool_name);

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

    CREATE INDEX IF NOT EXISTS idx_environment_user_id ON environment(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_secret ON environment(secret);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_name ON environment(name);
  `);

  ensureScheduledTaskSchema();

  sqlite.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_scheduled_task_user_id ON scheduled_task(user_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_environment_id ON scheduled_task(environment_id);
    CREATE INDEX IF NOT EXISTS idx_task_execution_log_task_id ON task_execution_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_execution_log_created_at ON task_execution_log(created_at);
  `);
}

initDb();
