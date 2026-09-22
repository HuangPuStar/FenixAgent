import { agentConfig } from "@fenix/agent-config/db";
import { boolean, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Memory 领域「Agent 记忆开关」表（`agent_memory_config`）的 schema 唯一真相来源（任务 1.7 B10）。
 *
 * 迁移链历史 DDL 原样保留，只搬定义位置：表名、列名、默认值、`.unique()` 约束都不得顺手改动，
 * 否则 `bun run db:generate` 会产出非空迁移（由 `bun run check:schema-ddl-drift` 门禁强制）。
 *
 * `agentConfig` 是唯一的跨包外键目标：`agent_config` 聚合归 `@fenix/agent-config/db`（任务 1.7 B7），
 * 这里只导入表对象表达 `agent_memory_config.agent_config_id` 的级联删除与唯一约束，不复制定义。
 * 该导入**不进** manifest 的 `dependsOn`：装配校验（`scripts/generate-module-registry.ts` 的
 * `assertDependsOnComplete`）只扫 `src/**`，表定义表达的是「列对象来自谁的迁移链」，不是运行期耦合
 * （同口径见 `@fenix/agent-config` 与 `@fenix/resource-knowledge` 的 manifest 注释）；`package.json`
 * 的 `dependencies` 则必须声明本包，否则会命中 `undeclared-workspace-dependency`。
 *
 * 记忆开关的**读写**只在本包 `src/server/repositories/agent-memory-config.ts`（唯一数据访问点）；
 * 跨包消费方（`@fenix/agent-config` 的记忆开关判定与写入）走本包 `./server` 出口的
 * `isAgentMemoryEnabled` / `setEnabled`，不直接取表对象。跨模块外键的组装期例外口径见
 * `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1。
 */

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
