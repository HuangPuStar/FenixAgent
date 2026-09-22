import { agentConfig } from "@fenix/agent-config/db";
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
 * Knowledge 领域的 schema 唯一真相来源（任务 1.7 B9）。
 *
 * 覆盖知识库主表 `knowledge_base`、它的资源表 `knowledge_resource` 与 Agent 绑定表
 * `agent_knowledge_binding`。三张表的迁移链历史 DDL 原样保留，只搬定义位置：表名、列名、默认值、
 * 索引名都不得顺手改动，否则 `bun run db:generate` 会产出非空迁移（由
 * `bun run check:schema-ddl-drift` 门禁强制）。
 *
 * **三条跨包外键目标**，都是组装期导入、只取列对象表达级联语义（§6.1 的例外口径）：
 * `user`（身份表，`@fenix/identity/db`，任务 1.2）出现 1 次；`agentConfig`
 * （`@fenix/agent-config/db`，B7）出现 1 次，是 `agent_knowledge_binding.agent_config_id`——绑定表
 * 表达「哪个 Agent 绑了哪个知识库」，其写入口只有本包 `repositories/knowledge-base.ts` 的
 * `agentKnowledgeBindingRepo`，调用期读 `agent_config` 的数据仍必须走 agent-config 的公开入口。
 *
 * **`agent_knowledge_binding` 为什么在本包而不是随聚合根归 agent-config**（§4.7 的 B9 行已如此
 * 排定，与 D4「三张 join 表随聚合根归 agent-config」的处置刻意不同）：本包是绑定表唯一的读写方
 * （`agentKnowledgeBindingRepo` 的 11 个方法、`services/knowledge-runtime.ts` 的检索路径都按
 * `agentConfigId` 取绑定），而 agent-config 侧只经 `associations.listKnowledgeBindings` 转发到本包。
 * 反向的 `knowledge → agent-config` 因此只有这一条组装期外键边，不闭合任何环：`agent-config/db` 只
 * 导入 identity / model-management / machine / mcp / skill 的 schema，`agent-config/src` 到本包 src
 * 的既有边无法经 `agent-config/db` 折回本包（实测 `check:dependencies` 的包对环指纹无新增）。
 *
 * 知识库 id 的展示投影**不在消费方**：`@fenix/resource-knowledge/server/summaries` 的
 * `findKnowledgeBaseSummariesByIds` 提供 id → `{ name, slug }` 的批量投影，消费方给出 id 集合与
 * 资源归属组织即可。
 */

export const knowledgeBase = pgTable(
  "knowledge_base",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    slug: varchar("slug").notNull(),
    description: text("description"),
    provider: varchar("provider").notNull().default("ragflow"),
    remoteId: varchar("remote_id"),
    remoteAccountId: varchar("remote_account_id"),
    remoteUserId: varchar("remote_user_id"),
    status: varchar("status", { length: 50 }).notNull().default("empty"),
    lastError: text("last_error"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgSlugIdx: uniqueIndex("idx_knowledge_base_org_slug").on(table.organizationId, table.slug),
    orgStatusIdx: index("idx_knowledge_base_org_status").on(table.organizationId, table.status),
  }),
);

export const knowledgeResource = pgTable(
  "knowledge_resource",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: "cascade" }),
    sourceType: varchar("source_type").notNull(),
    sourceName: varchar("source_name").notNull(),
    sourcePath: text("source_path"),
    remoteId: varchar("remote_id"),
    status: varchar("status").notNull().default("pending"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kbIdx: index("idx_knowledge_resource_kb").on(table.knowledgeBaseId),
    statusIdx: index("idx_knowledge_resource_status").on(table.status),
  }),
);

export const agentKnowledgeBinding = pgTable(
  "agent_knowledge_binding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentConfigId: uuid("agent_config_id")
      .notNull()
      .references(() => agentConfig.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBase.id, { onDelete: "cascade" }),
    // 仅保存知识库策略等配置；knowledgeBaseId 仍由绑定关系本身表达，避免重复存 ID 列表。
    config: jsonb("config"),
    priority: integer("priority").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentConfigIdx: index("idx_agent_knowledge_binding_agent_config").on(table.agentConfigId),
    kbIdx: index("idx_agent_knowledge_binding_kb").on(table.knowledgeBaseId),
    agentConfigKbIdx: uniqueIndex("idx_agent_knowledge_binding_agent_config_kb").on(
      table.agentConfigId,
      table.knowledgeBaseId,
    ),
  }),
);
