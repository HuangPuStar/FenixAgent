import { user } from "@fenix/identity/db";
import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * 插件市场表的 schema 唯一真相来源。
 *
 * 领域模型沿用源项目 `open-mcp-market` 的权威设计：**一个插件 = 一个 NPM package**，稳定身份是
 * `(source_id, package_name)`；**一个插件版本 = 一个 exact version**；元数据的白名单快照在版本行上，
 * 发布后不可变。市场只读取私有 registry 的 packument 元数据并保存投影，**不下载、不解压、不扫描
 * tarball**（tarball 的完整性由 registry 持有，`metadata_json.dist` 只作溯源记录）。
 *
 * 三张表的职责：
 * - `plugin_market_package`：聚合根。身份 + latest 指针 + 授权归属列。
 * - `plugin_market_publication`：不可变快照 + 可见性水印。**唯一业务写模块是 catalog 领域服务**。
 * - `plugin_market_admin_operation`：审计流水。只追加不修改。
 *
 * `user` 是唯一的跨包外键目标：身份表归 `@fenix/identity/db`，这里只导入表对象表达级联删除，不复制
 * 定义。跨模块外键的组装期例外口径见 `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1。
 * `organization_id` 刻意不加外键——与 `mcp_server` 等四张受控资源主表保持一致，组织删除的级联由身份
 * 模块负责，资源包不重复声明。
 *
 * 不变量在存储层的承载范围（源项目用 3 条 SQLite 触发器，本包改用 Drizzle 能表达的子集 + 应用层）：
 * - 「latest 只能指向**本包**的版本」→ 复合外键，存储层强保证；
 * - 「同包同版本只能发布一次」→ 唯一索引，存储层强保证（也是 publish 幂等性的兜底）；
 * - 「`published_at >= first_published_at`」→ CHECK，存储层强保证；
 * - 「latest 必须指向**可见**版本」「被 latest 指向的版本不得隐藏」→ 应用层顺序保证
 *   （先移指针再隐藏），并由 `src/server/domain/invariants.ts` 的只读检查覆盖，供测试与运维诊断。
 * 最后两条不写成 PL/pgSQL 触发器是有意的：本仓库迁移链全部由 Drizzle 生成、禁止手写 SQL 绕过，
 * 而 Drizzle 没有触发器的一等表达；把它降为「应用层 + 可测断言」比引入一条手写迁移更可维护。
 */

/** 插件市场的聚合根：一个 NPM package 的市场身份与 latest 指针。 */
export const pluginMarketPackage = pgTable(
  "plugin_market_package",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 元数据来源标识（部署级固定，默认 `npm`）；与 `package_name` 共同构成稳定身份。 */
    sourceId: text("source_id").notNull(),
    /** NPM 包名，含 scope（如 `@scope/name`）。 */
    packageName: text("package_name").notNull(),
    /**
     * 授权归属组织。
     *
     * 市场是**平台全局目录**（所有已认证用户可读，仅平台系统管理员可写），本仓库的授权实现没有
     * 「无归属组织」的模式，因此全部条目统一归属**系统托管租户组织**（身份表里 slug = `admin` 的那个），
     * 由 Facade 在创建期解析注入——绝不接受浏览器传入。读权限由 `visibility = 'public'` 叠加
     * `publicDefaultActions` 打开，写权限落在该组织的 owner / admin 角色上。
     */
    organizationId: text("organization_id").notNull(),
    /** 创建者；`user` 是跨包外键的唯一目标。 */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * 资源可见范围：授权实现的唯一公开受众声明。
     *
     * 默认 `public` 是**本表的语义要求**而不是宽松默认：市场条目存在的意义就是被所有已认证用户看到。
     */
    visibility: varchar("visibility", { length: 20 }).notNull().default("public"),
    /** 当前 latest 版本的指针；NULL 表示该包所有版本都已下架，对非写权主体整个消失。 */
    latestPublicationId: uuid("latest_publication_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 稳定身份：同一来源下同包名只能有一条聚合根。
    uniqueIndex("idx_plugin_market_package_source_name").on(table.sourceId, table.packageName),
    // 普通索引而非唯一索引：平台全局目录下所有条目共享同一 organization_id 与 visibility，
    // 唯一索引会让第二条发布直接 23505。
    index("idx_plugin_market_package_scope").on(table.organizationId, table.visibility),
    // 复合外键让 latest 指针**只能指向本包的版本**。源项目用同款复合外键（`migrations/0001_market.sql:19-20`）。
    // 循环引用是安全的：extraConfig 回调在 getTableConfig 时才求值，不受本文件声明顺序限制；
    // 插入顺序则依赖 latest_publication_id 可空——先建包（指针为 NULL）、再写版本、最后回填指针。
    foreignKey({
      name: "plugin_market_package_latest_publication_fk",
      columns: [table.latestPublicationId, table.id],
      foreignColumns: [pluginMarketPublication.id, pluginMarketPublication.packageId],
    }),
  ],
);

/** 一次「把某个 exact version 纳入市场」的记录；快照发布后不可变。 */
export const pluginMarketPublication = pgTable(
  "plugin_market_publication",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * 所属聚合根。
     *
     * 显式标注 `(): PgColumn` 不是风格问题，而是**打断 TypeScript 的推断环**：本表与
     * `plugin_market_package` 互相引用（本表 → 聚合根的外键、聚合根 → 本表的复合外键），不标注时
     * 两张表的类型互为前提，`tsc` 会以 TS7022/TS7024 判定二者为 `any`。标注 thunk 的返回类型后，本表
     * 的类型不再依赖聚合根的类型，环从这一侧断开。运行期无任何差别（`references` 只是延迟求值）。
     */
    packageId: uuid("package_id")
      .notNull()
      .references((): PgColumn => pluginMarketPackage.id, { onDelete: "cascade" }),
    /** 精确 SemVer；与 `package_id` 共同唯一，是本表幂等性的存储层兜底。 */
    exactVersion: text("exact_version").notNull(),
    /**
     * 白名单快照（规范化后的 registry 元数据）。
     *
     * **刻意用 `text` 而不是 `jsonb`**：`metadata_digest` 是 `JSON.stringify(snapshot)` 的 SHA-256，
     * 而 jsonb 不保留键序、会丢重复键，从库里读回后重算**不可能**得到同一个值。恢复（restore）路径
     * 正是「复用存储的 digest 而不回算」，两者必须自洽。
     */
    metadataJson: text("metadata_json").notNull(),
    /** `sha256:<hex>`；预览与确认两步之间的一致性凭据。 */
    metadataDigest: text("metadata_digest").notNull(),
    /** 首次纳入市场的时刻；**永不改变**，即使中途下架再恢复。 */
    firstPublishedAt: timestamp("first_published_at", { withTimezone: true }).notNull(),
    /**
     * 逻辑时钟，不是墙钟。
     *
     * 写入前必须经 `nextMonotonicInstant` 推进：候选时刻若不大于该包已记录的最大时刻，则推进到
     * `max + 1ms`，从而保证「后发布必然后排序」。恢复一个旧版本时正是靠这个前移越过当前最新版本、
     * 重新成为 latest。排序键 `(published_at DESC, id DESC)` 与 latest 回退规则都以它为前提。
     */
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    /** 下架水印；NULL 表示可见。公开面对「已下架」与「不存在」返回同样的 404。 */
    unpublishedAt: timestamp("unpublished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 一个 exact version 只能发布一次——publish 幂等性的最后一道防线（服务层先判，这里兜底）。
    uniqueIndex("idx_plugin_market_publication_package_version").on(table.packageId, table.exactVersion),
    // 支撑聚合根上的复合外键。
    //
    // **必须是表级 UNIQUE 约束而不是唯一索引**：Postgres 要求被引用列在 `ADD CONSTRAINT ... FOREIGN KEY`
    // 执行的**那一刻**就已有唯一约束，而 drizzle-kit 把索引生成排在 FK 之后，用 `uniqueIndex` 会直接报
    // `there is no unique constraint matching given keys for referenced table`。写成表级约束后它落在
    // `CREATE TABLE` 里，时序上先于任何 FK。这也更贴近源项目 `migrations/0001_market.sql` 的
    // `UNIQUE (id, package_id)` 表约束写法。
    unique("plugin_market_publication_id_package_unique").on(table.id, table.packageId),
    // 可见性排序键：latest 回退与「最新可见版本」判定都按 (published_at DESC, id DESC) 取第一条。
    // id 参与排序是为了给同一毫秒内的平局一个确定性次序。
    index("idx_plugin_market_publication_visible").on(
      table.packageId,
      table.unpublishedAt,
      table.publishedAt.desc(),
      table.id.desc(),
    ),
    check("plugin_market_publication_published_at_check", sql`${table.publishedAt} >= ${table.firstPublishedAt}`),
  ],
);

/** 市场管理操作审计：publish / restore / unpublish 的只追加流水。 */
export const pluginMarketAdminOperation = pgTable(
  "plugin_market_admin_operation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: varchar("action", { length: 20 }).notNull(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => pluginMarketPackage.id, { onDelete: "cascade" }),
    publicationId: uuid("publication_id")
      .notNull()
      .references(() => pluginMarketPublication.id, { onDelete: "cascade" }),
    /**
     * 操作人。
     *
     * 源项目是单账户模型，审计不记操作人；本仓库是多用户系统，不记操作人的审计流水没有意义，
     * 因此这是**新增列而非新表**，不影响源项目的语义规则。
     */
    operatorUserId: text("operator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** 请求标识，用于把审计流水与日志关联起来。 */
    requestId: text("request_id"),
  },
  (table) => [
    check("plugin_market_admin_operation_action_check", sql`${table.action} in ('publish', 'restore', 'unpublish')`),
    index("idx_plugin_market_admin_operation_occurred").on(table.occurredAt.desc()),
  ],
);
