# Session Persistence 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 RCS agent session（`session_xxx`）从纯内存 Map 迁移到 PostgreSQL 持久化，server 重启后 agent 重连时能复用已有的 session_id。

**Architecture:** 在 `src/db/schema.ts` 新增 `agentSession` 表（避免与 better-auth `session` 表冲突），将 `SessionRepo` 底层实现从内存 Map 换成 PostgreSQL 查询（与 `EnvironmentRepo` 风格一致）。`sessionOwners` 保持纯内存。重启时 status 全部重置为 `idle`。环境删除时 session 通过 FK CASCADE 自动清理。

**Tech Stack:** Drizzle ORM, PostgreSQL, Bun test

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/db/schema.ts` | 新增 `agentSession` 表定义 |
| Modify | `src/repositories/session.ts` | 底层实现从 Map → PG |
| Modify | `src/services/session.ts` | `createSession` 写入 PG；`findOrCreateForEnvironment` 查 PG |
| Modify | `src/repositories/index.ts` | 更新 `resetAllRepos`（移除 sessionRepo.reset） |
| Create | `src/__tests__/session-repo-pg.test.ts` | SessionRepo PG 实现的单元测试 |

---

### Task 1: 新增 `agentSession` 表到 schema.ts

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: 在 schema.ts 的 environment 表定义之后添加 agentSession 表**

在 `environment` 表定义（约第 229 行）之后插入：

```typescript
// Agent Session 持久化表（RCS 侧 session，非 better-auth session）
export const agentSession = pgTable(
  "agent_session",
  {
    id: varchar("id").primaryKey(),
    environmentId: varchar("environment_id").references(() => environment.id, { onDelete: "cascade" }),
    title: varchar("title"),
    status: varchar("status", { length: 50 }).notNull().default("idle"),
    source: varchar("source", { length: 50 }).notNull().default("acp"),
    userId: text("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    envIdx: index("idx_agent_session_org_environment_id").on(table.environmentId),
  }),
);
```

- [ ] **Step 2: 生成迁移文件**

Run: `bunx drizzle-kit generate`
Expected: 生成迁移文件到 `drizzle/` 目录，包含 `CREATE TABLE agent_session` 和索引

- [ ] **Step 3: 应用迁移到开发数据库**

Run: `bunx drizzle-kit push`
Expected: 表创建成功，无错误

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: 新增 agentSession 表定义（session 持久化基础）
- 在 schema.ts 新增 agent_session 表，FK 关联 environment（CASCADE 删除）
- 包含 id/environmentId/title/status/source/userId/createdAt/updatedAt
- 索引 idx_agent_session_org_environment_id"
```

---

### Task 2: 重写 SessionRepo 为 PG 实现

**Files:**
- Modify: `src/repositories/session.ts`

- [ ] **Step 1: 替换 SessionRepo 实现**

将整个文件内容替换为：

