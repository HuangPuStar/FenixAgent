import { index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Machine 资源表的 schema 唯一真相来源。
 *
 * 覆盖机器注册表 `machine` 与其生命周期事件表 `registry_event`。这两张表的迁移链历史 DDL 原样保留，
 * 只搬定义位置：表名、列名、默认值、索引名都不得顺手改动，否则 `bun run db:generate` 会产出非空迁移
 * （由 `bun run check:schema-ddl-drift` 门禁强制）。
 *
 * 其他模块（含宿主 `apps/server/src/db/schema.ts`）只导入这里的表对象表达外键，不复制定义——
 * 跨模块外键的组装期例外口径见 `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1。
 */

/** 已注册的机器（acp-link 客户端）。除 `id` 主键外只有 `machine_info` jsonb 是稳定字段。 */
export const machine = pgTable(
  "machine",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id"),
    userId: text("user_id"),
    agentName: varchar("agent_name").notNull(),
    name: varchar("name"),
    type: varchar("type", { length: 32 }).notNull().default("machine"),
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
    typeIdx: index("idx_machine_type").on(table.type),
    statusIdx: index("idx_machine_status").on(table.status),
  }),
);

/** 机器注册事件流水：register / heartbeat / offline 等状态迁移的审计轨迹。 */
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
