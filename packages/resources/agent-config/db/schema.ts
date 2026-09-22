import { user } from "@fenix/identity/db";
import { model } from "@fenix/model-management/db";
import { machine } from "@fenix/resource-machine/db";
import { mcpServer } from "@fenix/resource-mcp/db";
import { skill } from "@fenix/resource-skill/db";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Agent 配置聚合的 schema 唯一真相来源（任务 1.7 B7）。
 *
 * 覆盖受控资源主表 `agent_config`、它下面的三张关联表（`agent_config_skill` / `agent_config_mcp` /
 * `agent_config_site_app`）与 Agent Sites 代理表 `agent_site_app`。五张表的迁移链历史 DDL 原样保留，
 * 只搬定义位置：表名、列名、默认值、索引名都不得顺手改动，否则 `bun run db:generate` 会产出非空迁移
 * （由 `bun run check:schema-ddl-drift` 门禁强制）。
 *
 * **三张关联表为什么在这里而不是在 `mcp` / `skill` 包**：关联表的
 * `agent_config_id` 是指向 `agent_config` 的外键，而 Drizzle 的 `.references()` 只接受列对象、没有字符串
 * 形式，任何非本包持有的关联表都必须组装期导入 `@fenix/agent-config/db`。本包对 `mcp`（7 处）与
 * `skill`（9 处）的依赖已存在，反向的 `mcp → agent-config` / `skill → agent-config` 会各自闭合一条新环
 * （实测 `check:dependencies` 会新增多类 `no-circular` 违规）；把关联表留在聚合根内则零新边、零新环。
 * 关联表唯一的读者是本包的 `src/server/services/agent-associations.ts`，所以随表迁入没有第二处调用方。
 *
 * 跨包外键目标共五个，都是组装期导入、只取列对象表达级联语义（§6.1 的例外口径）：`user`（身份表，
 * `@fenix/identity/db`，任务 1.2）、`model`（`@fenix/model-management/db`，B3）、`machine`
 * （`@fenix/resource-machine/db`，B1）、`mcpServer`（`@fenix/resource-mcp/db`，B2）、`skill`
 * （`@fenix/resource-skill/db`，B5）。调用期读取这些表的数据仍必须走对方公开入口，不得依赖本文件。
 *
 * 关联 id 的展示标签投影**不在本包**：`mcp_server.name` / `skill.name` 分别由
 * `@fenix/resource-mcp/server/config` 的 `findMcpServerLabelsByIds` 与
 * `@fenix/resource-skill/server/config` 的 `findSkillLabelsByIds` 提供，本包只给出 id 集合。
 */

/** Agent 配置：受控资源主表，`visibility` 是授权实现的唯一公开受众声明。 */
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
    description: text("description"),
    machineId: text("machine_id").references(() => machine.id, { onDelete: "set null" }),
    agentNode: jsonb("agent_node"),
    // 预留给未来可变扩展，避免为低频碎片配置反复加列。
    extra: jsonb("extra"),
    engineType: varchar("engine_type", { length: 32 }).default("peri"),
    // 资源可见范围：授权实现的唯一公开受众声明（public 对任意已认证主体开放公开默认动作）。
    visibility: varchar("visibility", { length: 20 }).notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_agent_config_org_name").on(table.organizationId, table.name),
    orgVisibilityIdx: index("idx_agent_config_org_visibility").on(table.organizationId, table.visibility),
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

// Agent↔MCP 多对多关联
export const agentConfigMcp = pgTable(
  "agent_config_mcp",
  {
    agentConfigId: uuid("agent_config_id")
      .notNull()
      .references(() => agentConfig.id, { onDelete: "cascade" }),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => mcpServer.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: uniqueIndex("idx_agent_config_mcp_pk").on(table.agentConfigId, table.mcpServerId),
  }),
);

// Agent↔SiteApp 多对多关联
// 一个 Agent 配置可绑定多个 agent-sites 应用，绑定的 sites 会出现在 chat 右侧文件区的
// 顶部 tab 中，与 Files 通过 tab 切换互斥展示。绑定层挂在 agentConfig 上，可被多个
// environment 共享，与 skill/mcp 绑定层级一致。
export const agentConfigSiteApp = pgTable(
  "agent_config_site_app",
  {
    agentConfigId: uuid("agent_config_id")
      .notNull()
      .references(() => agentConfig.id, { onDelete: "cascade" }),
    siteAppId: uuid("site_app_id")
      .notNull()
      .references(() => agentSiteApp.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: uniqueIndex("idx_agent_config_site_app_pk").on(table.agentConfigId, table.siteAppId),
    agentConfigIdx: index("idx_agent_config_site_app_agent_config").on(table.agentConfigId),
    siteAppIdx: index("idx_agent_config_site_app_site_app").on(table.siteAppId),
  }),
);

// ────────────────────────────────────────────
// Agent Sites 代理 — app 映射与凭证
// ────────────────────────────────────────────

export const agentSiteApp = pgTable(
  "agent_site_app",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    remoteAppId: varchar("remote_app_id", { length: 64 }).notNull(),
    name: varchar("name", { length: 32 }).notNull(),
    description: text("description"),
    platformToken: text("platform_token").notNull(),
    platformTokenId: varchar("platform_token_id", { length: 64 }).notNull(),
    visibility: varchar("visibility", { length: 20 }).notNull().default("private"),
    // ── custom app 部署相关 ──
    // appType 为判别字段：'pocketbase' 时下方三个字段保持 null；
    // 'custom' 时 entryFile 指定入口文件（如 'main.ts'），activeSlot 为蓝绿部署槽（'a'/'b'），
    // deployedAt 记录最后一次部署时间。
    appType: varchar("app_type", { length: 20 }).notNull().default("pocketbase"),
    entryFile: varchar("entry_file", { length: 64 }),
    activeSlot: varchar("active_slot", { length: 8 }),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    /** 创建此 site 的 agent_config id。ON DELETE SET NULL：创建者被删除时放空，兜底放开所有绑定 agent 的修改权限。 */
    createdByAgentConfigId: uuid("created_by_agent_config_id").references(() => agentConfig.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    remoteAppIdIdx: uniqueIndex("idx_agent_site_app_remote_app_id").on(table.remoteAppId),
    orgVisibilityIdx: index("idx_agent_site_app_org_visibility").on(table.organizationId, table.visibility),
    orgIdx: index("idx_agent_site_app_org").on(table.organizationId),
    userIdx: index("idx_agent_site_app_user").on(table.userId),
  }),
);
