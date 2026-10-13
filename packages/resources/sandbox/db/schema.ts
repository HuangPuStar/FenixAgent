import { organization, user } from "@fenix/identity/db";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

/**
 * 沙盒资源池与沙盒实例的 schema 唯一真相来源（任务 1.7 B4）。
 *
 * 两张表的迁移链历史 DDL 原样保留，只搬定义位置：表名、列名、默认值、索引名都不得顺手改动，否则
 * `bun run db:generate` 会产出非空迁移（由 `bun run check:schema-ddl-drift` 门禁强制）。
 *
 * `organization` / `user` 是仅有的两个跨包外键目标（身份表归 `@fenix/identity/db`，任务 1.2），这里只导入
 * 表对象表达 `sandbox_pool.organization_id` 与 `sandbox_instance.user_id` 的级联行为，不复制定义；
 * `sandbox_instance.sandbox_pool_id` 指向同文件的 `sandbox_pool`，因此不需要第三个跨包导入。
 *
 * `sandbox_instance.machine_id` 在历史 DDL 上就是**无外键约束的列**（机器可被删除而实例行保留，机器的
 * 回收由 `@fenix/resource-machine` 侧驱动），本次照原样保留——因此本文件不导入 `@fenix/resource-machine/db`。
 * 跨模块外键的组装期例外口径见
 * `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1。
 */

export const sandboxPool = pgTable(
  "sandbox_pool",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "set null" }),
    name: varchar("name").notNull(),
    providerKey: varchar("provider_key", { length: 64 }).notNull(),
    image: varchar("image").notNull(),
    defaultResources: jsonb("default_resources").notNull(),
    extra: jsonb("extra"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("idx_sandbox_pool_organization").on(table.organizationId),
    providerIdx: index("idx_sandbox_pool_provider").on(table.providerKey),
  }),
);

export const sandboxInstance = pgTable(
  "sandbox_instance",
  {
    id: text("id").primaryKey(),
    machineId: text("machine_id").notNull(),
    providerKey: varchar("provider_key", { length: 64 }).notNull(),
    sandboxPoolId: text("sandbox_pool_id")
      .notNull()
      .references(() => sandboxPool.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    externalSandboxId: varchar("external_sandbox_id"),
    status: varchar("status", { length: 32 }).notNull(),
    resolvedConfig: jsonb("resolved_config").notNull(),
    resourceOverrides: jsonb("resource_overrides"),
    providerPayload: jsonb("provider_payload"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    machineIdx: uniqueIndex("idx_sandbox_instance_machine_id").on(table.machineId),
    poolUserIdx: index("idx_sandbox_instance_pool_user").on(table.sandboxPoolId, table.userId),
    externalIdx: index("idx_sandbox_instance_external_id").on(table.externalSandboxId),
    activeUniqueIdx: uniqueIndex("idx_sandbox_instance_active_unique").on(
      table.providerKey,
      table.sandboxPoolId,
      table.userId,
    ),
  }),
);

export type SandboxPool = typeof sandboxPool.$inferSelect;
export type NewSandboxPool = typeof sandboxPool.$inferInsert;
export type SandboxInstance = typeof sandboxInstance.$inferSelect;
export type NewSandboxInstance = typeof sandboxInstance.$inferInsert;
