# Feature 20260513_F001 - pg-migration: 实施计划

> 基于 `spec-design.md` 设计文档，本文档定义 SQLite -> PostgreSQL 迁移的逐步实施计划。
> 无历史数据迁移，为干净重写。

---

## 阶段总览

| 阶段 | 内容 | 预估工作量 | 依赖 |
|------|------|-----------|------|
| P0 | 依赖安装与基础设施准备 | 小 | 无 |
| P1 | Schema 全量重写 (`src/db/schema.ts`) | 中 | P0 |
| P2 | 连接层重写 (`src/db/index.ts`) | 大 | P1 |
| P3 | better-auth 适配 (`src/auth/better-auth.ts`) | 小 | P2 |
| P4 | 全链路异步化改造（store.ts + 所有调用方） | **超大** | P2 |
| P5 | 业务层适配（sqlite 引用清理、JSON 序列化、.count 替换） | 中 | P4 |
| P6 | 部署配置更新（Dockerfile, docker-compose, .env） | 小 | P2 |
| P7 | 测试适配 | 大 | P1-P6 |
| P8 | 集成验证 | 中 | P7 |

---

## P0: 依赖安装与基础设施准备

### 目标
安装 `postgres` 驱动包，确保 PG 实例可用。

### 步骤

#### P0.1 安装 postgres 依赖
- 执行 `bun add postgres`
- `postgres` (postgres.js) 是 drizzle-orm/postgres-js 的官方推荐驱动
- 无需修改 drizzle-orm 版本，当前已内置 postgres-js adapter

#### P0.2 准备 PG 实例
- 确认开发环境有可用的 PostgreSQL 13+ 实例（需要 `gen_random_uuid()` 支持）
- 创建目标数据库和用户（如 `rcs`）
- 记录连接串格式：`postgres://rcs:rcs@host:port/rcs`

#### P0.3 更新 drizzle.config.ts
- 将 `dialect: "sqlite"` 改为 `dialect: "postgresql"`
- 将 `dbCredentials.url` 改为使用 `DATABASE_URL` 环境变量
- `drizzle-kit` 已内置 PG dialect 支持，无需额外安装

```typescript
// 旧
export default defineConfig({
  dialect: "sqlite",
  dbCredentials: { url: process.env.RCS_DB_PATH || "./data/rcs.db" },
});

// 新
export default defineConfig({
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs" },
});
```

### 验证
- `bun add postgres` 成功，package.json 中出现 `"postgres"` 依赖
- PG 实例可通过 `psql` 连接

---

## P1: Schema 全量重写

### 目标
将 `src/db/schema.ts` 从 `sqliteTable` 全量替换为 `pgTable`，所有列类型改为 PG 原生类型。

### 步骤

#### P1.1 替换 import 来源
```
旧: import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
新: import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
```

#### P1.2 重写 better-auth 的 4 张表 (user, session, account, verification)

> **关键原则**: better-auth 通过 drizzleAdapter 自动管理这 4 张表的建表和 ID 生成。schema 定义中的类型必须与 better-auth 的 PG 期望一致。better-auth 内部使用 text 类型主键（由应用层生成），因此这 4 张表的主键应保持为 `text`，**不能**改为 `uuid`。外键引用这些表的字段（如 `user_id`）也应保持 `text`。

**user 表:**
| 字段 | 旧类型 | 新类型 |
|------|--------|--------|
| id | `text("id").primaryKey()` | `text("id").primaryKey()` |
| name | `text("name").notNull()` | `varchar("name").notNull()` |
| email | `text("email").notNull().unique()` | `varchar("email").notNull().unique()` |
| emailVerified | `integer("email_verified", { mode: "boolean" })` | `boolean("email_verified").notNull().default(false)` |
| image | `text("image")` | `text("image")` |
| createdAt | `integer("created_at", { mode: "timestamp" })` | `timestamp("created_at", { withTimezone: true }).notNull().defaultNow()` |
| updatedAt | `integer("updated_at", { mode: "timestamp" })` | `timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()` |

**session 表:** 类似映射，注意 `userId` 外键引用 `user.id`，类型保持 `text`。

**account 表:** 类似映射。

**verification 表:** 类似映射。

#### P1.3 重写自定义 12 张表

> **关键原则**: 自定义表的主键改为 `uuid` + `defaultRandom()`，由 PG 自动生成。所有引用自定义表的外键也改为 `uuid`。引用 better-auth 表（user/session）的外键保持 `text`。

**apiKey 表:**
| 字段 | 旧类型 | 新类型 |
|------|--------|--------|
| id | `text` | `uuid("id").primaryKey().defaultRandom()` |
| userId | `text` | `text("user_id").notNull().references(() => user.id, { onDelete: "cascade" })` |
| key | `text` | `varchar("key").notNull().unique()` |
| label | `text` | `varchar("label").notNull().default("")` |
| createdAt | `integer, { mode: "timestamp" }` | `timestamp("created_at", { withTimezone: true }).notNull().defaultNow()` |
| lastUsedAt | `integer, { mode: "timestamp" }` | `timestamp("last_used_at", { withTimezone: true })` |

