# Service 层直访 db 消除 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 9 个直接 `import { db }` 的 Service 文件创建对应的 Repository 层，使所有数据库访问通过 Repository 接口进行。遵循 ADR-0001 "Repository 接口统一为异步，即使底层是内存 Map 也包装为 Promise"。

**Architecture:** 按领域创建 Repository 接口和实现。每个 Repository 对应一张或几张密切关联的表。Repository 文件放在 `src/repositories/` 目录，通过 Elysia `.decorate()` 注入。Service 层改为调用 Repository 接口而非直接使用 `db`。

**Tech Stack:** TypeScript、Drizzle ORM、PostgreSQL

---

## 受影响文件总览

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/repositories/task.ts` | 新建 | ScheduledTask + TaskExecutionLog Repository |
| `src/repositories/knowledge-base.ts` | 新建 | KnowledgeBase + KnowledgeResource Repository |
| `src/repositories/agent-knowledge-binding.ts` | 新建 | AgentKnowledgeBinding Repository |
| `src/repositories/channel-binding.ts` | 新建 | ChannelBinding Repository |
| `src/repositories/config-provider.ts` | 新建 | Provider Repository（从 config-pg.ts 提取） |
| `src/repositories/config-model.ts` | 新建 | Model Repository |
| `src/repositories/config-agent-config.ts` | 新建 | AgentConfig Repository |
| `src/repositories/config-mcp-server.ts` | 新建 | McpServer Repository |
| `src/repositories/config-skill.ts` | 新建 | Skill Repository |
| `src/repositories/config-user-config.ts` | 新建 | UserConfig Repository |
| `src/repositories/index.ts` | 修改 | 导出新建 Repository |
| `src/plugins/repositories.ts` | 修改 | 注册新建 Repository |
| `src/services/task.ts` | 修改 | 改用 TaskRepo |
| `src/services/scheduler.ts` | 修改 | 改用 TaskRepo |
| `src/services/knowledge-base.ts` | 修改 | 改用 KnowledgeBaseRepo |
| `src/services/knowledge-upload.ts` | 修改 | 改用 KnowledgeBaseRepo |
| `src/services/knowledge-runtime.ts` | 修改 | 改用 KnowledgeBaseRepo + AgentKnowledgeBindingRepo |
| `src/services/agent-knowledge.ts` | 修改 | 改用 AgentKnowledgeBindingRepo |
| `src/services/agent-task-runner.ts` | 修改 | 改用 EnvironmentRepo |
| `src/services/channel-binding.ts` | 修改 | 改用 ChannelBindingRepo |
| `src/services/config/` (6 文件) | 修改 | 改用对应 Config Repository |

**重要**：本计划与 `2026-05-16-config-pg-split.md` 有依赖关系。Config 相关的 Repository（Provider、Model 等）应在 config-pg 拆分完成后再创建，因为拆分后每个子域文件的数据访问模式更清晰。

**推荐执行顺序**：先完成 Task 1-5（非 Config 领域），再执行 `config-pg-split` 计划，最后完成 Task 6-7（Config 领域）。

---

### Task 1: Task Repository — 消除 task.ts 和 scheduler.ts 的 db 直访

**Files:**
- Create: `src/repositories/task.ts`
- Modify: `src/repositories/index.ts`
- Modify: `src/plugins/repositories.ts`
- Modify: `src/services/task.ts`
- Modify: `src/services/scheduler.ts`

当前 `task.ts` 操作 `scheduledTask` 和 `taskExecutionLog` 两张表，`scheduler.ts` 操作 `scheduledTask`。

- [ ] **Step 1: 创建 Task Repository 接口和实现**

创建 `src/repositories/task.ts`：

```typescript
import { db } from "../db";
import { scheduledTask, taskExecutionLog } from "../db/schema";
import { eq, and, desc } from "drizzle-orm";

// ────────────────────────────────────────────
// ScheduledTask Repository
// ────────────────────────────────────────────