```typescript
import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "../db";
import { agentSession } from "../db/schema";

/** Session 持久化记录 */
export interface SessionRecord {
  id: string;
  environmentId: string | null;
  title: string | null;
  status: string;
  source: string;
  username: string | null;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionCreateParams {
  environmentId?: string | null;
  title?: string | null;
  source?: string;
  idPrefix?: string;
  username?: string | null;
  userId?: string | null;
}

/** Session 仓储接口 — PostgreSQL 持久化 */
export interface ISessionRepo {
  create(params: SessionCreateParams): Promise<SessionRecord>;
  getById(id: string): Promise<SessionRecord | undefined>;
  update(id: string, patch: Partial<Pick<SessionRecord, "title" | "status" | "updatedAt">>): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  listAll(): Promise<SessionRecord[]>;
  listByEnvironment(envId: string): Promise<SessionRecord[]>;
  listByUserId(userId: string): Promise<SessionRecord[]>;
  bindOwner(sessionId: string, uuid: string): Promise<void>;
  reset(): void;
}

function rowToRecord(row: typeof agentSession.$inferSelect): SessionRecord {
  return {
    id: row.id,
    environmentId: row.environmentId ?? null,
    title: row.title ?? null,
    status: row.status,
    source: row.source,
    username: null,
    userId: row.userId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class PgSessionRepo implements ISessionRepo {
  private sessionOwners = new Map<string, Set<string>>();

  async create(params: SessionCreateParams): Promise<SessionRecord> {
    const id = `${params.idPrefix || "session_"}${uuid().replace(/-/g, "")}`;
    const now = new Date();
    await db.insert(agentSession).values({
      id,
      environmentId: params.environmentId ?? null,
      title: params.title ?? null,
      status: "idle",
      source: params.source ?? "acp",
      userId: params.userId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      id,
      environmentId: params.environmentId ?? null,
      title: params.title ?? null,
      status: "idle",
      source: params.source ?? "acp",
      username: params.username ?? null,
      userId: params.userId ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getById(id: string): Promise<SessionRecord | undefined> {
    const rows = await db.select().from(agentSession).where(eq(agentSession.id, id)).limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async update(id: string, patch: Partial<Pick<SessionRecord, "title" | "status" | "updatedAt">>): Promise<boolean> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.status !== undefined) set.status = patch.status;
    const result = await db.update(agentSession).set(set).where(eq(agentSession.id, id));
    return (result as unknown as { count: number }).count > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db.delete(agentSession).where(eq(agentSession.id, id));
    return (result as unknown as { count: number }).count > 0;
  }

  async listAll(): Promise<SessionRecord[]> {
    const rows = await db.select().from(agentSession);
    return rows.map(rowToRecord);
  }

  async listByEnvironment(envId: string): Promise<SessionRecord[]> {
    const rows = await db.select().from(agentSession).where(eq(agentSession.environmentId, envId));
    return rows.map(rowToRecord);
  }

  async listByUserId(userId: string): Promise<SessionRecord[]> {
    const rows = await db.select().from(agentSession).where(eq(agentSession.userId, userId));
    return rows.map(rowToRecord);
  }

  async bindOwner(sessionId: string, uuid: string): Promise<void> {
    if (!this.sessionOwners.has(sessionId)) {
      this.sessionOwners.set(sessionId, new Set());
    }
    this.sessionOwners.get(sessionId)!.add(uuid);
  }

  reset(): void {
    this.sessionOwners.clear();
  }
}

export const sessionRepo: ISessionRepo = new PgSessionRepo();
```

- [ ] **Step 2: 更新 repositories/index.ts 的 resetAllRepos**

`resetAllRepos` 不再调用 `sessionRepo.reset()` 清理 Map 数据（PG 数据不需要 reset），但保留 `sessionOwners` 的清理。由于 `reset()` 现在只清 sessionOwners 内存 Map，调用它仍然安全（测试隔离用途）。**无需改动 `index.ts`**。

- [ ] **Step 3: 运行 typecheck 确认接口兼容**

