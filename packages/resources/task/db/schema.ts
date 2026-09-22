import { agentConfig } from "@fenix/agent-config/db";
import { user } from "@fenix/identity/db";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Task 模块的持久化真相来源（任务 1.7 B12）。
 *
 * 两张表由宿主 `apps/server/src/db/schema.ts` 逐字迁入：`task_execution_log`（v2 调度器的执行日志，v1
 * 调度器已下线）与 `scheduled_task_v2`（HTTP + Agent 双类型定时任务）。DDL 原样保留——迁移链由
 * `drizzle.config.ts` 同时声明本文件与宿主 schema，`check:schema-ddl-drift` 保证两边不会漂移。
 *
 * 跨包外键：`scheduled_task_v2.user_id` → `@fenix/identity/db` 的 `user.id`（`onDelete: cascade`）、
 * `scheduled_task_v2.agent_id` → `@fenix/agent-config/db` 的 `agentConfig.id`（`onDelete: set null`）；
 * `task_execution_log.task_id` 无外键（历史如此，v1/v2 任务 ID 混存）。Drizzle 的 `.references()` 只接受
 * 列对象、没有字符串形式，所以这两条列对象来源是本文件对 `@fenix/identity` / `@fenix/agent-config` 的
 * 唯一耦合。
 *
 * 这两条导入是**迁移链层面**的列对象来源，不是运行期耦合：包内 `src/**` 对宿主已零内部导入，装配依赖校验
 * （`scripts/generate-module-registry.ts` 的 `assertDependsOnComplete`）只扫 `src/**` 的值导入，因此本文件
 * 不进 `dependsOn`（同口径见 agent-config / knowledge / memory / prod-view 的 manifest 注释）；
 * `package.json` 的 `dependencies` 则必须声明 `@fenix/identity` 与 `@fenix/agent-config`，否则命中
 * `undeclared-workspace-dependency`。
 *
 * 读写只在本包仓储：`src/server/repositories/task.ts`（执行日志）与 `src/server/repositories/task-v2.ts`
 * （定时任务）经出口 `@fenix/resource-task/db` 取用表对象与行类型——**自我引用**而非相对路径，`db/` 不在本包
 * `tsconfig.json` 的 `include` 里，走出口与外部消费方同一条解析路径。宿主测试 `apps/server/src/__tests__/
 * task-schema.test.ts` 也经该出口取 `taskExecutionLog`（宿主经 owner `./db` 读写，§6.1 组装期例外口径）。
 */
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