export interface IScheduledTaskRepo {
  listByUser(userId: string): Promise<typeof scheduledTask.$inferSelect[]>;
  getById(taskId: string): Promise<typeof scheduledTask.$inferSelect | null>;
  create(data: typeof scheduledTask.$inferInsert): Promise<typeof scheduledTask.$inferSelect>;
  update(taskId: string, data: Partial<typeof scheduledTask.$inferInsert>): Promise<void>;
  delete(taskId: string): Promise<boolean>;
  listEnabled(): Promise<typeof scheduledTask.$inferSelect[]>;
}

export class PgScheduledTaskRepo implements IScheduledTaskRepo {
  async listByUser(userId: string) {
    return db.select().from(scheduledTask)
      .where(eq(scheduledTask.userId, userId))
      .orderBy(desc(scheduledTask.createdAt));
  }

  async getById(taskId: string) {
    const rows = await db.select().from(scheduledTask)
      .where(eq(scheduledTask.id, taskId))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: typeof scheduledTask.$inferInsert) {
    const [row] = await db.insert(scheduledTask).values(data).returning();
    return row;
  }

  async update(taskId: string, data: Partial<typeof scheduledTask.$inferInsert>) {
    await db.update(scheduledTask).set(data).where(eq(scheduledTask.id, taskId));
  }

  async delete(taskId: string): Promise<boolean> {
    const result = await db.delete(scheduledTask)
      .where(eq(scheduledTask.id, taskId))
      .returning({ id: scheduledTask.id });
    return result.length > 0;
  }

  async listEnabled() {
    return db.select().from(scheduledTask)
      .where(eq(scheduledTask.enabled, true));
  }
}

// ────────────────────────────────────────────
// TaskExecutionLog Repository
// ────────────────────────────────────────────

export interface ITaskExecutionLogRepo {
  listByTask(taskId: string): Promise<typeof taskExecutionLog.$inferSelect[]>;
  getLatest(taskId: string): Promise<typeof taskExecutionLog.$inferSelect | null>;
  create(data: typeof taskExecutionLog.$inferInsert): Promise<typeof taskExecutionLog.$inferSelect>;
  update(logId: string, data: Partial<typeof taskExecutionLog.$inferInsert>): Promise<void>;
}

export class PgTaskExecutionLogRepo implements ITaskExecutionLogRepo {
  async listByTask(taskId: string) {
    return db.select().from(taskExecutionLog)
      .where(eq(taskExecutionLog.taskId, taskId))
      .orderBy(desc(taskExecutionLog.startedAt));
  }

