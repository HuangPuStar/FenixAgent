import { environment } from "@fenix/agent-runtime/db";
import { user } from "@fenix/identity/db";
import { boolean, index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Channel 模块的持久化真相来源（任务 1.7 B13，B 块的最后一批）。
 *
 * 三张表由宿主 `apps/server/src/db/schema.ts` 逐字迁入：`channel_binding`（Hermes 通道绑定，遗留表）、
 * `im_channel`（IMChannel 一等资源表，升级自 `channel_binding`）与 `im_channel_route`（IMChannel 路由规则）。
 * DDL 原样保留——迁移链由 `drizzle.config.ts` 同时声明本文件与宿主 schema，`check:schema-ddl-drift` 保证
 * 两边不会漂移。
 *
 * **`im_channel` / `im_channel_route` 目前没有任何读写方**（实测 `command grep -rn "imChannel\|im_channel"
 * packages apps/server/src --include="*.ts" --include="*.tsx"` 只命中本文件、宿主被迁走的表定义与注释）：
 * 这两张表描述的目标态（IMChannel 取代 `channel_binding`）尚未实现，包内仓储只读写 `channel_binding`。
 * 它们随本批迁入是为了保持「一张表的定义只在一个 owner 手里」这一不变量（否则宿主仍持有业务表定义），
 * 不是新增能力；本包仍不提供它们的仓储。移除条件：目标态落地或这两张表被判定废弃（归 1.8 之后的独立任务）。
 *
 * 三条跨包外键：`im_channel.user_id` → `@fenix/identity/db` 的 `user.id`（`onDelete: cascade`）、
 * `im_channel_route.environment_id` → `@fenix/agent-runtime/db` 的 `environment.id`（级联）、以及表内的
 * `im_channel_route.channel_id` → 本文件的 `imChannel.id`。`channel_binding.agent_id` 是 **varchar 无外键**
 * （历史如此，存的是 environment 标识而非 `agent_config.id`）。Drizzle 的 `.references()` 只接受列对象、
 * 没有字符串形式，所以前两条列对象来源是本文件对 `@fenix/identity` / `@fenix/agent-runtime` 的唯一耦合。
 *
 * 这两条导入是**迁移链层面**的列对象来源，不是运行期耦合：包内 `src/**` 对宿主已零内部导入，装配依赖校验
 * （`scripts/generate-module-registry.ts` 的 `assertDependsOnComplete`）只扫 `src/**` 的值导入，因此本文件
 * 不进 `dependsOn`；`package.json` 的 `dependencies` 则必须声明 `@fenix/identity` 与 `@fenix/agent-runtime`
 * （后者因 web 侧消费早已声明），否则命中 `undeclared-workspace-dependency`。
 *
 * 读写只在本包仓储：`src/server/repositories/channel-binding.ts` 经出口 `@fenix/resource-channel/db` 取用
 * `channelBinding`——**自我引用**而非相对路径，`db/` 不在本包 `tsconfig.json` 的 `include` 里（本包没有该
 * 文件，解析口径本来就只有包 `exports` 一条），与外部消费方走同一条路径。
 */
// Hermes 通道绑定表（遗留，保留兼容）
export const channelBinding = pgTable(
  "channel_binding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: varchar("platform").notNull(),
    chatId: varchar("chat_id"),
    agentId: varchar("agent_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    platformIdx: index("idx_channel_binding_platform").on(table.platform),
    agentIdx: index("idx_channel_binding_agent_id").on(table.agentId),
  }),
);

// IMChannel 一等资源表（升级自 channel_binding）
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
