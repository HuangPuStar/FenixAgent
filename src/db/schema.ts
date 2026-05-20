import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

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

// ────────────────────────────────────────────
// Team 权限系统
// ────────────────────────────────────────────

export const team = pgTable("team", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name").notNull(),
  slug: varchar("slug").notNull().unique(),
  description: text("description"),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teamMember = pgTable(
  "team_member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamUserIdx: uniqueIndex("idx_team_member_team_user").on(table.teamId, table.userId),
  }),
);

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
  activeTeamId: uuid("active_team_id").references(() => team.id, { onDelete: "set null" }),
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
export const apiKey = pgTable(
  "api_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    // 旧列保留做迁移兼容
    key: varchar("key").notNull().unique(),
    // SHA-256 hash（64 hex chars）
    keyHash: varchar("key_hash", { length: 64 }),
    // 展示用前缀 "rcs_1234...ab12"
    keyPrefix: varchar("key_prefix", { length: 20 }).notNull().default(""),
    label: varchar("label").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("idx_api_key_team_id").on(t.teamId), uniqueIndex("idx_api_key_hash").on(t.keyHash)],
);

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
export const shareLink = pgTable(
  "share_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
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
  },
  (t) => [index("idx_share_link_team_id").on(t.teamId)],
);

// Share Event Snapshot 分享事件快照表
export const shareEventSnapshot = pgTable("share_event_snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  shareLinkId: uuid("share_link_id").references(() => shareLink.id, { onDelete: "cascade" }),
  events: jsonb("events").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Environment 持久化表
export const environment = pgTable(
  "environment",
  {
    id: varchar("id").primaryKey(),
    name: varchar("name").notNull(),
    description: text("description"),
    workspacePath: varchar("workspace_path").notNull(),
    // UUID 强绑定 AgentConfig
    agentConfigId: uuid("agent_config_id").references(() => agentConfig.id, { onDelete: "set null" }),
    status: varchar("status", { length: 50 }).notNull().default("idle"),
    machineName: varchar("machine_name"),
    branch: varchar("branch"),
    gitRepoUrl: varchar("git_repo_url"),
    maxSessions: integer("max_sessions").notNull().default(1),
    workerType: varchar("worker_type", { length: 50 }).notNull().default("acp"),
    capabilities: jsonb("capabilities"),
    secret: varchar("secret").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    autoStart: boolean("auto_start").notNull().default(false),
    lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamNameIdx: uniqueIndex("idx_environment_team_name").on(table.teamId, table.name),
  }),
);

export const knowledgeBase = pgTable(
  "knowledge_base",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
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
  },
  (table) => ({
    teamSlugIdx: uniqueIndex("idx_knowledge_base_team_slug").on(table.teamId, table.slug),
    teamStatusIdx: index("idx_knowledge_base_team_status").on(table.teamId, table.status),
  }),
);

export const knowledgeResource = pgTable(
  "knowledge_resource",
  {
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
  },
  (table) => ({
    kbIdx: index("idx_knowledge_resource_kb").on(table.knowledgeBaseId),
    statusIdx: index("idx_knowledge_resource_status").on(table.status),
  }),
);

export const agentKnowledgeBinding = pgTable(
  "agent_knowledge_binding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentConfigId: uuid("agent_config_id")
      .notNull()
      .references(() => agentConfig.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentConfigIdx: index("idx_agent_knowledge_binding_agent_config").on(table.agentConfigId),
    kbIdx: index("idx_agent_knowledge_binding_kb").on(table.knowledgeBaseId),
    agentConfigKbIdx: uniqueIndex("idx_agent_knowledge_binding_agent_config_kb").on(
      table.agentConfigId,
      table.knowledgeBaseId,
    ),
  }),
);

// 定时任务表（HTTP Cron 触发器）
export const scheduledTask = pgTable(
  "scheduled_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
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
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastStatus: varchar("last_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamIdx: index("idx_scheduled_task_team_id").on(table.teamId),
  }),
);

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
  taskSnapshot: jsonb("task_snapshot"),
  skipReason: text("skip_reason"),
  resultSummary: text("result_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// IMChannel 一等资源表（升级自 channel_binding）
export const imChannel = pgTable(
  "im_channel",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(),
    description: text("description"),
    platform: varchar("platform").notNull(),
    credentials: jsonb("credentials").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("disconnected"),
    lastError: text("last_error"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamPlatformIdx: index("idx_im_channel_team_platform").on(table.teamId, table.platform),
  }),
);

// IMChannel 路由规则表
export const imChannelRoute = pgTable(
  "im_channel_route",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => imChannel.id, { onDelete: "cascade" }),
    chatId: varchar("chat_id"),
    environmentId: varchar("environment_id")
      .notNull()
      .references(() => environment.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    channelIdx: index("idx_im_channel_route_channel").on(table.channelId),
    chatIdx: index("idx_im_channel_route_chat").on(table.channelId, table.chatId),
  }),
);

// Hermes 通道绑定表（遗留，保留兼容）
export const channelBinding = pgTable(
  "channel_binding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: varchar("platform").notNull(),
    chatId: varchar("chat_id"),
    agentId: varchar("agent_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    platformIdx: index("idx_channel_binding_platform").on(table.platform),
    agentIdx: index("idx_channel_binding_agent_id").on(table.agentId),
  }),
);

// ——————————————————————————
// F002: 配置存储迁移 (fs → pg)
// ——————————————————————————

