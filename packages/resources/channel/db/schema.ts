import { agentConfig } from "@fenix/agent-config/db";
import { user } from "@fenix/identity/db";
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
 * Channel 模块的持久化真相来源。
 *
 * 四张表归本包：`im_channel`（LangBot Bot 一等资源）、`im_channel_route`（聊天 → Agent 配置的路由规则）、
 * `im_channel_conversation`（每个 IM 聊天的长会话映射）与 `im_channel_event`（入站事件去重与投递记录）。
 * 旧的 `channel_binding` 已随 Hermes 移除由 `drizzle/` 的 drop 迁移删除。
 *
 * 路由绑定 `agent_config.id` 而不是 `environment.id`：environment 是运行态、按「通道所有者 + Agent 配置」
 * 派生，把它放进路由会让配置依赖派生对象（`docs/arch/30-langbot-channel-gateway.md` §5.1）。
 *
 * 跨包外键都是组装期导入、只取列对象表达级联语义（§6.1 例外）：`im_channel.user_id` →
 * `@fenix/identity/db` 的 `user.id`（级联）；三处 `agent_config_id` → `@fenix/agent-config/db` 的
 * `agent_config.id`，路由与会话级联删除，事件表 `set null` 以保留审计行。Drizzle 的 `.references()`
 * 只接受列对象、没有字符串形式，因此这些导入无法消除。
 *
 * 这些导入是**迁移链层面**的列对象来源，不是运行期耦合：`scripts/generate-module-registry.ts` 的
 * `assertDependsOnComplete` 只扫 `src/**` 的值导入，因此本文件不进 `dependsOn`；`package.json` 的
 * `dependencies` 仍须声明这两个 workspace 包，否则命中 `undeclared-workspace-dependency`。
 *
 * 枚举列用 `varchar` + TypeScript 联合类型，不用 `pgEnum`：取值集合随通道能力演进，新增或更名一个状态
 * 不应触发 enum 的 DDL 变更。
 */

/** IM 聊天类型：私聊按用户 ID、群聊按群 ID 去重，两者 ID 空间独立，匹配时必须带上类型。 */
export type ImChatType = "person" | "group";

/** 入站事件的投递状态；只表达投递结果，不表达「是否已回复」（回复是工具调用，无法与事件一一对应）。 */
export type ImChannelEventStatus = "received" | "delivered" | "failed" | "skipped";

/** 投递方式：`prompt` 是冷启动唤醒，`notification` 是暖会话订阅通知。 */
export type ImChannelEventDeliveryVia = "prompt" | "notification";

export const imChannel = pgTable(
  "im_channel",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    description: text("description"),
    platform: varchar("platform").notNull(),
    credentials: jsonb("credentials").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("disconnected"),
    lastError: text("last_error"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgPlatformIdx: index("idx_im_channel_org_platform").on(table.organizationId, table.platform),
  }),
);

// IMChannel 路由规则表：一行 = 某通道里某个聊天（或该类型的全部聊天）交给哪个 Agent 配置。
export const imChannelRoute = pgTable(
  "im_channel_route",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => imChannel.id, { onDelete: "cascade" }),
    chatType: varchar("chat_type", { length: 16 }).$type<ImChatType>().notNull(),
    // null 表示该 chat_type 的通配路由；精确路由与通配路由各由一条部分唯一索引保证最多一条。
    chatId: varchar("chat_id"),
    agentConfigId: uuid("agent_config_id")
      .notNull()
      .references(() => agentConfig.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    exactUq: uniqueIndex("idx_im_channel_route_exact_uq")
      .on(table.channelId, table.chatType, table.chatId)
      .where(sql`${table.chatId} is not null`),
    wildcardUq: uniqueIndex("idx_im_channel_route_wildcard_uq")
      .on(table.channelId, table.chatType)
      .where(sql`${table.chatId} is null`),
    matchIdx: index("idx_im_channel_route_match").on(table.channelId, table.chatType, table.chatId),
  }),
);

// 一个 IM 聊天的长会话映射：只存会话键，不存聊天正文。
export const imChannelConversation = pgTable(
  "im_channel_conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => imChannel.id, { onDelete: "cascade" }),
    chatType: varchar("chat_type", { length: 16 }).$type<ImChatType>().notNull(),
    chatId: varchar("chat_id").notNull(),
    agentConfigId: uuid("agent_config_id")
      .notNull()
      .references(() => agentConfig.id, { onDelete: "cascade" }),
    // 确定性 Chat 会话键（Y.Doc / relay / 冷启动 prompt 的隔离键），不得写入随机值或时间戳。
    rcsSessionId: varchar("rcs_session_id", { length: 128 }).notNull(),
    // null 表示尚未完成 ACP 握手。
    acpSessionId: varchar("acp_session_id", { length: 128 }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chatUq: uniqueIndex("idx_im_channel_conversation_chat_uq").on(table.channelId, table.chatType, table.chatId),
    rcsSessionUq: uniqueIndex("idx_im_channel_conversation_rcs_session_uq").on(table.rcsSessionId),
  }),
);

// 入站 Webhook 事件的投递记录：去重键 + 短期正文快照 + 投递状态。
export const imChannelEvent = pgTable(
  "im_channel_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => imChannel.id, { onDelete: "cascade" }),
    eventUuid: varchar("event_uuid", { length: 128 }).notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    chatType: varchar("chat_type", { length: 16 }).$type<ImChatType>().notNull(),
    chatId: varchar("chat_id").notNull(),
    // Webhook 必须在 15 秒内返回，而 Agent 只能在订阅通知之后异步读取，正文不能只留在内存里
    // （多实例与重启会丢）；读取后立即置空，未读取按 TTL 清理。
    text: text("text"),
    readAt: timestamp("read_at", { withTimezone: true }),
    senderId: varchar("sender_id", { length: 128 }),
    agentConfigId: uuid("agent_config_id").references(() => agentConfig.id, { onDelete: "set null" }),
    status: varchar("status", { length: 20 }).$type<ImChannelEventStatus>().notNull(),
    deliveryVia: varchar("delivery_via", { length: 16 }).$type<ImChannelEventDeliveryVia>(),
    attempts: integer("attempts").notNull().default(1),
    lastError: text("last_error"),
    ackSentAt: timestamp("ack_sent_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    // 终态时间：status 初始为 received 时还没有终态，因此可空。
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => ({
    channelEventUq: uniqueIndex("idx_im_channel_event_channel_event_uq").on(table.channelId, table.eventUuid),
    statusIdx: index("idx_im_channel_event_status").on(table.status, table.receivedAt),
    chatIdx: index("idx_im_channel_event_chat").on(table.channelId, table.chatType, table.chatId, table.receivedAt),
  }),
);