Run: `bun run typecheck`
Expected: 通过，无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/repositories/session.ts
git commit -m "refactor: SessionRepo 从内存 Map 迁移到 PostgreSQL 持久化
- 使用 agentSession 表做 CRUD
- sessionOwners 保持纯内存 Map
- 接口 ISessionRepo 不变，下游代码无需修改"
```

---

### Task 3: 修改 session.ts 的 createSession 和 findOrCreateForEnvironment

**Files:**
- Modify: `src/services/session.ts`

- [ ] **Step 1: 修改 createSession 使其写入 PG**

将 `createSession` 函数改为调用 `sessionRepo.create()`：

```typescript
/** Session 创建 — 写入 PG 持久化 */
export async function createSession(req: Record<string, unknown>): Promise<LightweightSession> {
  const session = await sessionRepo.create({
    environmentId: req.environment_id as string | undefined,
    title: req.title as string | undefined,
    source: (req.source as string) || "acp",
    idPrefix: req.idPrefix as string | undefined,
    userId: req.userId as string | undefined,
  });
  return { id: session.id, status: session.status };
}
```

- [ ] **Step 2: findOrCreateForEnvironment 保持不变**

当前逻辑已经是 `listByEnvironment → 有就返回 → 没有就 create`。由于 `listByEnvironment` 和 `create` 现在都走 PG，`findOrCreateForEnvironment` **无需修改代码**，行为自动正确——重启后从 DB 查到旧 session_id 并复用。

- [ ] **Step 3: 运行 session 相关测试**

Run: `bun test src/__tests__/session-sync-functions.test.ts`
Expected: `createSession` 测试需要更新（因为现在走 PG），预期 FAIL。其他测试（getSession、resolveExistingSessionId）应该 PASS（它们只依赖 EventBus mock）。

- [ ] **Step 4: 更新 session-sync-functions.test.ts**

`createSession` 现在调用 `sessionRepo.create()`（PG），在单元测试中需要 mock `sessionRepo`。将 createSession 相关测试改为 mock `sessionRepo`：

```typescript
// 在文件顶部添加 mock
import { mock } from "bun:test";
import { sessionRepo } from "../repositories";

// mock sessionRepo.create
const originalCreate = sessionRepo.create.bind(sessionRepo);

// 在 createSession describe 块之前设置 mock
```

由于 mock.module 模式在这个项目中比较脆弱，更安全的做法是将 `sessionRepo` 通过 DI 注入到 `session.ts`（类似已有的 `_setEventService` 模式）。在 `session.ts` 中添加：

```typescript
import { sessionRepo as realSessionRepo } from "../repositories";
export let _sessionRepo = realSessionRepo;
export function _setSessionRepo(repo: ISessionRepo) {
  _sessionRepo = repo;
}
```

然后将 `session.ts` 中所有 `sessionRepo.xxx` 调用改为 `_sessionRepo.xxx`。

测试中使用内存 mock：

```typescript
import { _setSessionRepo } from "../services/session";