// AI 服务商
export const provider = pgTable(
  "provider",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(),
    displayName: varchar("display_name"),
    npm: varchar("npm"),
    baseUrl: text("base_url"),
    apiKey: text("api_key"),
    extraOptions: jsonb("extra_options"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamNameIdx: uniqueIndex("idx_provider_team_name").on(table.teamId, table.name),
  }),
);

// AI 模型（原 provider.models 子对象）
export const model = pgTable(
  "model",
  {
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
  },
  (table) => ({
    providerModelIdx: uniqueIndex("idx_model_provider_model").on(table.providerId, table.modelId),
  }),
);

// Agent 配置
export const agentConfig = pgTable(
  "agent_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
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
  },
  (table) => ({
    teamNameIdx: uniqueIndex("idx_agent_config_team_name").on(table.teamId, table.name),
  }),
);

// MCP 服务器
export const mcpServer = pgTable(
  "mcp_server",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(),
    type: varchar("type", { length: 10 }).notNull(),
    config: jsonb("config").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamNameIdx: uniqueIndex("idx_mcp_server_team_name").on(table.teamId, table.name),
  }),
);

// 技能元数据（内容保留在文件系统 content_path）
export const skill = pgTable(
  "skill",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    environmentId: varchar("environment_id").references(() => environment.id, { onDelete: "cascade" }),
    // Agent 专属 Skill：null = 全局，UUID = 仅该 AgentConfig 可用
    agentConfigId: uuid("agent_config_id").references(() => agentConfig.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(),
    description: text("description"),
    contentPath: text("content_path"),
    metadata: jsonb("metadata"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    globalIdx: index("idx_skill_global").on(table.teamId, table.name),
    workspaceIdx: index("idx_skill_workspace").on(table.teamId, table.environmentId, table.name),
    agentIdx: index("idx_skill_agent_config").on(table.agentConfigId),
  }),
);

// ────────────────────────────────────────────
// Workflow 独立领域模块
// ────────────────────────────────────────────

// Workflow 定义
export const workflow = pgTable(
  "workflow",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(),
    description: text("description"),
    latestVersion: integer("latest_version"),
    storagePath: text("storage_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamNameIdx: uniqueIndex("idx_workflow_team_name").on(table.teamId, table.name),
  }),
);

// Workflow 版本（草稿 + 已发布）
export const workflowVersion = pgTable(
  "workflow_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    filePath: text("file_path").notNull(),
    status: varchar("status", { length: 20 }).notNull(), // "draft" | "published"
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowVersionIdx: uniqueIndex("idx_workflow_version_unique").on(table.workflowId, table.version),
  }),
);

// Workflow 执行记录
export const workflowRun = pgTable(
  "workflow_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    version: integer("version"),
    status: varchar("status").notNull().default("running"),
    input: jsonb("input"),
    output: jsonb("output"),
    stepResults: jsonb("step_results"),
    triggeredBy: varchar("triggered_by").notNull().default("manual"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowIdx: index("idx_workflow_run_workflow").on(table.workflowId),
    statusIdx: index("idx_workflow_run_status").on(table.status),
  }),
);

// ────────────────────────────────────────────
// Workflow Engine Event Sourcing（@mothership/workflow-engine）
// ────────────────────────────────────────────

// Workflow 事件流表
export const workflowEvent = pgTable(
  "workflow_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: varchar("event_id").notNull(),
    runId: varchar("run_id").notNull(),
    projectId: varchar("project_id"),
    nodeId: varchar("node_id"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    type: varchar("type").notNull(),
    nodeType: varchar("node_type"),
    metadata: jsonb("metadata"),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("idx_workflow_event_run").on(table.runId),
    teamIdx: index("idx_workflow_event_team").on(table.teamId),
    typeIdx: index("idx_workflow_event_run_type").on(table.runId, table.type),
    nodeIdx: index("idx_workflow_event_run_node").on(table.runId, table.nodeId),
  }),
);

// Workflow 快照表
export const workflowSnapshot = pgTable(
  "workflow_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: varchar("snapshot_id").notNull(),
    runId: varchar("run_id").notNull(),
    workflowId: uuid("workflow_id"),
    lastEventId: varchar("last_event_id").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    nodeStates: jsonb("node_states").notNull(),
    dagStatus: varchar("dag_status").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("idx_workflow_snapshot_run").on(table.runId),
    teamIdx: index("idx_workflow_snapshot_team").on(table.teamId),
    workflowIdx: index("idx_workflow_snapshot_workflow").on(table.workflowId),
  }),
);

// Workflow 节点输出表
export const workflowNodeOutput = pgTable(
  "workflow_node_output",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: varchar("run_id").notNull(),
    nodeId: varchar("node_id").notNull(),
    stdout: text("stdout").notNull().default(""),
    json: jsonb("json"),
    exitCode: integer("exit_code").notNull(),
    size: integer("size"),
    ref: text("ref"),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runNodeIdx: uniqueIndex("idx_workflow_node_output_run_node").on(table.runId, table.nodeId),
    teamIdx: index("idx_workflow_node_output_team").on(table.teamId),
  }),
);

// 用户偏好（单行）
export const userConfig = pgTable("user_config", {
  teamId: uuid("team_id")
    .primaryKey()
    .references(() => team.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  defaultAgent: varchar("default_agent"),
  currentModel: varchar("current_model"),
  smallModel: varchar("small_model"),
  permission: jsonb("permission"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