  async getLatest(taskId: string) {
    const rows = await db.select().from(taskExecutionLog)
      .where(eq(taskExecutionLog.taskId, taskId))
      .orderBy(desc(taskExecutionLog.startedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: typeof taskExecutionLog.$inferInsert) {
    const [row] = await db.insert(taskExecutionLog).values(data).returning();
    return row;
  }

  async update(logId: string, data: Partial<typeof taskExecutionLog.$inferInsert>) {
    await db.update(taskExecutionLog).set(data).where(eq(taskExecutionLog.id, logId));
  }
}

export const scheduledTaskRepo = new PgScheduledTaskRepo();
export const taskExecutionLogRepo = new PgTaskExecutionLogRepo();
```

- [ ] **Step 2: 在 repositories/index.ts 中导出新 Repository**

在 `src/repositories/index.ts` 中添加：

```typescript
export { scheduledTaskRepo, taskExecutionLogRepo } from "./task";
```

- [ ] **Step 3: 在 plugins/repositories.ts 中注册**

在 `src/plugins/repositories.ts` 中添加：

```typescript
import { scheduledTaskRepo, taskExecutionLogRepo } from "../repositories/task";

export const repoPlugin = new Elysia({ name: "repositories" }).decorate({
  // ... 已有的 repository
  scheduledTaskRepo,
  taskExecutionLogRepo,
});
```

- [ ] **Step 4: 改写 task.ts 使用 Repository**

将 `src/services/task.ts` 中所有 `db.select().from(scheduledTask)` 替换为 `scheduledTaskRepo.listByUser()` 等，所有 `db.select().from(taskExecutionLog)` 替换为 `taskExecutionLogRepo.*()`。移除 `import { db } from "../db"` 和相关的 schema 导入。

具体映射：

| 原 db 调用 | 替换为 |
|-----------|--------|
| `db.select().from(scheduledTask).where(eq(scheduledTask.userId, userId))` | `scheduledTaskRepo.listByUser(userId)` |
| `db.select().from(scheduledTask).where(eq(scheduledTask.id, id)).limit(1)` | `scheduledTaskRepo.getById(id)` |
| `db.insert(scheduledTask).values(...)` | `scheduledTaskRepo.create(...)` |
| `db.update(scheduledTask).set(...).where(...)` | `scheduledTaskRepo.update(id, data)` |
| `db.delete(scheduledTask).where(...)` | `scheduledTaskRepo.delete(id)` |
| `db.select().from(taskExecutionLog).where(...)` | `taskExecutionLogRepo.listByTask(taskId)` |
| `db.insert(taskExecutionLog).values(...)` | `taskExecutionLogRepo.create(...)` |
| `db.update(taskExecutionLog).set(...)` | `taskExecutionLogRepo.update(logId, data)` |

- [ ] **Step 5: 改写 scheduler.ts 使用 Repository**

将 `src/services/scheduler.ts` 中 `db.select().from(scheduledTask)` 替换为 `scheduledTaskRepo.listEnabled()`，`db.update(scheduledTask)` 替换为 `scheduledTaskRepo.update()`。移除 `import { db } from "../db"`。

- [ ] **Step 6: 运行测试**

Run: `bun test src/__tests__/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/repositories/task.ts src/repositories/index.ts src/plugins/repositories.ts src/services/task.ts src/services/scheduler.ts
git commit -m "refactor: 创建 Task Repository，task.ts 和 scheduler.ts 消除 db 直访"
```

---

### Task 2: Knowledge Base Repository — 消除 knowledge-*.ts 的 db 直访

**Files:**
- Create: `src/repositories/knowledge-base.ts`
- Modify: `src/repositories/index.ts`
- Modify: `src/plugins/repositories.ts`
- Modify: `src/services/knowledge-base.ts`
- Modify: `src/services/knowledge-upload.ts`
- Modify: `src/services/knowledge-runtime.ts`

当前三个 knowledge 服务文件操作 `knowledgeBase`、`knowledgeResource`、`agentKnowledgeBinding` 三张表。

- [ ] **Step 1: 创建 Knowledge Base Repository**

创建 `src/repositories/knowledge-base.ts`：

```typescript
import { db } from "../db";
import { knowledgeBase, knowledgeResource, agentKnowledgeBinding } from "../db/schema";
import { eq, and, sql, count } from "drizzle-orm";

// ────────────────────────────────────────────
// KnowledgeBase Repository
// ────────────────────────────────────────────

export interface IKnowledgeBaseRepo {
  listByUser(userId: string): Promise<typeof knowledgeBase.$inferSelect[]>;
  getById(kbId: string): Promise<typeof knowledgeBase.$inferSelect | null>;
  getBySlug(userId: string, slug: string): Promise<typeof knowledgeBase.$inferSelect | null>;
  create(data: typeof knowledgeBase.$inferInsert): Promise<typeof knowledgeBase.$inferSelect>;
  update(kbId: string, data: Partial<typeof knowledgeBase.$inferInsert>): Promise<void>;
  delete(kbId: string): Promise<boolean>;
  touchUpdatedAt(kbId: string): Promise<void>;
}

export class PgKnowledgeBaseRepo implements IKnowledgeBaseRepo {
  async listByUser(userId: string) {
    return db.select().from(knowledgeBase)
      .where(eq(knowledgeBase.userId, userId));
  }

  async getById(kbId: string) {
    const rows = await db.select().from(knowledgeBase)
      .where(eq(knowledgeBase.id, kbId))
      .limit(1);
    return rows[0] ?? null;
  }

  async getBySlug(userId: string, slug: string) {
    const rows = await db.select().from(knowledgeBase)
      .where(and(eq(knowledgeBase.userId, userId), eq(knowledgeBase.slug, slug)))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: typeof knowledgeBase.$inferInsert) {
    const [row] = await db.insert(knowledgeBase).values(data).returning();
    return row;
  }

  async update(kbId: string, data: Partial<typeof knowledgeBase.$inferInsert>) {
    await db.update(knowledgeBase).set(data).where(eq(knowledgeBase.id, kbId));
  }

  async delete(kbId: string): Promise<boolean> {
    const result = await db.delete(knowledgeBase)
      .where(eq(knowledgeBase.id, kbId))
      .returning({ id: knowledgeBase.id });
    return result.length > 0;
  }

  async touchUpdatedAt(kbId: string) {
    await db.update(knowledgeBase)
      .set({ updatedAt: new Date() })
      .where(eq(knowledgeBase.id, kbId));
  }
}

// ────────────────────────────────────────────
// KnowledgeResource Repository
// ────────────────────────────────────────────

export interface IKnowledgeResourceRepo {
  listByKnowledgeBase(kbId: string): Promise<typeof knowledgeResource.$inferSelect[]>;
  getById(resourceId: string): Promise<typeof knowledgeResource.$inferSelect | null>;
  create(data: typeof knowledgeResource.$inferInsert): Promise<typeof knowledgeResource.$inferSelect>;
  update(resourceId: string, data: Partial<typeof knowledgeResource.$inferInsert>): Promise<void>;
  delete(resourceId: string): Promise<boolean>;
  listPendingDelete(kbId: string): Promise<typeof knowledgeResource.$inferSelect[]>;
  batchUpdateStatus(kbId: string, status: string, newStatus: string): Promise<void>;
}

export class PgKnowledgeResourceRepo implements IKnowledgeResourceRepo {
  async listByKnowledgeBase(kbId: string) {
    return db.select().from(knowledgeResource)
      .where(eq(knowledgeResource.knowledgeBaseId, kbId));
  }

  async getById(resourceId: string) {
    const rows = await db.select().from(knowledgeResource)
      .where(eq(knowledgeResource.id, resourceId))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: typeof knowledgeResource.$inferInsert) {
    const [row] = await db.insert(knowledgeResource).values(data).returning();
    return row;
  }

  async update(resourceId: string, data: Partial<typeof knowledgeResource.$inferInsert>) {
    await db.update(knowledgeResource).set(data).where(eq(knowledgeResource.id, resourceId));
  }

  async delete(resourceId: string): Promise<boolean> {
    const result = await db.delete(knowledgeResource)
      .where(eq(knowledgeResource.id, resourceId))
      .returning({ id: knowledgeResource.id });
    return result.length > 0;
  }

  async listPendingDelete(kbId: string) {
    return db.select().from(knowledgeResource)
      .where(and(
        eq(knowledgeResource.knowledgeBaseId, kbId),
        eq(knowledgeResource.status, "pending_delete"),
      ));
  }

  async batchUpdateStatus(kbId: string, status: string, newStatus: string) {
    await db.update(knowledgeResource)
      .set({ status: newStatus })
      .where(and(
        eq(knowledgeResource.knowledgeBaseId, kbId),
        eq(knowledgeResource.status, status),
      ));
  }
}

// ────────────────────────────────────────────
// AgentKnowledgeBinding Repository
// ────────────────────────────────────────────

export interface IAgentKnowledgeBindingRepo {
  listByAgentConfig(agentConfigId: string): Promise<typeof agentKnowledgeBinding.$inferSelect[]>;
  countByKnowledgeBase(kbId: string): Promise<number>;
  deleteByAgentConfig(agentConfigId: string): Promise<void>;
  deleteByKnowledgeBase(kbId: string): Promise<void>;
  batchCreate(bindings: typeof agentKnowledgeBinding.$inferInsert[]): Promise<void>;
  verifyOwnership(kbId: string, userId: string): Promise<boolean>;
}

export class PgAgentKnowledgeBindingRepo implements IAgentKnowledgeBindingRepo {
  async listByAgentConfig(agentConfigId: string) {
    return db.select().from(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.agentConfigId, agentConfigId));
  }

  async countByKnowledgeBase(kbId: string): Promise<number> {
    const rows = await db.select({ cnt: count() })
      .from(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.knowledgeBaseId, kbId));
    return rows[0]?.cnt ?? 0;
  }