**mcpTool 表:**
| 字段 | 旧类型 | 新类型 |
|------|--------|--------|
| id | `text` | `uuid("id").primaryKey().defaultRandom()` |
| serverName | `text` | `varchar("server_name").notNull()` |
| toolName | `text` | `varchar("tool_name").notNull()` |
| description | `text` | `text("description")` |
| inputSchema | `text` | `jsonb("input_schema")` |
| inspectedAt | `integer, { mode: "timestamp" }` | `timestamp("inspected_at", { withTimezone: true }).notNull().defaultNow()` |

**shareLink 表:**
| 字段 | 旧类型 | 新类型 |
|------|--------|--------|
| id | `text` | `uuid("id").primaryKey().defaultRandom()` |
| sessionId | `text` | `varchar("session_id").notNull()` |
| environmentId | `text` | `varchar("environment_id").notNull()` |
| token | `text` | `varchar("token").notNull().unique()` |
| mode | `text, { enum }` | `varchar("mode", { length: 20 }).notNull()` + DDL `CHECK (mode IN ('readonly', 'writable'))` |
| expiresAt | `integer, { mode: "timestamp" }` | `timestamp("expires_at", { withTimezone: true })` |
| createdBy | `text` | `varchar("created_by").notNull()` |
| accessCount | `integer` | `integer("access_count").notNull().default(0)` |
| lastAccessedAt | `integer, { mode: "timestamp" }` | `timestamp("last_accessed_at", { withTimezone: true })` |
| createdAt | `integer, { mode: "timestamp" }` | `timestamp("created_at", { withTimezone: true }).notNull().defaultNow()` |
| updatedAt | `integer, { mode: "timestamp" }` | `timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()` |

**shareEventSnapshot 表:**
| 字段 | 旧类型 | 新类型 |
|------|--------|--------|
| id | `text` | `uuid("id").primaryKey().defaultRandom()` |
| shareLinkId | `text` | `uuid("share_link_id").references(() => shareLink.id, { onDelete: "cascade" })` |
| events | `text` | `jsonb("events").notNull()` |
| createdAt | `integer, { mode: "timestamp" }` | `timestamp("created_at", { withTimezone: true }).notNull().defaultNow()` |

**environment 表:**
| 字段 | 旧类型 | 新类型 |
|------|--------|--------|
| id | `text` | `uuid("id").primaryKey().defaultRandom()` |
| name | `text` | `varchar("name").notNull().unique()` |
| description | `text` | `text("description")` |
| workspacePath | `text` | `varchar("workspace_path").notNull()` |
| agentName | `text` | `varchar("agent_name")` |
| status | `text` | `varchar("status", { length: 50 }).notNull().default("idle")` |
| machineName | `text` | `varchar("machine_name")` |
| branch | `text` | `varchar("branch")` |
| gitRepoUrl | `text` | `varchar("git_repo_url")` |
| maxSessions | `integer` | `integer("max_sessions").notNull().default(1)` |
| workerType | `text` | `varchar("worker_type", { length: 50 }).notNull().default("acp")` |
| capabilities | `text` | `jsonb("capabilities")` |
| secret | `text` | `varchar("secret").notNull()` |
| userId | `text` | `text("user_id").notNull().references(() => user.id, { onDelete: "cascade" })` |
| autoStart | `integer, { mode: "boolean" }` | `boolean("auto_start").notNull().default(false)` |
| lastPollAt | `integer, { mode: "timestamp" }` | `timestamp("last_poll_at", { withTimezone: true })` |
| createdAt | `integer, { mode: "timestamp" }` | `timestamp("created_at", { withTimezone: true }).notNull().defaultNow()` |
| updatedAt | `integer, { mode: "timestamp" }` | `timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()` |

**knowledgeBase 表:** 类似映射，`userId` 保持 `text`（引用 user），slug/status/name 用 `varchar`，remoteAccountId/remoteUserId 用 `varchar`，status 用 `varchar({ length: 50 })`。保留 uniqueIndex 和 index 定义。

**knowledgeResource 表:** 类似映射，`knowledgeBaseId` 改为 `uuid`（引用 knowledge_base），sourceType/sourceName 用 `varchar`。

**agentKnowledgeBinding 表:** 类似映射，`knowledgeBaseId` 改为 `uuid`（引用 knowledge_base），agentName 用 `varchar`，enabled 用 `boolean`。保留 index 和 uniqueIndex。

**scheduledTask 表:**
| 字段 | 旧类型 | 新类型 |
|------|--------|--------|
| id | `text` | `uuid("id").primaryKey().defaultRandom()` |
| userId | `text` | `text("user_id").notNull().references(() => user.id, { onDelete: "cascade" })` |
| environmentId | `text` | `uuid("environment_id").notNull().references(() => environment.id, { onDelete: "cascade" })` |
| enabled | `integer, { mode: "boolean" }` | `boolean("enabled").notNull().default(true)` |
| task | `text` | `text("task").notNull()` |
| timeoutMinutes | `integer` | `integer("timeout_minutes").notNull().default(30)` |
| lastRunAt/nextRunAt | `integer, { mode: "timestamp" }` | `timestamp(..., { withTimezone: true })` |
| cron | `text` | `varchar("cron").notNull()` |
| timezone | `text` | `varchar("timezone")` |

