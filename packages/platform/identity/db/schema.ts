import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

/**
 * 身份表的 schema 唯一真相来源。
 *
 * 覆盖 better-auth 的用户/会话/账号/验证表、organization 插件的组织/成员/邀请表、api-key 插件表，
 * 以及引用 `user` 的 `user_config`。其余模块只通过导入这里的表对象表达外键，不复制定义。
 *
 * 定义必须与迁移链中的历史 DDL 保持等价：表名、列名、默认值、索引名都不得顺手改动，否则
 * `bun run db:generate` 会产出非空迁移。这些表的所属模块在 CE 阶段 2 任务 1.2 由
 * `apps/server/src/db/schema.ts` 迁入，迁移链本身不改写。
 */

// better-auth tables — primary keys stay as text (better-auth generates IDs internally)
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: varchar("name").notNull(),
  email: varchar("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  phoneNumber: varchar("phone_number", { length: 32 }).unique(),
  phoneNumberVerified: boolean("phone_number_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// better-auth session — activeOrganizationId 由 organization 插件在运行时管理
export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // better-auth organization 插件会自动注入 activeOrganizationId 列
  activeOrganizationId: text("active_organization_id"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// better-auth organization 插件表
export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: varchar("name").notNull(),
  slug: varchar("slug").notNull(),
  logo: text("logo"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: varchar("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserIdx: uniqueIndex("idx_member_org_user").on(table.organizationId, table.userId),
  }),
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: varchar("email").notNull(),
    role: varchar("role").notNull(),
    status: varchar("status").notNull().default("pending"),
    // better-auth organization 插件的子团队功能预留列
    // 当前未启用 teams 功能（organization() 未配置 teams.enabled: true）
    teamId: text("team_id"),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("idx_invitation_org").on(table.organizationId),
  }),
);

// better-auth api-key 插件表
export const apikey = pgTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull().default("default"),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").notNull().default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count").notNull().default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => ({
    keyIdx: index("idx_apikey_key").on(table.key),
    referenceIdx: index("idx_apikey_reference").on(table.referenceId),
  }),
);

// 用户偏好（单行）
export const userConfig = pgTable("user_config", {
  organizationId: text("organization_id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  defaultAgent: varchar("default_agent"),
  currentModel: varchar("current_model"),
  smallModel: varchar("small_model"),
  permission: jsonb("permission"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