  async deleteByAgentConfig(agentConfigId: string) {
    await db.delete(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.agentConfigId, agentConfigId));
  }

  async deleteByKnowledgeBase(kbId: string) {
    await db.delete(agentKnowledgeBinding)
      .where(eq(agentKnowledgeBinding.knowledgeBaseId, kbId));
  }

  async batchCreate(bindings: typeof agentKnowledgeBinding.$inferInsert[]) {
    await db.insert(agentKnowledgeBinding).values(bindings);
  }

  async verifyOwnership(kbId: string, userId: string): Promise<boolean> {
    const rows = await db.select({ id: knowledgeBase.id })
      .from(knowledgeBase)
      .where(and(eq(knowledgeBase.id, kbId), eq(knowledgeBase.userId, userId)))
      .limit(1);
    return rows.length > 0;
  }
}

export const knowledgeBaseRepo = new PgKnowledgeBaseRepo();
export const knowledgeResourceRepo = new PgKnowledgeResourceRepo();
export const agentKnowledgeBindingRepo = new PgAgentKnowledgeBindingRepo();
```

- [ ] **Step 2: 更新 repositories/index.ts 和 plugins/repositories.ts**

在 `src/repositories/index.ts` 中添加导出。在 `src/plugins/repositories.ts` 中注册。

- [ ] **Step 3: 改写 knowledge-base.ts 使用 Repository**

将 `src/services/knowledge-base.ts` 中所有 `db.` 调用替换为对应的 Repository 方法调用。移除 `import { db } from "../db"` 和相关的 schema 导入。

- [ ] **Step 4: 改写 knowledge-upload.ts 使用 Repository**

将 `src/services/knowledge-upload.ts` 中所有 `db.` 调用替换为对应的 Repository 方法调用。移除 `import { db } from "../db"`。

- [ ] **Step 5: 改写 knowledge-runtime.ts 使用 Repository**

将 `src/services/knowledge-runtime.ts` 中所有 `db.` 调用替换为对应的 Repository 方法调用。移除 `import { db } from "../db"`。

- [ ] **Step 6: 运行测试**

Run: `bun test src/__tests__/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/repositories/knowledge-base.ts src/repositories/index.ts src/plugins/repositories.ts src/services/knowledge-base.ts src/services/knowledge-upload.ts src/services/knowledge-runtime.ts
git commit -m "refactor: 创建 Knowledge Repository，knowledge-* 服务消除 db 直访"
```

---

### Task 3: Agent Knowledge Binding Repository — 消除 agent-knowledge.ts 的 db 直访

**Files:**
- Modify: `src/services/agent-knowledge.ts`

agent-knowledge.ts 操作的表已在 Task 2 的 Repository 中定义（`agentKnowledgeBindingRepo`）。

- [ ] **Step 1: 改写 agent-knowledge.ts 使用 Repository**

将 `src/services/agent-knowledge.ts` 中所有 `db.` 调用替换为 `agentKnowledgeBindingRepo` 和 `knowledgeBaseRepo` 方法调用。移除 `import { db } from "../db"`。

- [ ] **Step 2: 运行测试**

Run: `bun test src/__tests__/`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/agent-knowledge.ts
git commit -m "refactor: agent-knowledge.ts 消除 db 直访，通过 AgentKnowledgeBindingRepo 代理"
```

