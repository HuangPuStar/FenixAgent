import { user } from "@fenix/identity/db";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Workflow 领域表的 schema 唯一真相来源。
 *
 * 覆盖九张表：定义与版本（`workflow` / `workflow_version`）、执行记录（`workflow_run`）、引擎
 * Event Sourcing 三表（`workflow_event` / `workflow_snapshot` / `workflow_node_output`）、看板
 * （`workflow_board` / `workflow_job`）与外部触发器（`workflow_trigger`）。这些表的迁移链历史 DDL
 * 原样保留，只搬定义位置：表名、列名、默认值、索引名都不得顺手改动，否则 `bun run db:generate`
 * 会产出非空迁移（由 `bun run check:schema-ddl-drift` 门禁强制）。
 *
 * `user` 是唯一的跨包外键目标（`workflow.user_id`、`workflow_version.created_by`、
 * `workflow_board.user_id`、`workflow_job.user_id` 四条级联删除）：身份表归 `@fenix/identity/db`
 * （任务 1.2），这里只导入表对象表达外键，不复制定义。`organization_id` 各列在历史 DDL 上都是**无
 * 外键约束**的 text 列，因此不导入 `organization`。跨模块外键的组装期例外口径见
 * `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1。
 *
 * 表间外键（`workflow_version` / `workflow_run` / `workflow_job` / `workflow_trigger` → `workflow`，
 * `workflow_job` → `workflow_board`）在本文件内闭合，因此没有任何别的包需要为了表达外键而导入它们
 * ——宿主 `apps/server/src/db/schema.ts` 迁出后不再持有这九张表。
 */

/** Workflow 定义。`latest_version` 与 `storage_path` 可空：草稿尚未发布时为 null。 */
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

/** Workflow 版本（草稿 + 已发布）。`status` 取值 `draft` | `published`。 */
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

/** Workflow 执行记录。 */
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

// ── Workflow Engine Event Sourcing（消费方是 `@fenix/workflow-engine`）──

/** Workflow 事件流表。`run_id` / `project_id` 是引擎侧标识，历史 DDL 上无外键约束。 */
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

/** Workflow 快照表。`workflow_id` 历史 DDL 上就是无外键约束的 uuid 列，故不表达引用。 */
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

/** Workflow 节点输出表。`ref` 指向落盘的大体积产物，`json` 与 `stdout` 是内联的小体积副本。 */
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

/** Workflow Board（看板面板）。`is_default` 标记组织默认看板。 */
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

/** Workflow Job（看板 Job 实体）：一次可被反复触发的 workflow 绑定 + 参数。 */
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

/** Workflow Trigger（外部触发器）。`public_hash` 是 webhook 的公开路径片段，`secret` 仅在需要签名时使用。 */
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
