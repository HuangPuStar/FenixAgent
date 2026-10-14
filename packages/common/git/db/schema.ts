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
 * 公共 Git 模块的持久化真相来源（四张表）。
 *
 * 这是这四张表**唯一**的定义处：`@fenix/git/db` 出口供本包仓储与迁移链消费，宿主 schema 不复制。
 * `drizzle.config.ts` 必须同时声明本文件与其余 owner schema，`check:schema-ddl-drift` 保证迁移链
 * 与定义不漂移。
 *
 * 归属边界（对应方案 §6）：Forgejo 是仓库、Issue、评论、标签与附件的事实源；本包只保存
 * **AOS 侧的绑定、订阅、事件与投递账本**——查询索引与通知属工单模块（`@fenix/resource-tickets`），
 * 不在本包建表。
 *
 * 表间外键都是包内引用（bindings → subscriptions / events → deliveries），不涉及跨包列对象，
 * 因此本文件没有跨包导入。
 */

/**
 * 仓库绑定：一个 Forgejo 仓库与一个 AOS 组织的归属契约。
 *
 * 当前采用「一个仓库只归属一个 AOS 组织」，跨组织共享仓库不在本次合同内（方案 §6）。
 * `allowedConsumers` 存受控 consumerId 到操作集合的映射（如 `{"tickets":["issues.read","issues.write"]}`），
 * 仅宿主管理接口与 `scripts/git-bootstrap.ts` 可修改；普通业务调用者不能自行扩大权限。
 * `webhookSecretRef` / `credentialRef` 都是 `{env:NAME}` 形式的密钥引用，只允许指向 Git manifest
 * 已声明并注入的 secret 键（解析规则见 `src/server/config.ts`）。
 */
export const gitRepositoryBindings = pgTable(
  "git_repository_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    connectionId: varchar("connection_id", { length: 64 }).notNull(),
    providerRepositoryId: varchar("provider_repository_id", { length: 64 }).notNull(),
    owner: varchar("owner", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    /** 日常读写凭据引用（受限服务账号）；初始化凭据在连接配置的 provisionToken，两者刻意分开。 */
    credentialRef: varchar("credential_ref", { length: 128 }).notNull(),
    /** consumerId → 允许的操作集合；空对象表示不授予任何消费者。 */
    allowedConsumers: jsonb("allowed_consumers").$type<Record<string, string[]>>().notNull().default({}),
    webhookId: varchar("webhook_id", { length: 64 }),
    webhookSecretRef: varchar("webhook_secret_ref", { length: 128 }),
    /** active / paused；暂停用于「Forgejo 管理端直接维护前暂停该仓库写入并重新同步」的运维动作。 */
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("git_repository_bindings_connection_repo_uq").on(table.connectionId, table.providerRepositoryId),
    index("git_repository_bindings_org_idx").on(table.organizationId),
  ],
);

/**
 * 消费者订阅：某个绑定上的事件类型订阅开关。
 *
 * 工单停用时暂停其订阅（`enabled = false`），其他消费者独立工作；GitModule 本身不理解通知语义，
 * 只按订阅分发投递。
 */
export const gitEventSubscriptions = pgTable(
  "git_event_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => gitRepositoryBindings.id, { onDelete: "cascade" }),
    /** 受控 consumerId（静态注册，不从请求正文取）。 */
    consumerId: varchar("consumer_id", { length: 64 }).notNull(),
    /** 订阅的事件类型（如 `issues`、`issue_comment`）。 */
    eventTypes: jsonb("event_types").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    /** 未确认投递超过保留期后置为 needs_resync，先全量校对再恢复处理，不静默丢弃。 */
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("git_event_subscriptions_binding_consumer_uq").on(table.bindingId, table.consumerId)],
);

/**
 * 已接收的 Webhook 事件（去重账本）。
 *
 * `(bindingId, deliveryId)` 唯一：相同 delivery_id 重送返回成功但不再生成投递记录。`payload` 是
 * 原始请求体的规范化 JSON；保留期 7 天（全部消费者确认后），去重标识保留 30 天（方案 §6 的保留策略
 * 由 T04 的清理任务执行，表定义在本批一次成型）。
 */
export const gitEvents = pgTable(
  "git_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => gitRepositoryBindings.id, { onDelete: "cascade" }),
    deliveryId: varchar("delivery_id", { length: 128 }).notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    /** 事件主体标识（如 issue number）；Webhook 载荷里没有稳定主体时为 null。 */
    subjectId: varchar("subject_id", { length: 128 }),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("git_events_binding_delivery_uq").on(table.bindingId, table.deliveryId),
    index("git_events_received_idx").on(table.receivedAt),
  ],
);

/**
 * 事件投递账本：每个事件 × 每个订阅各一行。
 *
 * 消费者用短事务 + SKIP LOCKED 领取投递，再释放事务执行处理；租约默认 60 秒、15 秒续约（租约与重试
 * 的具体调度在 T04 实现）。`attempts` 记录自动尝试次数，失败按 5 秒至 5 分钟退避、最多 10 次后
 * 进入 failed 待重试。
 */
export const gitEventDeliveries = pgTable(
  "git_event_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => gitEvents.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => gitEventSubscriptions.id, { onDelete: "cascade" }),
    /** pending / processing / succeeded / failed。 */
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: varchar("lease_owner", { length: 128 }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("git_event_deliveries_event_subscription_uq").on(table.eventId, table.subscriptionId),
    index("git_event_deliveries_dispatch_idx").on(table.status, table.nextAttemptAt),
  ],
);

export type GitRepositoryBindingRow = typeof gitRepositoryBindings.$inferSelect;
export type GitRepositoryBindingInsert = typeof gitRepositoryBindings.$inferInsert;
export type GitEventSubscriptionRow = typeof gitEventSubscriptions.$inferSelect;
export type GitEventRow = typeof gitEvents.$inferSelect;
export type GitEventDeliveryRow = typeof gitEventDeliveries.$inferSelect;