---

### Task 4: Channel Binding Repository — 消除 channel-binding.ts 的 db 直访

**Files:**
- Create: `src/repositories/channel-binding.ts`
- Modify: `src/repositories/index.ts`
- Modify: `src/plugins/repositories.ts`
- Modify: `src/services/channel-binding.ts`

- [ ] **Step 1: 创建 Channel Binding Repository**

创建 `src/repositories/channel-binding.ts`：

```typescript
import { db } from "../db";
import { channelBinding } from "../db/schema";
import { eq, and } from "drizzle-orm";

export interface IChannelBindingRepo {
  list(): Promise<typeof channelBinding.$inferSelect[]>;
  getById(bindingId: string): Promise<typeof channelBinding.$inferSelect | null>;
  create(data: typeof channelBinding.$inferInsert): Promise<typeof channelBinding.$inferSelect>;
  delete(bindingId: string): Promise<boolean>;
  findByChannelAndAgent(channelId: string, agentId: string): Promise<typeof channelBinding.$inferSelect | null>;
  update(bindingId: string, data: Partial<typeof channelBinding.$inferInsert>): Promise<void>;
}

export class PgChannelBindingRepo implements IChannelBindingRepo {
  async list() {
    return db.select().from(channelBinding);
  }

  async getById(bindingId: string) {
    const rows = await db.select().from(channelBinding)
      .where(eq(channelBinding.id, bindingId))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: typeof channelBinding.$inferInsert) {
    const [row] = await db.insert(channelBinding).values(data).returning();
    return row;
  }

  async delete(bindingId: string): Promise<boolean> {
    const result = await db.delete(channelBinding)
      .where(eq(channelBinding.id, bindingId))
      .returning({ id: channelBinding.id });
    return result.length > 0;
  }

  async findByChannelAndAgent(channelId: string, agentId: string) {
    const rows = await db.select().from(channelBinding)
      .where(and(
        eq(channelBinding.channelId, channelId),
        eq(channelBinding.agentId, agentId),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  async update(bindingId: string, data: Partial<typeof channelBinding.$inferInsert>) {
    await db.update(channelBinding).set(data).where(eq(channelBinding.id, bindingId));
  }
}

export const channelBindingRepo = new PgChannelBindingRepo();
```

