import { user } from "@fenix/identity/db";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Skill 资源行（`skill`）的 schema 唯一真相来源。
 *
 * 迁移链历史 DDL 原样保留，只搬定义位置：表名、列名、默认值、索引名都不得顺手改动，否则
 * `bun run db:generate` 会产出非空迁移（由 `bun run check:schema-ddl-drift` 门禁强制）。
 *
 * `user` 是唯一的跨包外键目标：身份表归 `@fenix/identity/db`（任务 1.2），这里只导入表对象表达
 * `skill.user_id` 的级联删除，不复制定义。`organization_id` 历史 DDL 上就是无外键约束的 text 列，
 * 组织归属由应用层（授权栈的归属列声明）维护，本次照原样保留——因此本文件不导入 identity 的
 * `organization`。
 *
 * `agent_config_skill.skill_id` 的外键由 `@fenix/agent-config/db` 表达：该关联表随 `agent_config` 聚合
 * 归 agent-config（任务 1.7 B7，join 表裁定见评审文档 §8.4 第 8 条），它在自己的 `db/schema.ts` 导入本包
 * 的 `skill` 表对象表达级联语义，本包不再声明该关联表、也不再持有它的读写。跨模块外键的组装期例外口径见
 * `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1。
 */

// 技能元数据（全局技能库，内容保留在文件系统）
export const skill = pgTable(
  "skill",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    description: text("description"),
    metadata: jsonb("metadata"),
    // 资源可见范围：授权实现的唯一公开受众声明（public 对任意已认证主体开放公开默认动作）。
    visibility: varchar("visibility", { length: 20 }).notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_skill_org_name").on(table.organizationId, table.name),
    orgVisibilityIdx: index("idx_skill_org_visibility").on(table.organizationId, table.visibility),
  }),
);
