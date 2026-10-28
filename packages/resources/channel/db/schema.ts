import { environment } from "@fenix/agent-runtime/db";
import { user } from "@fenix/identity/db";
import { boolean, index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Channel 模块的持久化真相来源。
 *
 * `im_channel`（IMChannel 一等资源表）与 `im_channel_route`（IMChannel 路由规则）两张表归本包；
 * 旧的 `channel_binding` 表随 Hermes 通道实现一并删除（`drizzle/` 的 drop 迁移），
 * 消息通道能力与 LangBot 接入随后续任务重建，届时在本文件新增表。
 *
 * **这两张表目前没有任何读写方**：目标态（IMChannel 取代旧的 Hermes 绑定）尚未实现，本包只持有表定义，
 * 不提供仓储。保留定义是为了让「一张表的定义只在一个 owner 手里」这一不变量继续成立
 * （`drizzle.config.ts` 声明本文件，`check:schema-ddl-drift` 保证与迁移链零差异）。
 *
 * 两条跨包外键：`im_channel.user_id` → `@fenix/identity/db` 的 `user.id`（级联）、
 * `im_channel_route.environment_id` → `@fenix/agent-runtime/db` 的 `environment.id`（级联），
 * 另有表内的 `im_channel_route.channel_id` → `im_channel.id`。Drizzle 的 `.references()` 只接受列对象、
 * 没有字符串形式，因此前两条是本文件对 `@fenix/identity` / `@fenix/agent-runtime` 的唯一耦合。
 *
 * 这两条导入是**迁移链层面**的列对象来源，不是运行期耦合：`scripts/generate-module-registry.ts` 的
 * `assertDependsOnComplete` 只扫 `src/**` 的值导入，因此本文件不进 `dependsOn`；`package.json` 的
 * `dependencies` 仍须声明这两个 workspace 包，否则命中 `undeclared-workspace-dependency`。
 */
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

// IMChannel 路由规则表
export const imChannelRoute = pgTable(
  "im_channel_route",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => imChannel.id, { onDelete: "cascade" }),
    chatId: varchar("chat_id"),
    environmentId: varchar("environment_id")
      .notNull()
      .references(() => environment.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    channelIdx: index("idx_im_channel_route_channel").on(table.channelId),
    chatIdx: index("idx_im_channel_route_chat").on(table.channelId, table.chatId),
  }),
);
