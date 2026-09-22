/**
 * 宿主 schema（任务 1.7 B 块收口后的最终形态）。
 *
 * 本文件只留三类内容：① 身份表定义由 `@fenix/identity/db` 拥有（CE 阶段 2 任务 1.2），这里只**
 * 转出**、不重复定义；② 宿主自有表 `data_migrate_record`（部署期数据迁移执行记录）；③ D3 裁定留在
 * 宿主的三张旧授权栈表（`resource_permission` + 3 个 pgEnum、`share_link`、`share_event_snapshot`——
 * 它们无 owner、也无任何外键指向，因此不参与 1.7 的批次）。
 *
 * **B13 之后本文件不再导入任何 owner 包的表对象**：业务表定义随任务 1.7 的 B1–B13 全部迁至各 owner
 * 包的 `db/schema.ts`，跨包外键的列对象来源也随之离开（`@fenix/agent-config/db` 随 B12、`environment`
 * 随 B13 删除——后者的最后使用点是 `im_channel_route.environment_id`，随该表迁入
 * `@fenix/resource-channel/db`）。因此宿主不再是「同时持有全部 owner 表定义的装配层」：那条组装期
 * 例外的说明只对**调用期**仍然成立（§6.1）。跨包读身份数据走 `IdentityDirectory`，读各 owner 领域
 * 数据走各自的服务端入口或注入端口，不得依赖本文件。
 *
 * 迁移链是全部 owner schema 与宿主 schema 的共同产物：`drizzle.config.ts` 必须同时声明它们，否则
 * `db:generate` 会把漏声明的一族误判为已删除。
 */

export {
  account,
  apikey,
  invitation,
  member,
  organization,
  session,
  user,
  verification,
} from "@fenix/identity/db";

import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// 旧授权栈的三个 pg enum 与下方 `resourcePermission` 表随 CE 阶段 2 任务 1.2 的 CE 授权栈下线而失去全部
// 读写方，但**不能在本发布内删除**：`services/data-migrates/backfill-resource-visibility.ts` 仍要把旧栈的
// `principal_type='all' AND action='read'` 记录回填成资源主表的 `visibility='public'`，而 SQL 迁移先于启动期
// data migration 执行——同一发布内 DROP 会让全新库启动即失败、升级库静默丢失公开共享语义。
// removeWhen：回填已在全部环境记入 `data_migrate_record` 的下一个发布，同时删除回填迁移并生成 DROP TABLE 迁移。
export const resourcePermissionTypeEnum = pgEnum("resource_permission_type", [
  "provider",
  "skill",
  "mcp_server",
  "agent_config",
]);
export const resourcePermissionPrincipalEnum = pgEnum("resource_permission_principal", ["all", "organization"]);
export const resourcePermissionActionEnum = pgEnum("resource_permission_action", ["read"]);

// Share Link 分享链接表
export const shareLink = pgTable(
  "share_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    sessionId: varchar("session_id").notNull(),
    environmentId: varchar("environment_id").notNull(),
    token: varchar("token").notNull().unique(),
    mode: varchar("mode", { length: 20 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: varchar("created_by").notNull(),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_share_link_org_id").on(t.organizationId)],
);

// Share Event Snapshot 分享事件快照表
export const shareEventSnapshot = pgTable("share_event_snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  shareLinkId: uuid("share_link_id").references(() => shareLink.id, { onDelete: "cascade" }),
  events: jsonb("events").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 一次性数据迁移执行记录（由部署期入口 `db/data-migration-runner.ts` 写入，不随应用启动执行）
export const dataMigrateRecord = pgTable(
  "data_migrate_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: uniqueIndex("idx_data_migrate_record_name").on(table.name),
  }),
);

/**
 * 旧授权栈的授权表：新授权栈把受众收敛到资源主表的归属列（`organization_id` + `visibility`），
 * 本表的全部读写方已随任务 1.2 删除，仅剩启动期回填迁移读取（见上方 enum 处的 removeWhen 说明）。
 */
export const resourcePermission = pgTable(
  "resource_permission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    resourceType: resourcePermissionTypeEnum("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    principalType: resourcePermissionPrincipalEnum("principal_type").notNull(),
    principalId: text("principal_id"),
    action: resourcePermissionActionEnum("action").notNull().default("read"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueGrantIdx: unique("idx_resource_permission_unique")
      .on(
        table.organizationId,
        table.resourceType,
        table.resourceId,
        table.principalType,
        table.principalId,
        table.action,
      )
      .nullsNotDistinct(),
    orgTypeIdx: index("idx_resource_permission_org_type").on(table.organizationId, table.resourceType),
    principalActionIdx: index("idx_resource_permission_principal_action").on(
      table.principalType,
      table.principalId,
      table.action,
    ),
    resourceIdx: index("idx_resource_permission_resource").on(table.resourceType, table.resourceId),
  }),
);
