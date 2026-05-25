# Feature: 20260513_F001 - pg-migration

## 需求背景

当前后端使用 `bun:sqlite` + `drizzle-orm/bun-sqlite` 作为数据库层，存在以下局限：

- SQLite 单文件数据库，不支持并发写入，在高频操作场景下成为瓶颈
- 所有字段均为 `text` / `integer`（SQLite 无类型系统），缺乏类型约束保障
- 无正式迁移系统，依赖 `ALTER TABLE ADD COLUMN` try/catch 硬编码迁移
- 无法利用数据库原生 JSON 查询、全文搜索等高级能力

本次重构将数据库层从 SQLite 全面迁移到 PostgreSQL，**无历史数据需要迁移**，是一次干净的重写。

## 目标

- 将数据库驱动从 `bun:sqlite` 替换为 `postgres.js` + `drizzle-orm/postgres-js`
- Schema 全面使用 PostgreSQL 原生类型（uuid、timestamptz、jsonb、boolean）
- 保持启动时自动建表（`CREATE TABLE IF NOT EXISTS`）的迁移策略
- better-auth 继续通过 drizzleAdapter 自动管理其 4 张表
- 所有现有功能不受影响，测试全部通过

## 方案设计

### 架构决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 数据库 | PostgreSQL（自托管） | 用户需求，无历史包袱 |
| 驱动 | postgres.js | 轻量高性能，Drizzle 官方推荐，Bun 原生支持 |
| ORM | drizzle-orm/postgres-js | 保持现有 ORM，仅换适配器 |
| 调用模式 | **全量异步化** | postgres.js 基于 TCP 协议，所有查询必须异步，需将 store 层及上游全链路改为 async/await |
| 迁移策略 | 启动时 CREATE TABLE IF NOT EXISTS | 用户选择，简单直接 |
| Schema 类型 | 全面 PG 原生类型 | uuid 主键、timestamptz、jsonb、boolean |
| better-auth 表 | 自动建表 | 让 better-auth 管理自己的 4 张表 |
| 替换策略 | 直接替换（方案 A） | 无历史数据，一次性干净完成 |
| ID 生成策略 | 自定义表用 PG 自动 UUID，better-auth 表保持应用层 text ID | better-auth 内部控制其 4 张表的 ID 生成；自定义表切换到 PG 原生 `gen_random_uuid()` |
| 启动初始化 | 导出 `initDb()` 由入口文件 await 调用 | PG 的 initDb 是异步的，不能模块级同步调用 |

### 同步→异步改造（关键架构变更）

这是本次迁移中**影响面最广**的变更，必须在设计阶段明确。

**原因**：`bun:sqlite` 的 drizzle 适配器提供同步 API（`.all()`、`.get()`、`.run()` 直接返回结果），而 `postgres.js` 基于 TCP 协议，所有操作返回 Promise，必须 `await`。

**影响范围**：

1. **`src/store.ts`**（约 30+ 个函数）— 全部改为 `async`，返回值加 `Promise<>` 包装
   - 涉及：`storeCreateEnvironment`、`storeGetEnvironment`、`storeUpdateEnvironment`、`storeDeleteEnvironment`、`storeCreateSession`、`storeGetSession`、`storeCreateShareLink`、`storeGetShareLink`、`storeDeleteShareLink`、`storeSaveEventSnapshot`、`storeGetEventSnapshot` 等
   - 注意：`store.ts` 中纯内存 Map 操作（`sessions`、`sessionOwners`、`workItems`、`sessionWorkers`、`tokens`）不需要异步，只有涉及 `db.*` 调用的函数需要改
2. **`src/services/channel-binding.ts`**（5 个函数）— 函数签名已是 `async`，但内部需加 `await`
3. **上游调用方**（需加 `await`）：
   - `src/index.ts`（启动时 `storeLoadSessionsFromDB`、`storeListAllEnvironments`）
   - `src/transport/acp-ws-handler.ts`（注册/保活）
   - `src/transport/acp-relay-handler.ts`（`storeGetEnvironment`）
   - `src/services/instance.ts`（`storeGetEnvironment`、`storeCreateSession` 等）
   - `src/services/task.ts`、`src/services/scheduler.ts`、`src/services/session.ts`、`src/services/environment.ts`
   - `src/routes/web/*.ts`（environments、channels、config/skills、auth 等）
   - `src/routes/v2/worker.ts`（`storeGetSessionWorker`、`storeUpsertSessionWorker`）
   - `src/routes/mcp/knowledge.ts`（`storeGetEnvironmentBySecret`）
   - `src/auth/token.ts`（`storeCreateToken`、`storeGetUserByToken`）
