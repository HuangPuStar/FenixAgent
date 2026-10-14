import { gitRepositoryBindings } from "@fenix/git/db";
import { sql } from "drizzle-orm";
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
 * 工单模块的持久化真相来源（五张表）。
 *
 * 这是这五张表**唯一**的定义处：`@fenix/git/db` 出口供本包服务端、宿主迁移链消费，宿主 schema 不复制。
 * `drizzle.config.ts` 必须同时声明本文件与其余 owner schema（否则 `db:generate` 会把这一族误判为已删除），
 * `check:schema-ddl-drift` 保证迁移链与定义零漂移。
 *
 * 事实源边界：仓库、Issue、评论、标签与附件的事实源是 Forgejo，本包只保存 AOS 侧的**查询索引、消息归属、
 * 操作账本与通知**。`ticket_messages` 是身份头可信性的判定依据（远端对象 ↔ AOS 作者），不是展示缓存。
 *
 * 决策记录（T02 已裁定，改动前先读）：
 *
 * - **R1 不建 identity 外键**：`author_id` / `assignee_id` / `recipient_id` / `last_editor_id` 都是 `text`，
 *   不指向 `user.id`。`ticket_messages` 是审计证据——身份行删除时 `set null` 会抹掉作者归属，`cascade`
 *   会删掉整条归属记录；负责人是可变业务字段，离职后仍要保留展示引用。代价是没有数据库级引用完整性，
 *   由 Facade 的成员核验与展示回退覆盖；身份完整性由 identity 模块自己承担。
 * - **R2 跨包外键只有一处**：`repository_ref → git_repository_bindings.id`，在 `db/**` **组装期**导入
 *   `@fenix/git/db` 的表对象（Drizzle `.references()` 只接受列对象，属 ce-ee 工程规范 §6.1 的例外）。
 *   `onDelete: "restrict"`：绑定被删时不允许留下悬空项目。
 * - **R3 外部数字 ID 一律 `varchar`**：`issue_number`、`provider_object_id`、`provider_repository_id` 都是
 *   字符串，与 `@fenix/git` 的领域类型一致（Forgejo 的 int64 超过 2^53 后 JS number 不再精确）。
 * - **R4 组装期导入不进 `dependsOn`**：`@fenix/git/db` 只出现在本文件，`src/**` 不读他包表；
 *   `dependsOn: ["git"]` 是给 `src/**` 的值导入（`GitError` 判定）用的，两者互不冲突。
 * - **R5 迁移**：改本文件后跑 `bun run db:generate --name <module>-<change>` → 审查 `drizzle/*.sql` 与
 *   `drizzle/meta/*` → `bun run db:migrate`。禁止手写 SQL：部分唯一索引必须在这里表达，手写进 `.sql`
 *   不会进 snapshot（下次 `db:generate` 会重复创建，且「schema 与库」表面零差异而实际不一致）。
 */

/** 工单项目：一个 AOS 组织在一个仓库绑定上的工单空间（一个绑定最多一个项目）。 */
export const ticketProjects = pgTable(
  "ticket_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** 仓库绑定 ID（`git_repository_bindings.id`）；仓库事实源归 Git 模块，本包只引用。 */
    repositoryRef: uuid("repository_ref")
      .notNull()
      .references(() => gitRepositoryBindings.id, { onDelete: "restrict" }),
    /** bind 时写入的仓库坐标快照：列表/详情展示与排障用；重新绑定同一绑定时刷新。 */
    connectionId: varchar("connection_id", { length: 64 }).notNull(),
    providerRepositoryId: varchar("provider_repository_id", { length: 64 }).notNull(),
    owner: varchar("owner", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    /** active / paused：paused 只停写（与 git 绑定 status 同语义：暂停写入并重新同步）。 */
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ticket_projects_repository_ref_uq").on(table.repositoryRef),
    // 每组织仅一条 active default：方案 §6 的部分唯一索引。paused 的默认项目不占名额，
    // 因此「暂停组织工单」= 把默认项目置 paused（组织暂时没有 active default）。
    uniqueIndex("ticket_projects_default_active_uq")
      .on(table.organizationId)
      .where(sql`${table.isDefault} AND ${table.status} = 'active'`),
    index("ticket_projects_org_idx").on(table.organizationId),
  ],
);