**taskExecutionLog 表:**
| 字段 | 旧类型 | 新类型 |
|------|--------|--------|
| id | `text` | `uuid("id").primaryKey().defaultRandom()` |
| taskId | `text` | `uuid("task_id").notNull().references(() => scheduledTask.id, { onDelete: "cascade" })` |
| duration | `integer` | `integer("duration")` |
| triggeredBy | `text` | `varchar("triggered_by").notNull().default("cron")` |
| taskSnapshot | `text` | `jsonb("task_snapshot")` |
| skipReason/resultSummary | `text` | `text(...)` |
| workspacePath | `text` | `varchar("workspace_path")` |
| workspaceName | `text` | `varchar("workspace_name")` |
| environmentId | `text` | `varchar("environment_id")` — 注意：这是快照字段，非外键，保持 varchar |
| environmentName | `text` | `varchar("environment_name")` |
| createdAt | `integer, { mode: "timestamp" }` | `timestamp("created_at", { withTimezone: true }).notNull().defaultNow()` |

> **注意**: `taskExecutionLog.environmentId` 和 `taskExecutionLog.workspacePath` 等是执行时的快照字段，不是外键引用，应使用 `varchar` 而非 `uuid`。

**channelBinding 表:**
| 字段 | 旧类型 | 新类型 |
|------|--------|--------|
| id | `text` | `uuid("id").primaryKey().defaultRandom()` |
| platform | `text` | `varchar("platform").notNull()` |
| chatId | `text` | `varchar("chat_id")` |
| agentId | `text` | `varchar("agent_id").notNull()` |
| enabled | `integer, { mode: "boolean" }` | `boolean("enabled").notNull().default(true)` |

**agentSession 表:**
| 字段 | 旧类型 | 新类型 |
|------|--------|--------|
| id | `text` | `varchar("id").primaryKey()` |
| environmentId | `text` | `uuid("environment_id").references(() => environment.id, { onDelete: "set null" })` |
| title | `text` | `varchar("title")` |
| status | `text` | `varchar("status").notNull()` |
| source | `text` | `varchar("source").notNull()` |
| permissionMode | `text` | `varchar("permission_mode")` |
| workerEpoch | `integer` | `integer("worker_epoch").notNull().default(0)` |
| username/userId/cwd | `text` | `varchar(...)` |
| shareMode | `text` | `varchar("share_mode", { length: 20 }).notNull().default("none")` |

> **注意**: `agentSession.id` 保持 `varchar` 而非 `uuid`。当前代码使用 `session_${uuid()}` 格式生成 ID，且前端/ACP 协议可能依赖此格式。如需改为 PG UUID，需额外验证前端兼容性。

### 验证
- `bun run typecheck` 无类型错误（连接层未改时可能有 import 错误，可暂忽略）
- 所有 16 张表定义使用 `pgTable`，无 `sqliteTable` 残留

---

## P2: 连接层重写

### 目标
重写 `src/db/index.ts`，将 bun:sqlite 连接替换为 postgres.js 连接，重写 `initDb()` DDL，改为 async 函数。

### 步骤

#### P2.1 替换连接层 import 和初始化

```typescript
// 旧
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

const sqlite = new Database(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA foreign_keys = ON");
export const db = drizzle(sqlite, { schema });
export { sqlite };

// 新
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs";
export const client = postgres(DATABASE_URL);
export const db = drizzle(client, { schema });
```

#### P2.2 移除不再需要的代码

删除以下内容：
1. `import { Database } from "bun:sqlite"` 和 `import { drizzle } from "drizzle-orm/bun-sqlite"`
2. `getTableColumns()` 函数 — 仅 SQLite PRAGMA 使用
3. `ensureScheduledTaskSchema()` 函数 — 历史迁移 hack
4. `mkdirSync` / `existsSync` / `dirname` 等 FS 操作 — PG 不需要文件路径
5. 所有 `PRAGMA` 设置
6. 所有 `ALTER TABLE ADD COLUMN` try/catch 块
7. `isTest` / `DB_PATH` 变量
8. 模块级 `initDb()` 同步调用 — 改为导出 async 函数

#### P2.3 重写 initDb() DDL

**关键规则:**
- `initDb()` 改为 `export async function initDb()`
- 内部 DDL 通过 `await client.unsafe(sql)` 或 `await db.execute(sql\...\)` 执行
- better-auth 的 4 张表（user, session, account, verification）**不在此管理**，由 better-auth 自动建表
- 所有表名引用中，`user` 和 `session` 是 PG 保留字，DDL 中必须加双引号：`"user"`, `"session"`
- `REFERENCES "user"(id)` — 外键引用也要加双引号
- 类型映射: `TEXT` -> `VARCHAR`/`TEXT`/`UUID`/`JSONB`/`TIMESTAMPTZ`/`BOOLEAN`