4. **`src/db/index.ts`** — `initDb()` 改为 async，移除模块级 `initDb()` 同步调用，改为从 `src/index.ts` 启动时 `await initDb()`

**改造原则**：
- 函数中只有内存 Map 操作、无 `db.*` 调用的，保持同步（如 `storeGetSession`、`storeListSessions`、`storeReset`）
- 函数中同时有内存 Map 和 `db.*` 调用的，改为 async（如 `storeCreateSession` 同时写 Map 和 DB）
- 对于 HTTP 路由（Hono handler），本来就是 async 函数，只需在调用 store 函数时加 `await`

### Schema 类型映射

| SQLite | PostgreSQL | 适用场景 |
|--------|-----------|----------|
| `text("id").primaryKey()` | `uuid("id").primaryKey().defaultRandom()` | **自定义表主键** |
| `text("id").primaryKey()` | `text("id").primaryKey()` | **better-auth 表主键**（保持 text，由 better-auth 内部生成 ID） |
| `integer("created_at", { mode: "timestamp" })` | `timestamp("created_at", { withTimezone: true }).defaultNow()` | 时间戳字段 |
| `text("status")` | `varchar("status", { length: 50 })` | 短枚举/状态字段 |
| `text("events")` / `text("input_schema")` / `text("task_snapshot")` | `jsonb("events")` | JSON 内容（见下方"JSON 序列化变更"小节） |
| `text("description")` / 长文本 | `text("description")` | 真正的长文本 |
| `integer("enabled", { mode: "boolean" })` | `boolean("enabled").default(true)` | 布尔字段 |
| `text("user_id").references(...)` | `text("user_id").references(...)` | 外键引用 user/session 表（better-auth 表主键是 text） |
| `text("environment_id").references(...)` | `uuid("environment_id").references(...)` | 外键引用自定义表（主键是 uuid） |
| `text("mode", { enum: [...] })` | `varchar("mode", { length: 20 })` + DDL `CHECK` 约束 | 枚举字段（保留约束） |

### JSON 序列化变更

切换到 `jsonb` 后，drizzle-orm 自动处理 JSON 序列化/反序列化，以下字段需要调整代码：

| 字段 | 表 | 当前代码 | 迁移后 |
|------|-----|---------|--------|
| `capabilities` | environment | 写入 `JSON.stringify(obj)`，读取 `JSON.parse(str)` | 直接传对象/直接读对象 |
| `events` | shareEventSnapshot | 写入 string，`storeGetEventSnapshot` 返回 `string \| null` | 写入对象，返回值类型变为 `unknown \| null`，需适配下游 |
| `inputSchema` | mcpTool | 写入/读取 string | 直接传对象/直接读对象 |
| `taskSnapshot` | taskExecutionLog | 写入/读取 string | 直接传对象/直接读对象 |

**注意**：`storeGetEventSnapshot` 当前返回 `string | null`，改为 jsonb 后返回的将是一个已解析的对象。如果下游消费者期望 JSON string（如直接发送给前端），需要重新 `JSON.stringify` 或改为直接传对象。需逐一检查 `storeSaveEventSnapshot` 和 `storeGetEventSnapshot` 的调用方。

### 文件改动清单

#### 核心改动（必须修改）

1. **`src/db/schema.ts`** — 全量重写
   - `sqliteTable` → `pgTable`
   - 所有类型映射按上表执行
   - 16 张表定义全部更新（4 张 better-auth + 12 张自定义）
   - 索引定义保持，语法不变（drizzle ORM 抽象了索引语法）

2. **`src/db/index.ts`** — 连接层重写
   - 移除 `bun:sqlite` 导入和初始化
   - 改为 `postgres(DATABASE_URL)` + `drizzle(client, { schema })`
   - `initDb()` 改为 async，DDL 从 SQLite 语法改为 PG 语法
   - 移除模块级 `initDb()` 同步调用，改为导出 async 函数供 `src/index.ts` 启动时 await
   - 移除 `PRAGMA` 设置、`ALTER TABLE ADD COLUMN` try/catch、`ensureScheduledTaskSchema()` 等 hack
   - 移除 `getTableColumns()` 函数（SQLite PRAGMA 专用）
   - 移除 `sqlite` 导出，改为导出 `client`（用于 graceful shutdown）
   - 注意：`user` 和 `session` 是 PG 保留字，DDL 中必须加双引号 `"user"`、`"session"`

