import { agentConfig } from "@fenix/agent-config/db";
import { environment } from "@fenix/agent-runtime/db";
import { user } from "@fenix/identity/db";
import { sql } from "drizzle-orm";

/**
 * 宿主只从已迁出的 owner 包**取用**表对象，不重复定义。
 *
 * 身份表由 `@fenix/identity/db` 拥有（CE 阶段 2 任务 1.2），这里只转出、不重复定义；Agent 配置聚合的
 * 五张表由 `@fenix/agent-config/db` 拥有（任务 1.7 B7）；`environment` / `agent_instance` 由
 * `@fenix/agent-runtime/db` 拥有（任务 1.7 B8）。宿主是唯一同时持有全部 owner 表定义的层：宿主的业务表
 * 需要它们作为外键目标，而 Drizzle 的 `.references()` 只接受列对象、没有字符串形式。它们与宿主表共用
 * 同一条迁移链（`drizzle.config.ts` 同时声明全部 schema 文件），因此并置不会产生第二份真相；跨包读取
 * 身份数据仍必须走 `IdentityDirectory`，读 Agent 配置仍必须走 `@fenix/agent-config` 的服务端入口，
 * 读运行环境与实例仍必须走 `@fenix/agent-runtime` 的服务端入口，不得依赖本文件。
 * 组装期例外的口径与边界见 `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1。
 *
 * 本文件里 `agentConfig` 的三个使用点都是宿主自有表的外键：`task_execution_log`、
 * `agent_memory_config`、`prod_view`（各引用一次 `agent_config.id`），它们随 B10–B12 按拓扑序迁出宿主；
 * 另两处随表迁走——`environment.agent_config_id` 在 B8 随该表迁入 `@fenix/agent-runtime/db`，
 * `agent_knowledge_binding.agent_config_id` 在 B9 随三张知识库表迁入 `@fenix/resource-knowledge/db`。
 * `environment` 这个 import 只剩一个使用点：`im_channel_route.environment_id`（B13 迁 channel 后本文件
 * 连这一行也不再需要）。
 *
 * **B7 之后本文件不再导入的包**：`@fenix/model-management/db`、`@fenix/resource-machine/db`、
 * `@fenix/resource-mcp/db`、`@fenix/resource-skill/db`——它们此前只被 `agent_config.model_id` /
 * `agent_config.machine_id` / `agent_config_mcp.mcp_server_id` / `agent_config_skill.skill_id` 四处外键
 * 取用，这四张表随 B7 迁入 `@fenix/agent-config/db` 后，本文件连 `import` 一行也不再需要（宿主其它
 * 位置仍是这些包的合法消费方，例如 `services/data-migrates/` 直接按归属取它们的 `db/` 出口）。
 * **B9 之后同理**：`knowledge_base` / `knowledge_resource` / `agent_knowledge_binding` 三张表迁入
 * `@fenix/resource-knowledge/db`，宿主对它们本就只有定义、没有任何引用方（`apps/server/src/__tests__/
 * db-schema.test.ts` 用自写的 SQLite DDL，不取 Drizzle 表对象），因此本文件连一个 import 都不留。
 *
 * 任务 1.7 B6 的 Workflow 九张领域表、B8 的 `agent_instance` 与 B9 的知识库三张表从未出现在这份清单里：
 * B6 九张表的表间外键在 `@fenix/resource-workflow/db` 内闭合；`agent_instance` 的外键目标是 `environment`
 * 与 `user`，知识库三张表的外键目标是 `agent_config` / `user` 与自身——都不是宿主表，宿主任何表都不引用
 * 它们。
 */
export {
  account,
  apikey,
  invitation,
  member,
  organization,
  session,
  user,
  verification,
} from "@fenix/identity/db";

import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// 旧授权栈的三个 pg enum 与下方 `resourcePermission` 表随 CE 阶段 2 任务 1.2 的 CE 授权栈下线而失去全部
// 读写方，但**不能在本发布内删除**：`services/data-migrates/backfill-resource-visibility.ts` 仍要把旧栈的
// `principal_type='all' AND action='read'` 记录回填成资源主表的 `visibility='public'`，而 SQL 迁移先于启动期
// data migration 执行——同一发布内 DROP 会让全新库启动即失败、升级库静默丢失公开共享语义。
// removeWhen：回填已在全部环境记入 `data_migrate_record` 的下一个发布，同时删除回填迁移并生成 DROP TABLE 迁移。
export const resourcePermissionTypeEnum = pgEnum("resource_permission_type", [
  "provider",
  "skill",
  "mcp_server",
  "agent_config",
]);
export const resourcePermissionPrincipalEnum = pgEnum("resource_permission_principal", ["all", "organization"]);
export const resourcePermissionActionEnum = pgEnum("resource_permission_action", ["read"]);

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

// 任务执行日志表（v2 调度器使用；v1 调度器已下线）
export const taskExecutionLog = pgTable("task_execution_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull(),
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

// 定时任务表 v2（HTTP + Agent 双类型）。
// v1 的 scheduled_task 表已下线（见迁移 remove-scheduled-task-v1），历史数据不迁移。
export const scheduledTaskV2 = pgTable(
  "scheduled_task_v2",
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
    timeoutSeconds: integer("timeout_seconds").notNull().default(300),
    agentId: uuid("agent_id").references(() => agentConfig.id, { onDelete: "set null" }),
    type: varchar("type").notNull(),
    definition: jsonb("definition").notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastStatus: varchar("last_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userOrgIdx: index("idx_scheduled_task_v2_user_org").on(table.userId, table.organizationId),
    agentIdx: index("idx_scheduled_task_v2_agent_id").on(table.agentId),
  }),
);

export type ScheduledTaskV2Row = typeof scheduledTaskV2.$inferSelect;
export type ScheduledTaskV2Insert = typeof scheduledTaskV2.$inferInsert;

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

// Agent 记忆配置（独立表，承载记忆开关状态，为后续扩展预留）
export const agentMemoryConfig = pgTable("agent_memory_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentConfigId: uuid("agent_config_id")
    .notNull()
    .unique()
    .references(() => agentConfig.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 一次性数据迁移执行记录（由部署期入口 `db/data-migration-runner.ts` 写入，不随应用启动执行）
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

/**
 * 旧授权栈的授权表：新授权栈把受众收敛到资源主表的归属列（`organization_id` + `visibility`），
 * 本表的全部读写方已随任务 1.2 删除，仅剩启动期回填迁移读取（见上方 enum 处的 removeWhen 说明）。
 */
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

// ProdView 智能体发布视图
export const prodView = pgTable(
  "prod_view",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    description: text("description"),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentConfig.id, { onDelete: "cascade" }),
    modulesConfig: jsonb("modules_config").notNull().default(sql`'{}'`),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_prod_view_org_id").on(t.organizationId), index("idx_prod_view_agent_id").on(t.agentId)],
);

export type ProdViewRow = typeof prodView.$inferSelect;
export type ProdViewInsert = typeof prodView.$inferInsert;