**initDb() 应管理的 12 张表（按依赖顺序）:**

1. `api_key` — 依赖 `"user"`
2. `mcp_tool` — 无依赖
3. `share_link` — 无依赖
4. `share_event_snapshot` — 依赖 `share_link`
5. `environment` — 依赖 `"user"`
6. `knowledge_base` — 依赖 `"user"`
7. `knowledge_resource` — 依赖 `knowledge_base`
8. `agent_knowledge_binding` — 依赖 `knowledge_base`
9. `scheduled_task` — 依赖 `"user"`, `environment`
10. `task_execution_log` — 依赖 `scheduled_task`
11. `channel_binding` — 无依赖
12. `agent_session` — 依赖 `environment`

**DDL 模板示例 (environment 表):**

```sql
CREATE TABLE IF NOT EXISTS environment (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR NOT NULL UNIQUE,
  description TEXT,
  workspace_path VARCHAR NOT NULL,
  agent_name VARCHAR,
  status VARCHAR(50) NOT NULL DEFAULT 'idle',
  machine_name VARCHAR,
  branch VARCHAR,
  git_repo_url VARCHAR,
  max_sessions INTEGER NOT NULL DEFAULT 1,
  worker_type VARCHAR(50) NOT NULL DEFAULT 'acp',
  capabilities JSONB,
  secret VARCHAR NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  auto_start BOOLEAN NOT NULL DEFAULT FALSE,
  last_poll_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**shareLink 表 mode 字段 CHECK 约束:**

```sql
CREATE TABLE IF NOT EXISTS share_link (
  ...
  mode VARCHAR(20) NOT NULL CHECK (mode IN ('readonly', 'writable')),
  ...
);
```

#### P2.4 索引创建

PG 的 `CREATE INDEX IF NOT EXISTS` 语法与 SQLite 一致，直接保留即可。将索引创建放在对应表创建之后。

#### P2.5 initDb() 幂等性保证

- `CREATE TABLE IF NOT EXISTS` 和 `CREATE INDEX IF NOT EXISTS` 天然幂等
- 无需任何 try/catch 或 PRAGMA 检查

#### P2.6 启动流程调整

`src/index.ts` 中在启动 HTTP 服务前调用 `await initDb()`：

```typescript
import { initDb, client } from "./db";

// 启动前初始化数据库
await initDb();

// ... 然后启动 Hono 服务
```

### 验证
- `initDb()` 执行后，`\dt` 能看到所有 16 张表（含 better-auth 4 张）
- 重复调用 `initDb()` 不报错
- `src/index.ts` 启动时成功 await initDb()

---

## P3: better-auth 适配

### 目标
将 better-auth 的 provider 从 `"sqlite"` 切换为 `"pg"`。

### 步骤

#### P3.1 修改 `src/auth/better-auth.ts`

```typescript
// 旧
database: drizzleAdapter(db, {
  provider: "sqlite",
  schema,
}),