3. **`src/auth/better-auth.ts`** — provider 切换
   - `provider: "sqlite"` → `provider: "pg"`
   - schema 中的 4 张表已用 `pgTable` 定义（主键保持 `text`），better-auth 自动识别

4. **`src/store.ts`** — 异步化 + sqlite 引用清理 + JSON 序列化适配
   - 所有含 `db.*` 调用的函数改为 async（约 30+ 个）
   - 移除 `import { sqlite }` 引用
   - 3 处 `sqlite.query("SELECT changes() as c")` 改为用 drizzle `.run()` 返回值的 `.count` 属性
   - `capabilities` 字段移除 `JSON.parse`/`JSON.stringify`
   - `events`（shareEventSnapshot）类型适配

5. **`src/services/channel-binding.ts`** — sqlite 引用清理 + await 补充
   - 移除 `import { sqlite }` 引用
   - 1 处 `sqlite.prepare("SELECT changes() as c")` 改为 `.run()` 返回值的 `.count`
   - 内部 `db.*` 调用加 `await`

6. **`src/index.ts`** — 启动流程重构 + shutdown 扩展
   - 启动时 `await initDb()` 再启动 HTTP 服务
   - `storeLoadSessionsFromDB` 等 store 调用加 `await`
   - shutdown 逻辑增加 `await client.end()` 关闭 PG 连接池

#### 需要检查的文件（可能需要小幅修改：补充 await）

- **直接调用 store 函数的文件**（需检查并补充 await）：
  - `src/transport/acp-ws-handler.ts`
  - `src/transport/acp-relay-handler.ts`
  - `src/services/instance.ts`
  - `src/services/task.ts`、`scheduler.ts`、`session.ts`
  - `src/routes/web/*.ts`（environments、channels、config/skills、auth）
  - `src/routes/v2/worker.ts`
  - `src/routes/mcp/knowledge.ts`
  - `src/auth/token.ts`
- **使用 `sql` template tag 的原生 SQL**：检查是否有 SQLite 特有语法（基本兼容，无需大改）

#### 无需改动的文件

