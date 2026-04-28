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

// Share Link 分享链接表
export const shareLink = sqliteTable("share_link", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  environmentId: text("environment_id").notNull(),
  token: text("token").notNull().unique(),
  mode: text("mode", { enum: ["readonly", "writable"] }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  createdBy: text("created_by").notNull(),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: integer("last_accessed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// Share Event Snapshot 分享事件快照表
export const shareEventSnapshot = sqliteTable("share_event_snapshot", {
  id: text("id").primaryKey(),
  shareLinkId: text("share_link_id")
    .notNull()
    .references(() => shareLink.id, { onDelete: "cascade" }),
  events: text("events").notNull(),
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

// 定时任务表
export const scheduledTask = sqliteTable("scheduled_task", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  cron: text("cron").notNull(),
  timezone: text("timezone"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  environmentId: text("environment_id")
    .notNull()
    .references(() => environment.id, { onDelete: "cascade" }),
  task: text("task").notNull(),
  timeoutMinutes: integer("timeout_minutes").notNull().default(30),
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
  error: text("error"),
  duration: integer("duration"),
  triggeredBy: text("triggered_by").notNull().default("cron"),
  workspacePath: text("workspace_path"),
  workspaceName: text("workspace_name"),
  environmentId: text("environment_id"),
  environmentName: text("environment_name"),
  taskSnapshot: text("task_snapshot"),
  skipReason: text("skip_reason"),
  resultSummary: text("result_summary"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
