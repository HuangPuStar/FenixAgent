import { agentConfig } from "@fenix/agent-config/db";
import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * ProdView 领域「Agent 发布视图」表（`prod_view`）的 schema 唯一真相来源（任务 1.7 B11）。
 *
 * 迁移链历史 DDL 原样保留，只搬定义位置：表名、列名、默认值、索引名都不得顺手改动，否则
 * `bun run db:generate` 会产出非空迁移（由 `bun run check:schema-ddl-drift` 门禁强制）。行类型
 * `ProdViewRow` / `ProdViewInsert` 随表一并搬入，保持宿主定义期的导出面不变。
 *
 * `agentConfig` 是唯一的跨包外键目标：`agent_config` 聚合归 `@fenix/agent-config/db`（任务 1.7 B7），
 * 这里只导入表对象表达 `prod_view.agent_id` 的级联删除，不复制定义。该导入**不进** manifest 的
 * `dependsOn`：装配校验（`scripts/generate-module-registry.ts` 的 `assertDependsOnComplete`）只扫
 * `src/**`，表定义表达的是「列对象来自谁的迁移链」，不是运行期耦合（同口径见 `@fenix/agent-config`、
 * `@fenix/resource-knowledge` 与 `@fenix/resource-memory` 的 manifest 注释）；`package.json` 的
 * `dependencies` 则必须声明本包，否则会命中 `undeclared-workspace-dependency`。
 *
 * 本表的**读写**只在本包 `src/server/repositories/prod-view.ts`（唯一数据访问点）；消费方走本包
 * `./server` 出口的路由，不直接取表对象。跨模块外键的组装期例外口径见
 * `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1。
 */

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