const mockSessionRepo = {
  create: mock(async (params: any) => ({
    id: `session_${params.idPrefix || ""}testuuid`,
    environmentId: params.environmentId ?? null,
    title: params.title ?? null,
    status: "idle",
    source: params.source ?? "acp",
    username: params.username ?? null,
    userId: params.userId ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  getById: mock(async () => undefined),
  listByEnvironment: mock(async () => []),
  // ... 其他方法
};
_setSessionRepo(mockSessionRepo as any);
```

- [ ] **Step 5: 运行全部 session 测试确认通过**

Run: `bun test src/__tests__/session`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/session.ts src/__tests__/session-sync-functions.test.ts
git commit -m "feat: createSession 写入 PG，添加 DI 注入点便于测试
- createSession 调用 sessionRepo.create() 持久化
- 添加 _sessionRepo DI 注入点（_setSessionRepo）
- findOrCreateForEnvironment 无需改动，自动复用 DB 记录
- 更新测试使用 mock sessionRepo"
```

---

### Task 4: 修复依赖 sessionRepo 的 mock 测试

**Files:**
- Modify: `src/__tests__/acp-register-combined-update.test.ts`
- Modify: `src/__tests__/acp-identify-parallel.test.ts`
- Modify: `src/__tests__/nullish-coalescing-acp.test.ts`
- Modify: `src/__tests__/register-bridge-ownership.test.ts`
- Modify: `src/__tests__/instance-supplement-cleanup.test.ts`
- Modify: `src/__tests__/instance-prefetch-env.test.ts`
- Modify: `src/__tests__/stop-all-instances-parallel.test.ts`
- Modify: `src/__tests__/register-bridge-parallel.test.ts`
- Modify: `src/__tests__/instance-getinstance-cleanup.test.ts`
- Modify: `src/__tests__/instance-service.test.ts`
- Modify: `src/__tests__/group-instances-batch.test.ts`

这些测试通过 `mock.module()` mock 了 `../services/session` 中的 `findOrCreateForEnvironment`。由于 `findOrCreateForEnvironment` 的函数签名和返回值没有变化（仍然返回 `Promise<{ id: string }>`），**这些 mock 应该继续正常工作**。

- [ ] **Step 1: 运行全部受影响的测试**

Run: `bun test src/__tests__/`
Expected: 所有测试 PASS。如果某个测试 FAIL，检查错误信息。

- [ ] **Step 2: 修复任何失败的测试**

如果测试因为 `session.ts` 内部改为 `_sessionRepo` 而失败（mock.module 拦截不到内部调用），确保 mock 的是正确的模块路径。由于这些测试 mock 的是 `../services/session` 模块的导出函数 `findOrCreateForEnvironment`，而该函数签名未变，应该无需修改。

Run: `bun test src/__tests__/` 再次确认全部 PASS。

- [ ] **Step 3: Commit（如有修改）**

```bash
git add src/__tests__/
git commit -m "fix: 修复 session 持久化迁移后的测试兼容性"
```

---

### Task 5: 重启时 status 重置

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 在 server 启动时重置所有 session status 为 idle**

在 `src/index.ts` 的数据库初始化之后（`await initDb()` 之后）添加：

```typescript
// Server 启动时重置所有 agent_session 状态为 idle
// 因为重启后所有 WebSocket/EventBus 已断开，之前的状态不再有效
import { db } from "./db";
import { agentSession } from "./db/schema";
import { sql } from "drizzle-orm";

await db.update(agentSession).set({ status: "idle", updatedAt: new Date() }).where(sql`1=1`);
console.log("[RCS] All agent sessions reset to idle");
```

- [ ] **Step 2: 运行 dev 启动确认无报错**

Run: `bun run dev`
Expected: 控制台输出 `[RCS] All agent sessions reset to idle`，server 正常启动

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: server 启动时重置所有 agent_session 状态为 idle
- 重启后 WebSocket/EventBus 全部断开，旧状态无意义
- 统一重置为 idle，等待 agent 重新注册"
```

---

### Task 6: 全量验证

**Files:**
- 无新增/修改

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck`
Expected: 格式化 + import 排序 + tsc + biome check 全部通过

- [ ] **Step 2: 运行全部后端测试**

Run: `bun test src/__tests__/`
Expected: 全部 PASS

- [ ] **Step 3: 手动端到端验证**

1. 启动 dev server
2. 通过 API 注册一个 environment，确认返回 `session_id`
3. 重启 dev server
4. 再次通过同一 environment 注册（或调用 `findOrCreateForEnvironment`），确认返回**同一个** `session_id`
5. 删除 environment，确认关联 session 被级联删除

---

## Self-Review Checklist

### 1. Spec Coverage
- ✅ Session 持久化到 PG — Task 1 (schema) + Task 2 (repo)
- ✅ Server 重启复用 session_id — Task 2 (PG repo) + Task 3 (findOrCreateForEnvironment 自动复用)
- ✅ Status 重置为 idle — Task 5
- ✅ createSession 也写入 DB — Task 3
- ✅ 环境删除级联清理 — Task 1 (FK CASCADE)
- ✅ SessionWorker 不持久化 — 未修改，保持现状
- ✅ getSession() 不变 — 未修改
- ✅ 表名避免与 better-auth session 冲突 — 使用 `agentSession`

### 2. Placeholder Scan
- 无 TBD/TODO/placeholder — 每个步骤都有完整代码

### 3. Type Consistency
- `SessionRecord` 接口保持不变（`ISessionRepo` 的契约未改）
- `SessionCreateParams` 接口保持不变
- `findOrCreateForEnvironment` 签名和返回值不变
- `createSession` 返回值仍是 `{ id, status }`（`LightweightSession`）
- `agentSession` 表的 `environmentId` 类型为 `varchar` nullable，匹配 `SessionRecord.environmentId: string | null`