/** 操作账本：幂等键、intent/step/status 与结果。T02 只有 issue.create 与 project.provision。 */
export const ticketOperations = pgTable(
  "ticket_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** 开通项目的操作在成功前没有项目行，因此可空；成功后写回 projectId。 */
    projectId: uuid("project_id").references(() => ticketProjects.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    targetId: varchar("target_id", { length: 64 }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    /** 身份头的 message_id；project.provision 无正文，故可空。 */
    messageId: varchar("message_id", { length: 64 }),
    expectedVersion: varchar("expected_version", { length: 64 }),
    /** 待发送正文（含标题）；成功/明确失败后立即改写成摘要，uncertain 保留到恢复核对完成。 */
    intent: jsonb("intent").$type<Record<string, unknown>>(),
    step: varchar("step", { length: 32 }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ticket_operations_idempotency_uq").on(table.organizationId, table.actorId, table.idempotencyKey),
    index("ticket_operations_status_idx").on(table.status, table.updatedAt),
    index("ticket_operations_project_idx").on(table.projectId),
    /**
     * 在途变更互斥的查询索引（T03 §5.5）：每次写操作都要问一次「同一对象上还有没有未确认的变更」，
     * 而这张表随写入线性增长，没有索引时该查询会随项目历史全表扫。
     *
     * 谓词与 §5.5 的阻塞状态集合逐字一致；终态行不进索引（它们永不参与互斥判定），因此用**部分索引**
     * 而不是普通复合索引——`status` 是低基数且被写频繁更新的列，普通索引会让每次终态写入都多维护一条。
     */
    index("ticket_operations_inflight_idx")
      .on(table.projectId, table.targetId, table.kind)
      .where(sql`${table.status} NOT IN ('succeeded','failed')`),
  ],
);

/** 消息归属：远端对象 ↔ AOS 作者的唯一关联，是身份头可信性的判定依据。 */
export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => ticketProjects.id, { onDelete: "cascade" }),
    /** issue / comment（comment 归 T03）。 */
    objectKind: varchar("object_kind", { length: 16 }).notNull(),
    /** issue number 或 comment id（字符串承载；外部数字 ID 不得退化为 number）。 */
    providerObjectId: varchar("provider_object_id", { length: 64 }).notNull(),
    messageId: varchar("message_id", { length: 64 }).notNull(),
    authorId: text("author_id").notNull(),
    authorNameSnapshot: text("author_name_snapshot").notNull(),
    bodyHash: varchar("body_hash", { length: 64 }).notNull(),
    revision: integer("revision").notNull().default(1),
    lastEditorId: text("last_editor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ticket_messages_object_uq").on(table.projectId, table.objectKind, table.providerObjectId),
    uniqueIndex("ticket_messages_message_id_uq").on(table.messageId),
    index("ticket_messages_project_idx").on(table.projectId),
  ],
);

/** 查询索引：列表只读这张表；详情回源 Forgejo（方案 §8）。 */
export const ticketIndex = pgTable(
  "ticket_index",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => ticketProjects.id, { onDelete: "cascade" }),
    issueNumber: varchar("issue_number", { length: 32 }).notNull(),
    title: text("title").notNull(),
    state: varchar("state", { length: 16 }).notNull(),
    authorId: text("author_id"),
    authorName: text("author_name"),
    assigneeId: text("assignee_id"),
    labelIds: jsonb("label_ids").$type<string[]>().notNull().default([]),
    contentVersion: varchar("content_version", { length: 64 }).notNull(),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    /** ready / stale：初次全量同步未覆盖的行不得伪装成「没有工单」（方案 §8）。 */
    syncStatus: varchar("sync_status", { length: 20 }).notNull().default("ready"),
  },
  (table) => [
    uniqueIndex("ticket_index_project_issue_uq").on(table.projectId, table.issueNumber),
    index("ticket_index_project_state_idx").on(table.projectId, table.state, table.issueNumber),
  ],
);

/** 站内通知（T05 写入；表归 T02 建，方案 §6）。 */
export const ticketNotifications = pgTable(
  "ticket_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    recipientId: text("recipient_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => ticketProjects.id, { onDelete: "cascade" }),
    issueNumber: varchar("issue_number", { length: 32 }).notNull(),
    /** 稳定对象及修订标识去重（不能以 webhook 到达次数计数，方案 §9）。 */
    eventKey: varchar("event_key", { length: 128 }).notNull(),
    type: varchar("type", { length: 32 }).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ticket_notifications_recipient_event_uq").on(table.recipientId, table.eventKey),
    index("ticket_notifications_inbox_idx").on(table.recipientId, table.readAt, table.createdAt),
  ],
);

export type TicketProjectRow = typeof ticketProjects.$inferSelect;
export type TicketOperationRow = typeof ticketOperations.$inferSelect;
export type TicketMessageRow = typeof ticketMessages.$inferSelect;
export type TicketIndexRow = typeof ticketIndex.$inferSelect;