- [ ] **Step 2: 更新 repositories/index.ts 和 plugins/repositories.ts**

- [ ] **Step 3: 改写 channel-binding.ts 使用 Repository**

- [ ] **Step 4: 运行测试**

Run: `bun test src/__tests__/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/repositories/channel-binding.ts src/repositories/index.ts src/plugins/repositories.ts src/services/channel-binding.ts
git commit -m "refactor: 创建 ChannelBinding Repository，channel-binding.ts 消除 db 直访"
```

---

### Task 5: agent-task-runner.ts — 消除 db 直访

**Files:**
- Modify: `src/services/agent-task-runner.ts`

`agent-task-runner.ts` 第 52 行仅有一处 `db.select().from(environment)` 查询，可通过已有的 `environmentRepo.getById()` 替代。

- [ ] **Step 1: 改写 agent-task-runner.ts**

将 `import { db } from "../db"` 和 `import { environment } from "../db/schema"` 移除，改为 `import { environmentRepo } from "../repositories"`。将 `db.select().from(environment).where(eq(environment.id, agentId))` 替换为 `environmentRepo.getById(agentId)`。

- [ ] **Step 2: 运行测试**

Run: `bun test src/__tests__/`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/agent-task-runner.ts
git commit -m "refactor: agent-task-runner.ts 消除 db 直访，通过 environmentRepo 代理"
```

---

### Task 6: Config 子域 Repository — 消除 config/ 文件的 db 直访

**Files:**
- Create: `src/repositories/config-provider.ts`
- Create: `src/repositories/config-model.ts`
- Create: `src/repositories/config-agent-config.ts`
- Create: `src/repositories/config-mcp-server.ts`
- Create: `src/repositories/config-skill.ts`
- Create: `src/repositories/config-user-config.ts`
- Modify: `src/repositories/index.ts`
- Modify: `src/plugins/repositories.ts`
- Modify: `src/services/config/provider.ts`
- Modify: `src/services/config/model.ts`
- Modify: `src/services/config/agent-config.ts`
- Modify: `src/services/config/mcp-server.ts`
- Modify: `src/services/config/skill.ts`
- Modify: `src/services/config/user-config.ts`
- Modify: `src/services/config/aggregate.ts`

**注意**：此 Task 应在 `2026-05-16-config-pg-split.md` 计划完成后执行。那时 config 子域文件已在 `src/services/config/` 中，每个文件直接使用 `db`。

- [ ] **Step 1: 为每个 Config 子域创建 Repository**

每个 Repository 遵循相同的模式：定义 `I*Repo` 接口 + `Pg*Repo` 实现，封装该子域的全部 Drizzle 查询。

以 Provider 为例（`src/repositories/config-provider.ts`）：

```typescript
import { db } from "../db";
import { provider, model } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";

