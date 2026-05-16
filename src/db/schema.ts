import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb, integer, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";

// better-auth tables — primary keys stay as text (better-auth generates IDs internally)
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: varchar("name").notNull(),
  email: varchar("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// Custom tables — primary keys use uuid with PG auto-generation
export const apiKey = pgTable("api_key", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  key: varchar("key").notNull().unique(),
  label: varchar("label").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

// MCP Tool 缓存表
export const mcpTool = pgTable("mcp_tool", {
  id: uuid("id").primaryKey().defaultRandom(),
  serverName: varchar("server_name").notNull(),
  toolName: varchar("tool_name").notNull(),
  description: text("description"),
  inputSchema: jsonb("input_schema"),
  inspectedAt: timestamp("inspected_at", { withTimezone: true }).notNull().defaultNow(),
});

// Share Link 分享链接表
export const shareLink = pgTable("share_link", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: varchar("session_id").notNull(),
  environmentId: varchar("environment_id").notNull(),
  token: varchar("token").notNull().unique(),
  mode: varchar("mode", { length: 20 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: varchar("created_by").notNull(),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Share Event Snapshot 分享事件快照表
export const shareEventSnapshot = pgTable("share_event_snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  shareLinkId: uuid("share_link_id")
    .references(() => shareLink.id, { onDelete: "cascade" }),
  events: jsonb("events").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Environment 持久化表
export const environment = pgTable("environment", {
  id: varchar("id").primaryKey(),
  name: varchar("name").notNull().unique(),
  description: text("description"),
  workspacePath: varchar("workspace_path").notNull(),
  agentName: varchar("agent_name"),
  // UUID 强绑定 AgentConfig（优先于 agentName）
  agentConfigId: uuid("agent_config_id")
    .references(() => agentConfig.id, { onDelete: "set null" }),
  status: varchar("status", { length: 50 }).notNull().default("idle"),
  machineName: varchar("machine_name"),
  branch: varchar("branch"),
  gitRepoUrl: varchar("git_repo_url"),
  maxSessions: integer("max_sessions").notNull().default(1),
  workerType: varchar("worker_type", { length: 50 }).notNull().default("acp"),
  capabilities: jsonb("capabilities"),
  secret: varchar("secret").notNull(),
  userId: text("user_id").notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  autoStart: boolean("auto_start").notNull().default(false),
  lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeBase = pgTable("knowledge_base", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: varchar("name").notNull(),
  slug: varchar("slug").notNull(),
  description: text("description"),
  provider: varchar("provider").notNull().default("openviking"),
  remoteId: varchar("remote_id"),
  remoteAccountId: varchar("remote_account_id"),
  remoteUserId: varchar("remote_user_id"),
  status: varchar("status", { length: 50 }).notNull().default("empty"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userSlugIdx: uniqueIndex("idx_knowledge_base_user_slug").on(table.userId, table.slug),
  userStatusIdx: index("idx_knowledge_base_user_status").on(table.userId, table.status),
}));

export const knowledgeResource = pgTable("knowledge_resource", {
  id: uuid("id").primaryKey().defaultRandom(),
  knowledgeBaseId: uuid("knowledge_base_id")
    .notNull()
    .references(() => knowledgeBase.id, { onDelete: "cascade" }),
  sourceType: varchar("source_type").notNull(),
  sourceName: varchar("source_name").notNull(),
  sourcePath: text("source_path"),
  remoteId: varchar("remote_id"),
  status: varchar("status").notNull().default("pending"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  kbIdx: index("idx_knowledge_resource_kb").on(table.knowledgeBaseId),
  statusIdx: index("idx_knowledge_resource_status").on(table.status),
}));

export const agentKnowledgeBinding = pgTable("agent_knowledge_binding", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentName: varchar("agent_name").notNull(),
  knowledgeBaseId: uuid("knowledge_base_id")
    .notNull()
    .references(() => knowledgeBase.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  agentIdx: index("idx_agent_knowledge_binding_agent").on(table.agentName),
  kbIdx: index("idx_agent_knowledge_binding_kb").on(table.knowledgeBaseId),
  agentKbIdx: uniqueIndex("idx_agent_knowledge_binding_agent_kb").on(table.agentName, table.knowledgeBaseId),
}));

// 定时任务表（HTTP Cron 触发器）
export const scheduledTask = pgTable("scheduled_task", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: varchar("name").notNull(),
  description: text("description"),
  cron: varchar("cron").notNull(),
  timezone: varchar("timezone"),
  enabled: boolean("enabled").notNull().default(true),
  // HTTP cron 目标
  url: text("url").notNull(),
  method: varchar("method", { length: 10 }).notNull().default("POST"),
  headers: jsonb("headers"),
  body: text("body"),
  // 遗留字段（过渡期保留，deprecated）
  environmentId: varchar("environment_id")
    .references(() => environment.id, { onDelete: "cascade" }),
  task: text("task"),
  timeoutMinutes: integer("timeout_minutes").default(30),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastStatus: varchar("last_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 任务执行日志表
export const taskExecutionLog = pgTable("task_execution_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => scheduledTask.id, { onDelete: "cascade" }),
  status: varchar("status").notNull(),
  error: text("error"),
  duration: integer("duration"),
  triggeredBy: varchar("triggered_by").notNull().default("cron"),
  workspacePath: varchar("workspace_path"),
  workspaceName: varchar("workspace_name"),
  environmentId: varchar("environment_id"),
  environmentName: varchar("environment_name"),
  taskSnapshot: jsonb("task_snapshot"),
  skipReason: text("skip_reason"),
  resultSummary: text("result_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Hermes 通道绑定表
export const channelBinding = pgTable("channel_binding", {
  id: uuid("id").primaryKey().defaultRandom(),
  platform: varchar("platform").notNull(),
  chatId: varchar("chat_id"),
  agentId: varchar("agent_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  platformIdx: index("idx_channel_binding_platform").on(table.platform),
  agentIdx: index("idx_channel_binding_agent_id").on(table.agentId),
}));

// Agent Session 持久化表
export const agentSession = pgTable("agent_session", {
  id: varchar("id").primaryKey(),
  environmentId: varchar("environment_id")
    .references(() => environment.id, { onDelete: "set null" }),
  title: varchar("title"),
  status: varchar("status").notNull(),
  source: varchar("source").notNull(),
  permissionMode: varchar("permission_mode"),
  workerEpoch: integer("worker_epoch").notNull().default(0),
  username: varchar("username"),
  userId: text("user_id"),
  cwd: varchar("cwd"),
  shareMode: varchar("share_mode", { length: 20 }).notNull().default("none"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  envIdx: index("idx_agent_session_env").on(table.environmentId),
}));

// ——————————————————————————
// F002: 配置存储迁移 (fs → pg)
// ——————————————————————————

// AI 服务商
export const provider = pgTable("provider", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: varchar("name").notNull(),
  displayName: varchar("display_name"),
  npm: varchar("npm"),
  baseUrl: text("base_url"),
  apiKey: text("api_key"),
  extraOptions: jsonb("extra_options"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userNameIdx: uniqueIndex("idx_provider_user_name").on(table.userId, table.name),
}));

// AI 模型（原 provider.models 子对象）
export const model = pgTable("model", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => provider.id, { onDelete: "cascade" }),
  modelId: varchar("model_id").notNull(),
  displayName: varchar("display_name"),
  modalities: jsonb("modalities"),
  limitConfig: jsonb("limit_config"),
  cost: jsonb("cost"),
  options: jsonb("options"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  providerModelIdx: uniqueIndex("idx_model_provider_model").on(table.providerId, table.modelId),
}));

// Agent 配置
export const agentConfig = pgTable("agent_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: varchar("name").notNull(),
  model: varchar("model"),
  prompt: text("prompt"),
  steps: integer("steps"),
  mode: varchar("mode", { length: 20 }),
  permission: jsonb("permission"),
  variant: varchar("variant"),
  temperature: numeric("temperature"),
  topP: numeric("top_p"),
  disable: boolean("disable").notNull().default(false),
  hidden: boolean("hidden").notNull().default(false),
  color: varchar("color"),
  description: text("description"),
  knowledge: jsonb("knowledge"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userNameIdx: uniqueIndex("idx_agent_config_user_name").on(table.userId, table.name),
}));

// MCP 服务器
export const mcpServer = pgTable("mcp_server", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: varchar("name").notNull(),
  type: varchar("type", { length: 10 }).notNull(),
  config: jsonb("config").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userNameIdx: uniqueIndex("idx_mcp_server_user_name").on(table.userId, table.name),
}));

// 技能元数据（内容保留在文件系统 content_path）
export const skill = pgTable("skill", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  environmentId: varchar("environment_id")
    .references(() => environment.id, { onDelete: "cascade" }),
  // Agent 专属 Skill：null = 全局，UUID = 仅该 AgentConfig 可用
  agentConfigId: uuid("agent_config_id")
    .references(() => agentConfig.id, { onDelete: "cascade" }),
  name: varchar("name").notNull(),
  description: text("description"),
  contentPath: text("content_path"),
  metadata: jsonb("metadata"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  globalIdx: index("idx_skill_global").on(table.userId, table.name),
  workspaceIdx: index("idx_skill_workspace").on(table.userId, table.environmentId, table.name),
  agentIdx: index("idx_skill_agent_config").on(table.agentConfigId),
}));

// 用户偏好（单行）
export const userConfig = pgTable("user_config", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  defaultAgent: varchar("default_agent"),
  currentModel: varchar("current_model"),
  smallModel: varchar("small_model"),
  permission: jsonb("permission"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