- **store.ts 中纯内存 Map 操作**：`storeGetSession`、`storeListSessions`、`storeBindSession`、`storeIsSessionOwner` 等不涉及 `db.*` 调用的函数保持同步
- **routes/** 中调用 service 层的代码：如果 service 层已经是 async，只需补充 await
- **transport/** WebSocket 层：不直接操作数据库，但通过 store 间接使用，需补充 await

### 连接配置

```typescript
// src/db/index.ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs";
const client = postgres(DATABASE_URL);
export const db = drizzle(client, { schema });
```

环境变量：
- `DATABASE_URL`：PG 连接串，格式 `postgres://user:pass@host:port/dbname`
- 开发环境默认 `postgres://rcs:rcs@localhost:5432/rcs`（需在 PG 中创建 `rcs` 用户和数据库，或配置 `pg_hba.conf` 为 trust 模式）
- 测试环境通过 `DATABASE_URL` 指向测试 PG 实例

### initDb() 策略

- `initDb()` 改为 async 函数，由 `src/index.ts` 在启动时 `await initDb()` 调用
- better-auth 的 4 张表（user/session/account/verification）由 better-auth 自动建表，`initDb()` 不管理
- 自定义的 12 张表继续用 `CREATE TABLE IF NOT EXISTS`，但改为 PG 语法：
  - `TEXT NOT NULL` → `UUID NOT NULL DEFAULT gen_random_uuid()`（自定义表主键）
  - `TEXT NOT NULL` → 保持 `TEXT NOT NULL`（better-auth 表主键引用，如 `user_id`）
  - `INTEGER (timestamp)` → `TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  - `INTEGER (boolean)` → `BOOLEAN NOT NULL DEFAULT TRUE/FALSE`
  - JSON 文本字段 → `JSONB`
  - `REFERENCES user(id)` → `REFERENCES "user"(id)`（双引号转义保留字）
  - `REFERENCES session(id)` → `REFERENCES "session"(id)`（双引号转义保留字）
- 移除所有历史迁移 hack（`ensureScheduledTaskSchema`、`ALTER TABLE ADD COLUMN` try/catch）
- `shareLink.mode` 字段在 DDL 中添加 `CHECK (mode IN ('readonly', 'writable'))` 约束

### 测试适配

- 当前测试大量 mock `../db` 模块，mock 策略不变，但 mock 的返回类型需匹配 pg schema
- 使用 `:memory:` 的测试改为 mock 整个 db 模块（沿用现有策略）
- 集成测试通过 `DATABASE_URL` 指向测试 PG 实例
- 已知的 mock 缓存污染问题（`middleware.test.ts` 和 `routes.test.ts`）不受影响
- store 函数改为 async 后，测试中的调用也需加 `await`

### 依赖变更

```
新增: postgres
移除: (bun:sqlite 是 Bun 内置，无需移除 package)
drizzle-orm: 已在项目中，无需变更版本
```

## 实现要点

1. **PG 保留字冲突**：`user` 和 `session` 是 PostgreSQL 保留字。在 DDL 中必须使用双引号 `"user"`、`"session"`。drizzle-orm 的 `pgTable` 会自动处理表名映射，但手写 DDL 时需注意。

2. **uuid 生成**：PG 原生支持 `gen_random_uuid()`（PG 13+），自定义表主键不再需要应用层生成 ID。但 better-auth 的 user/session/account/verification 表的 ID 生成由 better-auth 控制，保持其原有策略（text 类型，应用层生成）。

3. **timestamptz 一致性**：所有时间戳使用 `timestamptz`（带时区），应用层不需要做时区转换。PG 默认存储为 UTC。

4. **jsonb 查询能力**：`events`、`input_schema`、`task_snapshot`、`capabilities` 等字段改为 jsonb 后，未来可以直接用 PG 的 JSON 查询能力（如 `db.select().where(sql`events->>'type' = 'xxx'`)）。注意 jsonb 字段不再需要应用层 `JSON.parse`/`JSON.stringify`。

5. **连接池**：postgres.js 内置连接池管理，默认 10 个连接，自托管场景下足够。可通过 `postgres(url, { max: 20 })` 调整。

6. **initDb() 幂等性**：`CREATE TABLE IF NOT EXISTS` 保证幂等，多次启动不会报错。`CREATE INDEX IF NOT EXISTS` 同理。

7. **Graceful Shutdown**：进程退出时需调用 `await client.end()` 关闭 PG 连接池，避免连接泄漏。在 `src/index.ts` 的 shutdown handler 中添加。

8. **异步化改造**：这是本次迁移工作量最大的部分。所有含 `db.*` 调用的 store 函数改为 async，上游调用方逐层补充 await。Hono handler 本身是 async 函数，改动较轻；WebSocket handler 需注意错误处理。

9. **ID 格式变更**：自定义表的 ID 从 `env_xxx`、`share_xxx`、`snap_xxx`、`bind_xxx` 等带前缀格式变为 PG 标准 UUID（36 字符）。前端和日志中可能出现的变化需验证。`session_` 前缀的 ID 来自 `storeCreateSession`，也需要适配。

10. **`.run()` 返回值**：postgres.js 的 `Result` 对象使用 `.count` 属性表示影响行数（非 `.rowCount`）。替换 `SELECT changes()` 时注意属性名。

## 验收标准

- [ ] `src/db/schema.ts` 全部使用 `pgTable` + PG 原生类型（16 张表）
- [ ] `src/db/index.ts` 使用 postgres.js 连接，`initDb()` 为 async，由 `src/index.ts` await 调用
- [ ] `src/auth/better-auth.ts` provider 改为 `"pg"`
- [ ] 所有直接使用 `sqlite` 实例的代码已清理（store.ts、channel-binding.ts）
- [ ] 所有 `db.*` 调用的函数已改为 async，上游调用方已补充 await
- [ ] `bun run typecheck` 通过
- [ ] `bun test src/__tests__/` 全部通过
- [ ] `bun run dev` 启动正常，连接 PG 成功
- [ ] 进程关闭时 PG 连接池正确关闭
- [ ] 前端功能（登录、会话管理、配置页、任务调度）端到端验证通过
