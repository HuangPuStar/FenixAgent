import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// better-auth tables
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

// Custom tables
export const apiKey = sqliteTable("api_key", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  key: text("key").notNull().unique(),
  label: text("label").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
});

// MCP Tool 缓存表
export const mcpTool = sqliteTable("mcp_tool", {
  id: text("id").primaryKey(),
  serverName: text("server_name").notNull(),
  toolName: text("tool_name").notNull(),
  description: text("description"),
  inputSchema: text("input_schema"),
  inspectedAt: integer("inspected_at", { mode: "timestamp" }).notNull(),
});

// 定时任务表
export const scheduledTask = sqliteTable("scheduled_task", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  url: text("url").notNull(),
  method: text("method").notNull().default("GET"),
  headers: text("headers"),
  body: text("body"),
  timeout: integer("timeout").notNull().default(30000),
  retryEnabled: integer("retry_enabled", { mode: "boolean" }).notNull().default(false),
  retryCount: integer("retry_count").notNull().default(3),
  retryInterval: integer("retry_interval").notNull().default(60),
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  nextRunAt: integer("next_run_at", { mode: "timestamp" }),
  lastStatus: text("last_status"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// 任务执行日志表
export const taskExecutionLog = sqliteTable("task_execution_log", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => scheduledTask.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  statusCode: integer("status_code"),
  responseBody: text("response_body"),
  error: text("error"),
  duration: integer("duration"),
  attempt: integer("attempt").notNull().default(1),
  triggeredBy: text("triggered_by").notNull().default("cron"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Environment 持久化表
export const environment = sqliteTable("environment", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  workspacePath: text("workspace_path").notNull(),
  agentName: text("agent_name"),
  status: text("status").notNull().default("idle"),
  machineName: text("machine_name"),
  branch: text("branch"),
  gitRepoUrl: text("git_repo_url"),
  maxSessions: integer("max_sessions").notNull().default(1),
  workerType: text("worker_type").notNull().default("acp"),
  capabilities: text("capabilities"),
  secret: text("secret").notNull(),
  userId: text("user_id").notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  lastPollAt: integer("last_poll_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
