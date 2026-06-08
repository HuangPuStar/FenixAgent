import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const providerProtocolEnum = pgEnum("provider_protocol", ["openai", "anthropic"]);
export const resourcePermissionTypeEnum = pgEnum("resource_permission_type", [
  "provider",
  "skill",
  "mcp_server",
  "agent_config",
]);
export const resourcePermissionPrincipalEnum = pgEnum("resource_permission_principal", ["all", "organization"]);
export const resourcePermissionActionEnum = pgEnum("resource_permission_action", ["read"]);

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

// better-auth session — activeOrganizationId 由 organization 插件在运行时管理
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
  // better-auth organization 插件会自动注入 activeOrganizationId 列
  activeOrganizationId: text("active_organization_id"),
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

// better-auth organization 插件表
export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: varchar("name").notNull(),
  slug: varchar("slug").notNull(),
  logo: text("logo"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: varchar("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserIdx: uniqueIndex("idx_member_org_user").on(table.organizationId, table.userId),
  }),
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: varchar("email").notNull(),
    role: varchar("role").notNull(),
    status: varchar("status").notNull().default("pending"),
    // better-auth organization 插件的子团队功能预留列
    // 当前未启用 teams 功能（organization() 未配置 teams.enabled: true）
    teamId: text("team_id"),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("idx_invitation_org").on(table.organizationId),
  }),
);

// better-auth api-key 插件表
export const apikey = pgTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull().default("default"),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").notNull().default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count").notNull().default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => ({
    keyIdx: index("idx_apikey_key").on(table.key),
    referenceIdx: index("idx_apikey_reference").on(table.referenceId),
  }),
);

// MCP Tool 缓存表
export const mcpTool = pgTable(
  "mcp_tool",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    serverName: varchar("server_name").notNull(),
    toolName: varchar("tool_name").notNull(),
    description: text("description"),
    inputSchema: jsonb("input_schema"),
    inspectedAt: timestamp("inspected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgServerIdx: index("idx_mcp_tool_org_server").on(table.organizationId, table.serverName),
  }),
);

// Share Link 分享链接表
export const shareLink = pgTable(
  "share_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
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
  (t) => [index("idx_share_link_org_id").on(t.organizationId)],
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
    // 已废弃：不再被读取，实际路径由 rowToRecord 用 resolveWorkspacePath(orgId, userId, envId) 实时计算
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
    organizationId: text("organization_id").notNull(),
    autoStart: boolean("auto_start").notNull().default(true),
    lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_environment_org_name").on(table.organizationId, table.name),
  }),
);

// Agent Session 持久化表（RCS 侧 session，非 better-auth session）
export const agentSession = pgTable(
  "agent_session",
  {
    id: varchar("id").primaryKey(),
    environmentId: varchar("environment_id").references(() => environment.id, { onDelete: "cascade" }),
    title: varchar("title"),
    status: varchar("status", { length: 50 }).notNull().default("idle"),
    source: varchar("source", { length: 50 }).notNull().default("acp"),
    userId: text("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    envIdx: index("idx_agent_session_org_environment_id").on(table.environmentId),
  }),
);

export const knowledgeBase = pgTable(
  "knowledge_base",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
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
    orgSlugIdx: uniqueIndex("idx_knowledge_base_org_slug").on(table.organizationId, table.slug),
    orgStatusIdx: index("idx_knowledge_base_org_status").on(table.organizationId, table.status),
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
    // 仅保存知识库策略等配置；knowledgeBaseId 仍由绑定关系本身表达，避免重复存 ID 列表。
    config: jsonb("config"),
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
    organizationId: text("organization_id").notNull(),
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
    orgIdx: index("idx_scheduled_task_org_id").on(table.organizationId),
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
    organizationId: text("organization_id").notNull(),
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
    orgPlatformIdx: index("idx_im_channel_org_platform").on(table.organizationId, table.platform),
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
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    displayName: varchar("display_name"),
    protocol: providerProtocolEnum("protocol").notNull().default("openai"),
    baseUrl: text("base_url"),
    apiKey: text("api_key"),
    extraOptions: jsonb("extra_options"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_provider_org_name").on(table.organizationId, table.name),
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
    organizationId: text("organization_id").notNull(),
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
    orgModelIdx: uniqueIndex("idx_model_org_provider_model").on(table.organizationId, table.providerId, table.modelId),
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
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    // 已废弃：不再被读取，后面使用 modelId
    model: varchar("model"),
    // 运行时正式使用 modelId 关联模型表主键。
    modelId: uuid("model_id").references(() => model.id, { onDelete: "set null" }),
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
    machineId: text("machine_id").references(() => machine.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_agent_config_org_name").on(table.organizationId, table.name),
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
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    type: varchar("type", { length: 10 }).notNull(),
    config: jsonb("config").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_mcp_server_org_name").on(table.organizationId, table.name),
  }),
);

// 技能元数据（全局技能库，内容保留在文件系统）
export const skill = pgTable(
  "skill",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    description: text("description"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_skill_org_name").on(table.organizationId, table.name),
  }),
);

