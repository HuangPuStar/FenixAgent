import { user } from "@fenix/identity/db";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * MCP 资源表的 schema 唯一真相来源。
 *
 * 覆盖 MCP 服务器主表 `mcp_server` 与其工具缓存表 `mcp_tool`。两张表的迁移链历史 DDL 原样保留，
 * 只搬定义位置：表名、列名、默认值、索引名都不得顺手改动，否则 `bun run db:generate` 会产出非空迁移
 * （由 `bun run check:schema-ddl-drift` 门禁强制）。
 *
 * `user` 是唯一的跨包外键目标：身份表归 `@fenix/identity/db`（任务 1.2），这里只导入表对象表达
 * `mcp_server.user_id` 的级联删除，不复制定义。跨模块外键的组装期例外口径见
 * `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1。
 *
 * `agent_config_mcp` **不在**这里：它是 Agent 配置聚合的关联边，表定义归 `@fenix/agent-config/db`
 * （任务 1.7 B7 随 `agent_config` 一起迁出）。`agent_config_mcp.mcp_server_id` 的外键由那边组装期导入
 * 本文件的 `mcpServer` 表达；反向的 `mcp → agent-config` 导入会闭合一条新环，因此本包不持有该表。
 */

/** MCP Tool 缓存表：由 inspector 探测后写入，随所属 server 的生命周期整体替换。 */
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

/** MCP 服务器：受控资源主表，`visibility` 是授权实现的唯一公开受众声明。 */
export const mcpServer = pgTable(
  "mcp_server",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    type: varchar("type", { length: 32 }).notNull(),
    config: jsonb("config").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // 资源可见范围：授权实现的唯一公开受众声明（public 对任意已认证主体开放公开默认动作）。
    visibility: varchar("visibility", { length: 20 }).notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_mcp_server_org_name").on(table.organizationId, table.name),
    orgVisibilityIdx: index("idx_mcp_server_org_visibility").on(table.organizationId, table.visibility),
  }),
);