// 新
database: drizzleAdapter(db, {
  provider: "pg",
  schema,
}),
```

#### P3.2 验证 better-auth 自动建表

better-auth 在 PG 模式下会通过 drizzle adapter 自动创建 user/session/account/verification 表。需要验证：
1. better-auth 创建的表结构是否与 schema.ts 中的定义兼容
2. 主键类型是否一致（text — better-auth 内部生成 ID）

> 如果 better-auth 自动建表与 schema 定义冲突，可考虑从 `initDb()` 的 DDL 中移除 better-auth 4 张表，完全交给 better-auth 管理。此时 schema.ts 中的 4 张表定义仅用于 drizzle ORM 的类型推导和查询构建。

### 验证
- 登录/注册流程正常工作
- session 创建和验证正常

---

## P4: 全链路异步化改造

### 目标
将所有数据库操作从同步改为异步，这是本次迁移中**工作量最大**的环节。

### 背景

`bun:sqlite` drizzle 适配器提供同步 API（`.all()`、`.get()`、`.run()` 直接返回结果），而 `postgres.js` 所有操作返回 Promise。所有 `db.*` 调用必须 `await`，导致函数签名和调用链全面变更。

### 步骤

#### P4.1 store.ts 异步化（约 30+ 个函数）

**改为 async 的函数**（含 `db.*` 调用的）：
- `storeCreateEnvironment` → `async` + `await db.insert().run()`
- `storeGetEnvironment` → `async` + `await db.select()...all()`
- `storeGetEnvironmentBySecret` → `async`
- `storeUpdateEnvironment` → `async` + `await db.update().run()`
- `storeListActiveEnvironments` → `async`
- `storeListAllEnvironments` → `async`
- `storeListEnvironmentsByUserId` → `async`
- `storeListActiveEnvironmentsByUsername` → `async`
- `storeCreateSession` → `async` + `await db.insert().run()`
- `storeUpdateSession` → `async` + `await db.update().run()`
- `storeDeleteSession` → `async` + `await db.delete().run()`
- `storeLoadSessionsFromDB` → `async` + `await db.select().all()`
- `storeCreateShareLink` → `async`
- `storeGetShareLink` → `async`
- `storeGetShareLinkByToken` → `async`
- `storeListShareLinksBySession` → `async`
- `storeDeleteShareLink` → `async`
- `storeUpdateShareLinkAccess` → `async`
- `storeRefreshSessionShareMode` → `async`
- `storeSaveEventSnapshot` → `async`
- `storeGetEventSnapshot` → `async`
- `storeDeleteEnvironment` → `async`
- `storeListAcpAgents` → `async`
- `storeListAcpAgentsByUserId` → `async`
- `storeListOnlineAcpAgents` → `async`

**保持同步的函数**（纯内存 Map 操作）：
- `storeGetSession` — 只读 `sessions` Map
- `storeListSessions` — 只读 `sessions` Map
- `storeListSessionsByEnvironment` — 只读 `sessions` Map
- `storeListSessionsByUserId` — 只读 `sessions` Map
- `storeListSessionsForAgentByCwd` — 只读 Map（内部调用同步的 `storeGetSession`）
- `storeBindSession` — 写 `sessionOwners` Map
- `storeIsSessionOwner` — 读 `sessionOwners` Map
- `storeGetSessionOwners` — 读 `sessionOwners` Map
- `storeListSessionsByOwnerUuid` — 读 Map
- `storeListSessionsByUsername` — 读 Map
- `storeCreateWorkItem` / `storeGetWorkItem` / `storeGetPendingWorkItem` / `storeUpdateWorkItem` — 纯 Map
- `storeGetSessionWorker` / `storeUpsertSessionWorker` — 纯 Map
- `storeCreateToken` / `storeGetUserByToken` — 纯 Map
- `storeReset` — 清理 Map

#### P4.2 channel-binding.ts 内部加 await

函数签名已是 `async`，只需在内部 `db.*` 调用前加 `await`：
- `listBindings` → `await db.select()...all()`
- `getBinding` → `await db.select()...get()`
- `createBinding` → `await db.insert()...run()`
- `deleteBinding` → `await db.delete()...run()`
- `updateBinding` → `await db.update()...run()` + `await getBinding(id)`
- `findBindingForMessage` → `await db.select()...all()`

#### P4.3 上游调用方补充 await

按文件逐一修改：

| 文件 | 涉及的 store 调用 | 改动 |
|------|------------------|------|
| `src/index.ts` | `storeLoadSessionsFromDB`, `storeListAllEnvironments` | 加 `await` |
| `src/transport/acp-ws-handler.ts` | `storeGetEnvironment`, `storeCreateEnvironment` 等 | 加 `await`，handler 需为 async |
| `src/transport/acp-relay-handler.ts` | `storeGetEnvironment` | 加 `await` |
| `src/services/instance.ts` | `storeGetEnvironment`, `storeCreateSession`, `storeListSessionsByEnvironment` | 加 `await` |
| `src/services/task.ts` | store 调用 | 加 `await` |
| `src/services/scheduler.ts` | store 调用 | 加 `await` |
| `src/services/session.ts` | store 调用 | 加 `await` |
| `src/routes/web/environments.ts` | store 调用 | 加 `await`（Hono handler 已是 async） |
| `src/routes/web/channels.ts` | `storeGetEnvironment` | 加 `await` |
| `src/routes/web/config/skills.ts` | `storeGetEnvironment` | 加 `await` |
| `src/routes/web/auth.ts` | `storeBindSession` | 保持同步（纯 Map 操作） |
| `src/routes/v2/worker.ts` | `storeGetSessionWorker`, `storeUpsertSessionWorker` | 保持同步（纯 Map 操作） |
| `src/routes/mcp/knowledge.ts` | `storeGetEnvironmentBySecret` | 加 `await` |
| `src/auth/token.ts` | `storeCreateToken`, `storeGetUserByToken` | 保持同步（纯 Map 操作） |

#### P4.4 WebSocket handler 错误处理

WebSocket 消息处理中的 store 调用改为 await 后，需确保 try/catch 正确包裹异步调用，避免未捕获的 Promise rejection 导致连接断开。

### 验证
- `grep -r "\.run()\|\.all()\|\.get()" src/store.ts src/services/channel-binding.ts` 确认所有 `db.*` 调用前有 `await`
- `bun run typecheck` 无类型错误
- 所有调用 store async 函数的地方都有 `await` 或 `.then()`

---

## P5: 业务层适配（sqlite 引用清理 + JSON 序列化）

### 目标
清理所有直接使用 `sqlite` 实例的代码，适配 JSON 序列化变更。

### 步骤

#### P5.1 移除 sqlite 引用，替换 changes() 调用

**store.ts（3 处）:**

```typescript
// 旧 (storeUpdateEnvironment)
db.update(environment).set(set).where(eq(environment.id, id)).run();
const changes = (sqlite.query("SELECT changes() as c").get() as { c: number }).c;
return changes > 0;