// 启动数据迁移执行记录
export const dataMigrateRecord = pgTable(
  "data_migrate_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: uniqueIndex("idx_data_migrate_record_name").on(table.name),
  }),
);

export const resourcePermission = pgTable(
  "resource_permission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    resourceType: resourcePermissionTypeEnum("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    principalType: resourcePermissionPrincipalEnum("principal_type").notNull(),
    principalId: text("principal_id"),
    action: resourcePermissionActionEnum("action").notNull().default("read"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueGrantIdx: unique("idx_resource_permission_unique")
      .on(
        table.organizationId,
        table.resourceType,
        table.resourceId,
        table.principalType,
        table.principalId,
        table.action,
      )
      .nullsNotDistinct(),
    orgTypeIdx: index("idx_resource_permission_org_type").on(table.organizationId, table.resourceType),
    principalActionIdx: index("idx_resource_permission_principal_action").on(
      table.principalType,
      table.principalId,
      table.action,
    ),
    resourceIdx: index("idx_resource_permission_resource").on(table.resourceType, table.resourceId),
  }),
);

// Agent↔Skill 多对多关联
export const agentConfigSkill = pgTable(
  "agent_config_skill",
  {
    agentConfigId: uuid("agent_config_id")
      .notNull()
      .references(() => agentConfig.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skill.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: uniqueIndex("idx_agent_config_skill_pk").on(table.agentConfigId, table.skillId),
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
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    description: text("description"),
    latestVersion: integer("latest_version"),
    storagePath: text("storage_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_workflow_org_name").on(table.organizationId, table.name),
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
// Workflow Engine Event Sourcing（@fenix/workflow-engine）
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
    organizationId: text("organization_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("idx_workflow_event_run").on(table.runId),
    orgIdx: index("idx_workflow_event_org").on(table.organizationId),
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
    organizationId: text("organization_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("idx_workflow_snapshot_run").on(table.runId),
    orgIdx: index("idx_workflow_snapshot_org").on(table.organizationId),
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
    organizationId: text("organization_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runNodeIdx: uniqueIndex("idx_workflow_node_output_run_node").on(table.runId, table.nodeId),
    orgIdx: index("idx_workflow_node_output_org").on(table.organizationId),
  }),
);

// 用户偏好（单行）
export const userConfig = pgTable("user_config", {
  organizationId: text("organization_id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  defaultAgent: varchar("default_agent"),
  currentModel: varchar("current_model"),
  smallModel: varchar("small_model"),
  permission: jsonb("permission"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────���──────────────────
// Workflow Board（看板面板）
// ────────────────────────────────────────────

export const workflowBoard = pgTable(
  "workflow_board",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_workflow_board_org_name").on(table.organizationId, table.name),
    orgIdx: index("idx_workflow_board_org").on(table.organizationId),
  }),
);

// ────────────────────────────────────────────
// Workflow Job（看板 Job 实体）
// ────────────────────���───────────────────────

export const workflowJob = pgTable(
  "workflow_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => workflowBoard.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    params: jsonb("params"),
    status: varchar("status", { length: 20 }).notNull().default("ready"),
    lastRunId: varchar("last_run_id"),
    lastDagStatus: varchar("last_dag_status", { length: 20 }),
    runCount: integer("run_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    boardIdx: index("idx_workflow_job_board").on(table.boardId),
    orgIdx: index("idx_workflow_job_org").on(table.organizationId),
    statusIdx: index("idx_workflow_job_status").on(table.organizationId, table.status),
    workflowIdx: index("idx_workflow_job_workflow").on(table.workflowId),
  }),
);

// ────────────────────────────────────────────
// Workflow Trigger（外部触发器）
// ────────────────────────────────────────────

export const workflowTrigger = pgTable(
  "workflow_trigger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 30 }).notNull().default("webhook"),
    publicHash: varchar("public_hash", { length: 64 }).notNull().unique(),
    secret: varchar("secret"),
    config: jsonb("config"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hashIdx: uniqueIndex("idx_workflow_trigger_hash").on(table.publicHash),
    orgWorkflowIdx: index("idx_workflow_trigger_org_workflow").on(table.organizationId, table.workflowId),
  }),
);

// ────────────────────────────────────────────
// Registry Center（注册中心）
// ────────────────────────────────────────────

export const machine = pgTable(
  "machine",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id"),
    userId: text("user_id"),
    agentName: varchar("agent_name").notNull(),
    status: varchar("status").default("online").notNull(),
    machineInfo: jsonb("machine_info"),
    labels: jsonb("labels"),
    maxSessions: integer("max_sessions").default(5),
    heartbeatIntervalMs: integer("heartbeat_interval_ms").default(30000),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("idx_machine_org").on(table.organizationId),
    statusIdx: index("idx_machine_status").on(table.status),
  }),
);

export const registryEvent = pgTable(
  "registry_event",
  {
    id: text("id").primaryKey(),
    machineId: text("machine_id")
      .notNull()
      .references(() => machine.id, { onDelete: "cascade" }),
    type: varchar("type").notNull(),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    machineIdx: index("idx_registry_event_machine").on(table.machineId),
    typeIdx: index("idx_registry_event_type").on(table.type),
  }),
);
