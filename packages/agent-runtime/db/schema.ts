import { agentConfig } from "@fenix/agent-config/db";
import { user } from "@fenix/identity/db";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Agent Runtime 的领域表：`environment`（运行环境）与 `agent_instance`（持久实例）。
 *
 * 两张表在任务 1.7 B8 从宿主 `apps/server/src/db/schema.ts` 迁入本文件，DDL 与列序逐字保留
 * （`bun run check:schema-ddl-drift` 零差异）；出口 `@fenix/agent-runtime/db`，由 `drizzle.config.ts`
 * 与其余 owner 的 schema 一起汇入同一条迁移链。
 *
 * **两条跨包外键**：`environment.agent_config_id → agent_config.id`（owner `@fenix/agent-config`）与
 * 两张表的 `user_id` / `owner_user_id` / `created_by_user_id → user.id`（owner `@fenix/identity`）。Drizzle 的
 * `.references()` 只接受列对象、没有字符串形式，因此这两个包必须在**组装期**被导入——例外口径见
 * `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1：只允许 `db/**` 路径，`src/**` 的调用期
 * 跨包表访问仍按 §2.3 判定。`@fenix/agent-config` 与 `@fenix/identity` 因此都声明在 `package.json`。
 *
 * `.dependency-cruiser.cjs` 的 `agent-runtime-not-to-resources`（禁止本包反向依赖资源包）**已显式豁免
 * `db/**`**，其注释点名的就是 `environment.agent_config_id` 这条跨模块外键——即本文件是其唯一的合法落点；
 * `src/**` 侧的反向禁则不变（本包读 Agent 配置只经宿主注入的 `AgentConfigLookupPort`）。
 *
 * 宿主在 B8 与 B13 之间曾导入 `environment`：它的 `im_channel_route.environment_id` 需要该表对象，而
 * `im_channel_route` 属 B13（channel）迁移批次。B13 已交付——该表迁入 `@fenix/resource-channel/db`，
 * 外键列对象的取用方随之转移，宿主 `apps/server/src/db/schema.ts` 那一行 import 同批删除（B13 起宿主
 * schema 不再导入任何 owner 包的表对象）。
 */

/** 实例创建来源：`user` 手工新建、`api` 由 HTTP 入口自动创建、`workflow` 由工作流节点创建。 */
export const agentInstanceCreationSourceEnum = pgEnum("agent_instance_creation_source", ["user", "api", "workflow"]);

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
    orgUserAgentConfigIdx: uniqueIndex("idx_environment_org_user_agent_config")
      .on(table.organizationId, table.userId, table.agentConfigId)
      .where(sql`${table.agentConfigId} is not null`),
  }),
);

export const agentInstance = pgTable(
  "agent_instance",
  {
    id: varchar("id", { length: 80 }).primaryKey(),
    environmentId: varchar("environment_id")
      .notNull()
      .references(() => environment.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    creationSource: agentInstanceCreationSourceEnum("creation_source").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    creationKeyIdx: uniqueIndex("idx_agent_instance_creation_key").on(
      table.environmentId,
      table.ownerUserId,
      table.creationSource,
      table.name,
    ),
    defaultOwnerIdx: uniqueIndex("idx_agent_instance_default_owner")
      .on(table.environmentId, table.ownerUserId)
      .where(sql`${table.isDefault} = true`),
    defaultConstraint: check(
      "agent_instance_default_check",
      sql`${table.isDefault} = (${table.creationSource} = 'user' AND ${table.name} = 'default')`,
    ),
    nameConstraint: check("agent_instance_name_check", sql`char_length(btrim(${table.name})) BETWEEN 1 AND 100`),
  }),
);

export type AgentInstance = typeof agentInstance.$inferSelect;
export type NewAgentInstance = typeof agentInstance.$inferInsert;