// 新
const result = await db.update(environment).set(set).where(eq(environment.id, id)).run();
return (result as any).count > 0;
```

同样处理 `storeDeleteShareLink`（第 342 行）和 `storeDeleteEnvironment`（第 487 行）。

> **注意**: postgres.js 的 `Result` 对象使用 `.count` 属性（不是 `.rowCount`）。

**channel-binding.ts（1 处）:**

```typescript
// 旧
db.delete(channelBinding).where(eq(channelBinding.id, id)).run();
const result = sqlite.prepare("SELECT changes() as c").get() as any;
return result.c > 0;

// 新
const result = await db.delete(channelBinding).where(eq(channelBinding.id, id)).run();
return (result as any).count > 0;
```

#### P5.2 清理 import

```typescript
// store.ts
// 旧: import { db, sqlite } from "./db";
// 新: import { db } from "./db";

// channel-binding.ts
// 旧: import { db, sqlite } from "../db";
// 新: import { db } from "../db";
```

#### P5.3 JSON 序列化适配

`capabilities` 字段（environment 表）：

```typescript
// 旧 (rowToRecord)
capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,

// 新
capabilities: row.capabilities,  // jsonb 自动反序列化

// 旧 (storeCreateEnvironment)
capabilities: req.capabilities ? JSON.stringify(req.capabilities) : null,

// 新
capabilities: req.capabilities ?? null,  // jsonb 自动序列化

// 旧 (storeUpdateEnvironment)
set.capabilities = patch.capabilities ? JSON.stringify(patch.capabilities) : null;

// 新
set.capabilities = patch.capabilities ?? null;
```

`events` 字段（shareEventSnapshot 表）：

```typescript
// 旧
export function storeSaveEventSnapshot(shareLinkId: string, eventsJson: string): void {
  db.insert(shareEventSnapshot).values({ ..., events: eventsJson, ... }).run();
}

export function storeGetEventSnapshot(shareLinkId: string): string | null {
  const rows = db.select({ events: shareEventSnapshot.events })...all();
  return rows.length > 0 ? rows[0].events : null;
}

// 新 — 需要明确：events 字段现在是 jsonb，存取的都是对象
export async function storeSaveEventSnapshot(shareLinkId: string, events: unknown): Promise<void> {
  await db.insert(shareEventSnapshot).values({ ..., events, ... }).run();
}

export async function storeGetEventSnapshot(shareLinkId: string): Promise<unknown | null> {
  const rows = await db.select({ events: shareEventSnapshot.events })...all();
  return rows.length > 0 ? rows[0].events : null;
}
```

> **注意**: `storeGetEventSnapshot` 的返回类型从 `string | null` 变为 `unknown | null`。下游消费者如果期望 JSON string（如直接发送给前端），需要重新 `JSON.stringify` 或改为传对象。需检查 `shareEventSnapshot.events` 的所有调用方。

`inputSchema` 字段（mcpTool 表）和 `taskSnapshot` 字段（taskExecutionLog 表）类似处理，检查所有 `JSON.parse`/`JSON.stringify` 调用。

#### P5.4 检查 `sql` template tag 使用

`src/store.ts` 和 `src/services/task.ts` 等中的 `sql` template tag 在 sqlite 和 pg 之间兼容，无需修改。

### 验证
- `grep -r "sqlite" src/ --include="*.ts"` 的结果中，除测试文件和注释外无残留
- `grep -r "JSON\\.parse\\|JSON\\.stringify" src/store.ts src/services/` 确认 jsonb 字段已清理
- 环境 CRUD 操作正常
- 分享链接操作正常
- Channel binding 操作正常

---

## P6: 部署配置更新

### 目标
更新所有部署相关配置文件以支持 PostgreSQL。

### 步骤

#### P6.1 更新 `.env.example`

```diff
- RCS_DB_PATH=./data/rcs.db
+ DATABASE_URL=postgres://rcs:rcs@localhost:5432/rcs
```

#### P6.2 更新现有 `.env`

如果 `.env` 中存在 `RCS_DB_PATH`，替换为 `DATABASE_URL`。

#### P6.3 更新 `Dockerfile`

环境变量 `RCS_DB_PATH` 改为 `DATABASE_URL=postgres://rcs:rcs@postgres:5432/rcs`。

#### P6.4 更新 `docker-compose.yml`

1. 添加 PostgreSQL 服务 (postgres:16-alpine)
2. 修改 rcs 服务依赖 postgres (service_healthy)
3. 添加 postgres-data volume
4. rcs 服务添加 `DATABASE_URL` 环境变量

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: rcs
      POSTGRES_PASSWORD: rcs
      POSTGRES_DB: rcs
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rcs"]
      interval: 5s
      timeout: 5s
      retries: 5

  rcs:
    # ...
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://rcs:rcs@postgres:5432/rcs

volumes:
  postgres-data:
```

#### P6.5 同步更新 `Dockerfile.amd64`

#### P6.6 Graceful Shutdown 添加 PG 连接池关闭

在 `src/index.ts` 的 shutdown handler 中添加：

```typescript
process.on("SIGTERM", async () => {
  // ... 现有的 WebSocket 清理、调度器清理 ...
  await client.end();  // 关闭 PG 连接池
  process.exit(0);
});
```

### 验证
- `docker-compose config` 无错误
- `docker-compose up` 能正常启动 PG 和 rcs 服务
- 进程退出时 PG 连接正确关闭

---

## P7: 测试适配

### 目标
更新所有测试文件以适配 PostgreSQL schema 和异步 API。

### 影响分析

**A 类: 直接创建 SQLite 实例的测试（需重写）:**
1. `src/__tests__/db-schema.test.ts` — 使用 `new Database(":memory:")` 和 `sqlite.exec/prepare/query`
2. `src/__tests__/channel-binding.test.ts` — 使用 `new Database(":memory:")` 创建独立测试 DB
3. `src/__tests__/task-schema.test.ts` — 直接操作 SQLite
4. `src/__tests__/agent-session-schema.test.ts` — `import { sqlite } from "../db/index"`，使用 `sqlite.query("PRAGMA ...")` 做 schema 验证

**B 类: 使用 `require("../db/index")` 获取 sqlite 的测试（需清理）:**
5. `src/__tests__/store.test.ts` — 第 550 行 `const { sqlite: rawSqlite } = require("../db/index")`

**C 类: mock `../db` 模块的测试（需检查 mock 返回值类型和 await）:**
其余 40+ 个测试文件，需要：
- mock 返回值符合新的 PG schema 类型：
  - boolean 字段: `1`/`0` → `true`/`false`
  - timestamp 字段: unix 秒数 → `Date` 对象
  - jsonb 字段: JSON 字符串 → 对象
  - uuid 字段: 格式变化（如 `env_xxx` → 标准 UUID）
- store 函数调用改为 `await`（mock 的 store 函数返回 Promise）

### 步骤

#### P7.1 重写 A 类测试文件

改为完全 mock `db` 模块，不再直接操作数据库。移除所有 `PRAGMA` 查询、SQLite DDL、`bun:sqlite` import。`agent-session-schema.test.ts` 改为验证 schema 定义（`pgTable` 列定义）而非运行时 PRAGMA 查询。

#### P7.2 清理 B 类测试的 sqlite 引用

`store.test.ts` 第 550 行的 `require("../db/index")` 获取 sqlite 的用法需移除或改为 mock。

#### P7.3 更新 C 类测试的 mock 返回值

逐一检查 mock 定义中的类型差异：
- boolean 字段: `enabled: 1` → `enabled: true`
- jsonb 字段: `inputSchema: '{"type": "object"}'` → `inputSchema: { type: "object" }`
- 外键 uuid 字段: `environmentId: "env_xxx"` → `environmentId: "550e8400-e29b-41d4-a716-446655440000"`

#### P7.4 补充 await

所有调用改为 async 的 store 函数的测试代码，需加 `await`。mock 的 store 函数需返回 Promise：

```typescript
// 旧
mock.module("../store", () => ({
  storeGetEnvironment: () => mockEnv,
}));