export interface IProviderRepo {
  listByUser(userId: string): Promise<typeof provider.$inferSelect[]>;
  getByName(userId: string, name: string): Promise<(typeof provider.$inferSelect & { models: typeof model.$inferSelect[] }) | null>;
  upsert(userId: string, name: string, data: { displayName?: string; npm?: string; baseUrl?: string; apiKey?: string; extraOptions?: Record<string, unknown> }): Promise<string>;
  deleteByName(userId: string, name: string): Promise<boolean>;
  listAllByUser(userId: string): Promise<typeof provider.$inferSelect[]>;
}

export class PgProviderRepo implements IProviderRepo {
  // ... 实现同 config-pg.ts 中的 Provider 操作
}

export const providerRepo = new PgProviderRepo();
```

其他 5 个 Config Repository 按相同模式创建，每个对应一个 `config/` 子域文件中的全部 `db.` 调用。

- [ ] **Step 2: 更新 repositories/index.ts 和 plugins/repositories.ts**

- [ ] **Step 3: 改写每个 config/ 子域文件使用对应 Repository**

将 `src/services/config/provider.ts` 中的 `db.select()`、`db.insert()`、`db.update()`、`db.delete()` 全部替换为 `providerRepo` 方法调用。移除 `import { db } from "../../db"` 和 schema 导入。

其余 5 个子域文件同理。

- [ ] **Step 4: 改写 aggregate.ts**

`src/services/config/aggregate.ts` 的 `getAgentFullConfig()` 横跨多个表。改为调用各子域 Repository：

```typescript
import { providerRepo } from "../../repositories/config-provider";
import { agentConfigRepo } from "../../repositories/config-agent-config";
import { configSkillRepo } from "../../repositories/config-skill";
import { mcpServerRepo } from "../../repositories/config-mcp-server";
```

注意：如果 `getAgentFullConfig` 中的并行查询（Promise.all）需要高效执行，可以在 aggregate 层保留一个 `db` 调用作为性能优化，并在注释中说明原因。但首选方案是通过各 Repo 的 list 方法并行调用。

- [ ] **Step 5: 运行测试**

Run: `bun test src/__tests__/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/repositories/config-*.ts src/repositories/index.ts src/plugins/repositories.ts src/services/config/*.ts
git commit -m "refactor: 创建 Config 子域 Repository，config/ 服务消除 db 直访"
```

---

### Task 7: 最终验证 — 确认零 db 直访

- [ ] **Step 1: 搜索确认 services 目录无 db 直访**

Run: `grep -rn "from.*\"../db\"" src/services/`
Expected: 零匹配（所有 Service 都通过 Repository 访问数据库）

- [ ] **Step 2: 搜索确认只有 repositories 目录直接使用 db**

Run: `grep -rn "from.*\"../db\"" src/ | grep -v "src/repositories/"`
Expected: 只剩 `src/db/schema.ts`（schema 定义文件本身不需要 Repository）、`src/auth/better-auth.ts`（第三方库初始化）

- [ ] **Step 3: 运行全量测试和类型检查**

Run: `bun run typecheck && bun test src/__tests__/`
Expected: 零错误，全部 PASS

- [ ] **Step 4: 确认 Repository 数量完整**

Run: `ls -la src/repositories/*.ts`
Expected: 包含以下文件：
- `environment.ts`（已有）
- `session.ts`（已有）
- `session-worker.ts`（已有）
- `share-link.ts`（已有）
- `token.ts`（已有）
- `work-item.ts`（已有）
- `index.ts`（已有）
- `task.ts`（新增）
- `knowledge-base.ts`（新增）
- `channel-binding.ts`（新增）
- `config-provider.ts`（新增）
- `config-model.ts`（新增）
- `config-agent-config.ts`（新增）
- `config-mcp-server.ts`（新增）
- `config-skill.ts`（新增）
- `config-user-config.ts`（新增）

---

## 与其他计划的依赖关系

| 本计划 Task | 依赖的计划/Task |
|-------------|----------------|
| Task 1-5 | 无依赖，可独立执行 |
| Task 6 | 依赖 `2026-05-16-config-pg-split.md` 完成（需要 config/ 子域文件已存在） |

**推荐执行顺序**：
1. 先执行 Task 1-5（Task、Knowledge、Channel、agent-task-runner）
2. 执行 `config-pg-split` 计划
3. 再执行 Task 6-7（Config 子域 Repository）