// 新
mock.module("../store", () => ({
  storeGetEnvironment: () => Promise.resolve(mockEnv),
}));
```

### 验证
- `bun test src/__tests__/` 全部通过
- 无 `bun:sqlite` import 残留在测试文件中
- `grep -r "sqlite" src/__tests__/ --include="*.ts"` 结果为空

---

## P8: 集成验证

### 目标
端到端验证所有功能正常工作。

### 步骤

#### P8.1 启动验证
```bash
DATABASE_URL=postgres://rcs:rcs@localhost:5432/rcs bun run dev
```

#### P8.2 类型检查
```bash
bun run typecheck
```

#### P8.3 全量测试
```bash
bun test src/__tests__/
```

#### P8.4 功能验证清单
- [ ] 用户注册/登录
- [ ] Session 管理
- [ ] Environment CRUD
- [ ] Agent Session 创建/列表/删除
- [ ] Share Link 创建/访问
- [ ] Knowledge Base CRUD
- [ ] Knowledge Resource 上传
- [ ] Agent-Knowledge Binding
- [ ] Scheduled Task CRUD
- [ ] Task 手动触发和执行日志
- [ ] Channel Binding CRUD
- [ ] MCP Tool 缓存
- [ ] API Key 认证
- [ ] 配置页面加载
- [ ] 进程 SIGTERM 后 PG 连接正确关闭

---

## 风险与注意事项

### R1: better-auth 表结构兼容性
**风险**: better-auth PG adapter 可能使用不同于 schema.ts 定义的表结构。
**缓解**: 先让 better-auth 建表，再对比实际表结构与 schema 定义。如有冲突，让 better-auth 完全管理其 4 张表，schema.ts 仅用于类型推导。

### R2: user/session PG 保留字
**风险**: DDL 中忘记加双引号导致 SQL 语法错误。
**缓解**: initDb() 中所有引用 `user` 和 `session` 表名的地方都使用双引号。编写单元测试验证 DDL 执行不报错。

### R3: PG 连接池耗尽
**风险**: 高频操作场景下默认 10 连接可能不够。
**缓解**: 通过 `postgres(url, { max: 20 })` 调整。监控连接池使用情况。

### R4: uuid 主键长度变化
**风险**: 自定义表 ID 从 `env_xxx`（36 字符带前缀）变为 PG UUID（36 字符标准格式），前端或 ACP 协议可能依赖 ID 前缀做类型判断。
**缓解**: `agentSession.id` 保持 `varchar` + 应用层生成前缀 ID。其他自定义表 ID 变为标准 UUID，前端不依赖格式。需实际验证前端代码。

### R5: 测试 mock 缓存污染
**风险**: 已知 middleware.test.ts 和 routes.test.ts 存在 mock 缓存污染。
**缓解**: 既有问题，不受 PG 迁移影响。但异步化改动可能触发新的污染问题，需要关注。

### R6: 全链路异步化遗漏
**风险**: 漏掉某个 store 函数的 async 改造或调用方的 await 补充，导致运行时 Promise 未 await 警告或逻辑错误。
**缓解**: 使用 TypeScript 类型检查捕获（async 函数返回 Promise，未 await 时类型不匹配）。实施后全局搜索 `db.*` 调用确认无遗漏。

### R7: jsonb 字段下游适配不完整
**风险**: `shareEventSnapshot.events` 改为 jsonb 后返回类型从 string 变为 object，下游消费者期望 JSON string 时出错。
**缓解**: 在 P5.3 中逐一检查每个 jsonb 字段的所有读取方，确保类型兼容。

---

## 文件改动总览

| 文件 | 改动类型 | 阶段 |
|------|---------|------|
| `package.json` | 新增 `postgres` 依赖 | P0 |
| `drizzle.config.ts` | dialect sqlite → postgresql，url → DATABASE_URL | P0 |
| `src/db/schema.ts` | 全量重写（sqliteTable → pgTable，16 张表） | P1 |
| `src/db/index.ts` | 全量重写（postgres.js 连接 + async initDb + 移除 sqlite 导出） | P2 |
| `src/auth/better-auth.ts` | provider: "sqlite" → "pg" | P3 |
| `src/store.ts` | 异步化（30+ 函数）+ 移除 sqlite 引用 + JSON 序列化适配 + .count 替换 | P4+P5 |
| `src/services/channel-binding.ts` | 内部加 await + 移除 sqlite 引用 + .count 替换 | P4+P5 |
| `src/index.ts` | await initDb() + await store 调用 + client.end() shutdown | P4+P6 |
| `src/transport/acp-ws-handler.ts` | await store 调用 | P4 |
| `src/transport/acp-relay-handler.ts` | await store 调用 | P4 |
| `src/services/instance.ts` | await store 调用 | P4 |
| `src/services/task.ts` | await store 调用 + jsonb 适配 | P4+P5 |
| `src/services/scheduler.ts` | await store 调用 | P4 |
| `src/services/session.ts` | await store 调用 | P4 |
| `src/routes/web/environments.ts` | await store 调用 | P4 |
| `src/routes/web/channels.ts` | await store 调用 | P4 |
| `src/routes/web/config/skills.ts` | await store 调用 | P4 |
| `src/routes/mcp/knowledge.ts` | await store 调用 | P4 |
| `Dockerfile` | 环境变量 RCS_DB_PATH → DATABASE_URL | P6 |
| `Dockerfile.amd64` | 同上 | P6 |
| `docker-compose.yml` | 添加 postgres 服务，修改 rcs 配置 | P6 |
| `.env.example` | 添加 DATABASE_URL，移除 RCS_DB_PATH | P6 |
| `.env` | 添加 DATABASE_URL，移除 RCS_DB_PATH | P6 |
| `src/__tests__/db-schema.test.ts` | 重写（移除 SQLite 实例） | P7 |
| `src/__tests__/channel-binding.test.ts` | 重写（移除 SQLite 实例） | P7 |
| `src/__tests__/task-schema.test.ts` | 重写（移除 SQLite 实例） | P7 |
| `src/__tests__/agent-session-schema.test.ts` | 重写（移除 sqlite PRAGMA） | P7 |
| `src/__tests__/store.test.ts` | 清理 sqlite 引用 + await 适配 | P7 |
| `src/__tests__/*.test.ts` (40+ 文件) | 检查 mock 返回值类型 + 补充 await | P7 |

---

## 实施顺序建议

1. 创建 feature 分支: `git checkout -b feature/pg-migration`
2. P0 → P1 → P2 → P3 顺序实施核心改动（schema + 连接层 + auth）
3. **P4 全链路异步化**（工作量最大，建议分批提交）：
   - 先改 store.ts 函数签名（编译错误会暴露所有调用方）
   - 再逐一修复调用方
4. P5 业务层适配（sqlite 清理 + JSON）
5. P6 部署配置
6. P7 逐个修复测试
7. P8 集成验证
8. 合并前检查: 确保 typecheck 和全量测试通过
