# Schema & Architecture Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align database schema and service code with the HTML domain model (`docs/arch/domain-model.html`), closing 5 concrete gaps between architecture design and implementation.

**Architecture:** Five independent schema migrations + code updates, each producing a testable, committable unit. No cross-task dependencies — each task can be executed and verified in isolation.

**Tech Stack:** Drizzle ORM (schema.ts + `drizzle-kit generate`), PostgreSQL, Bun test

---

## File Structure

### Schema changes (all in `src/db/schema.ts`)
- `agentKnowledgeBinding`: add `agentConfigId` UUID FK column, eventually remove `agentName`
- `scheduledTask`: remove `environmentId` column
- `environment`: remove `agentName` column (already superseded by `agentConfigId`)
- `channelBinding`: drop entire table (legacy, replaced by `imChannel` + `imChannelRoute`)

### Code changes (repos, services, routes)
- `src/repositories/knowledge-base.ts`: rename `listByAgentName` → `listByAgentConfigId`, update all query methods
- `src/services/agent-knowledge.ts`: change all functions from `agentName: string` → `agentConfigId: string`
- `src/services/knowledge-runtime.ts`: change `agentName` params → `agentConfigId`
- `src/services/launch-spec-builder.ts`: resolve agentConfigId before calling knowledge bindings
- `src/services/config/agent-config.ts`: pass `agentConfigId` instead of `name` to sync functions
- `src/services/instance.ts`: resolve agentConfigId, pass to launch-spec-builder
- `src/routes/web/config/agents.ts`: pass `id` instead of `name` to knowledge sync
- `src/routes/mcp/knowledge.ts`: accept agentConfigId
- `src/transport/acp-ws-handler.ts`: remove agentName references for environment
- `src/services/environment-acp.ts`: remove agentName references

### Documentation
- `docs/arch/16-domain-model.md`: rewrite to match HTML version (Team-owned, Session sunk, etc.)

### Tests
- `src/__tests__/agent-knowledge.test.ts`: update to use agentConfigId
- `src/__tests__/config-agents.test.ts`: update mocks
- All other affected test files

### Drizzle migrations (generated, never hand-written)
- `drizzle/000X_agent_knowledge_binding_agent_config_id.sql`
- `drizzle/000X_scheduled_task_drop_environment_id.sql`
- `drizzle/000X_environment_drop_agent_name.sql`
- `drizzle/000X_drop_channel_binding.sql`

---

## Task 1: agentKnowledgeBinding — add agentConfigId column

This is the highest-value change: the binding table currently uses `agentName` (varchar), which breaks if an agent is renamed. We add `agentConfigId` (UUID FK) as the new join key.

**Files:**
- Modify: `src/db/schema.ts` (agentKnowledgeBinding table)
- Modify: `src/repositories/knowledge-base.ts` (IAgentKnowledgeBindingRepo + PgAgentKnowledgeBindingRepo)
- Modify: `src/services/agent-knowledge.ts` (all public functions)
- Modify: `src/services/knowledge-runtime.ts` (resolveBoundKnowledgeBasesForAgent, searchKnowledgeForAgent, readKnowledgeResourceForAgent)
- Modify: `src/services/launch-spec-builder.ts` (buildLaunchSpec)
- Modify: `src/services/config/agent-config.ts` (upsert calls to sync)
- Modify: `src/routes/web/config/agents.ts` (pass agentConfigId)
- Modify: `src/routes/mcp/knowledge.ts` (accept agentConfigId)
- Test: `src/__tests__/agent-knowledge.test.ts`
- Test: `src/__tests__/config-agents.test.ts`
- Test: `src/__tests__/permission-flow.test.ts`
- Test: `src/__tests__/mcp-agent-config-upsert.test.ts`
- Test: `src/__tests__/agent-config-update-return.test.ts`
- Test: `src/__tests__/agent-config-create-single-loop.test.ts`
- Test: `src/__tests__/agent-config-build-set.test.ts`
- Test: `src/__tests__/services/config-agent-config.test.ts`
- Test: `src/__tests__/knowledge-mcp-route.test.ts`
- Test: `src/__tests__/instance-service.test.ts`

- [ ] **Step 1: Update schema — add agentConfigId column to agentKnowledgeBinding**

In `src/db/schema.ts`, change the `agentKnowledgeBinding` table:

```typescript
export const agentKnowledgeBinding = pgTable("agent_knowledge_binding", {
  id: uuid("id").primaryKey().defaultRandom(),
  // 新：UUID FK 关联 AgentConfig（替代 agentName）
  agentConfigId: uuid("agent_config_id")
    .notNull()
    .references(() => agentConfig.id, { onDelete: "cascade" }),
  // 旧：agentName varchar 字段暂时保留（迁移完成后 Task 2 删除）
  agentName: varchar("agent_name"),
  knowledgeBaseId: uuid("knowledge_base_id")
    .notNull()
    .references(() => knowledgeBase.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  agentConfigIdx: index("idx_agent_knowledge_binding_agent_config").on(table.agentConfigId),
  kbIdx: index("idx_agent_knowledge_binding_kb").on(table.knowledgeBaseId),
  agentConfigKbIdx: uniqueIndex("idx_agent_knowledge_binding_agent_config_kb").on(table.agentConfigId, table.knowledgeBaseId),
  // 旧索引保留，agentName 删除时一并移除
  agentIdx: index("idx_agent_knowledge_binding_agent").on(table.agentName),
  agentKbIdx: uniqueIndex("idx_agent_knowledge_binding_agent_kb").on(table.agentName, table.knowledgeBaseId),
}));
```

- [ ] **Step 2: Generate migration**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit generate --name agent_knowledge_binding_agent_config_id
```

- [ ] **Step 3: Push schema to dev database**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit push
```

- [ ] **Step 4: Update repository — add agentConfigId-based methods**

In `src/repositories/knowledge-base.ts`, add new methods to `IAgentKnowledgeBindingRepo` and `PgAgentKnowledgeBindingRepo`:

```typescript
// Add to IAgentKnowledgeBindingRepo interface:
listByAgentConfigId(agentConfigId: string): Promise<AgentKnowledgeBindingRow[]>;
listEnabledByAgentConfigId(agentConfigId: string): Promise<AgentKnowledgeBindingRow[]>;
deleteByAgentConfigId(agentConfigId: string): Promise<void>;
listJoinedWithKnowledgeBaseByConfigId(agentConfigId: string): Promise<Array<AgentKnowledgeBindingRow & {
  kbId: string;
  kbRemoteId: string | null;
  kbRemoteAccountId: string | null;
  kbRemoteUserId: string | null;
  kbUserId: string;
}>>;

// Add to PgAgentKnowledgeBindingRepo class:
async listByAgentConfigId(agentConfigId: string) {
  return db.select().from(agentKnowledgeBinding)
    .where(eq(agentKnowledgeBinding.agentConfigId, agentConfigId))
    .orderBy(agentKnowledgeBinding.priority);
}

async listEnabledByAgentConfigId(agentConfigId: string) {
  return db.select().from(agentKnowledgeBinding)
    .where(and(eq(agentKnowledgeBinding.agentConfigId, agentConfigId), eq(agentKnowledgeBinding.enabled, true)));
}

async deleteByAgentConfigId(agentConfigId: string) {
  await db.delete(agentKnowledgeBinding).where(eq(agentKnowledgeBinding.agentConfigId, agentConfigId));
}

async listJoinedWithKnowledgeBaseByConfigId(agentConfigId: string) {
  return db.select({
    id: agentKnowledgeBinding.id,
    agentConfigId: agentKnowledgeBinding.agentConfigId,
    agentName: agentKnowledgeBinding.agentName,
    knowledgeBaseId: agentKnowledgeBinding.knowledgeBaseId,
    priority: agentKnowledgeBinding.priority,
    enabled: agentKnowledgeBinding.enabled,
    createdAt: agentKnowledgeBinding.createdAt,
    updatedAt: agentKnowledgeBinding.updatedAt,
    kbId: knowledgeBase.id,
    kbRemoteId: knowledgeBase.remoteId,
    kbRemoteAccountId: knowledgeBase.remoteAccountId,
    kbRemoteUserId: knowledgeBase.remoteUserId,
    kbUserId: knowledgeBase.userId,
  })
    .from(agentKnowledgeBinding)
    .innerJoin(knowledgeBase, eq(agentKnowledgeBinding.knowledgeBaseId, knowledgeBase.id))
    .where(and(eq(agentKnowledgeBinding.agentConfigId, agentConfigId), eq(agentKnowledgeBinding.enabled, true)));
}
```

- [ ] **Step 5: Update agent-knowledge.ts — add agentConfigId-based functions**

In `src/services/agent-knowledge.ts`, add new functions alongside the existing ones (don't remove old ones yet — they'll be removed in Task 2):

```typescript
/**
 * Lists enabled knowledge base bindings for an agent by agentConfigId.
 */
export async function listAgentKnowledgeBindingsById(agentConfigId: string): Promise<AgentKnowledgeBindingRecord[]> {
  const rows = await agentKnowledgeBindingRepo.listEnabledByAgentConfigId(agentConfigId);
  return rows.map((row) => ({
    knowledgeBaseId: row.knowledgeBaseId,
    priority: row.priority,
    enabled: row.enabled,
  }));
}

/**
 * Replaces all agent knowledge bindings by agentConfigId.
 */
export async function syncAgentKnowledgeBindingsById(
  teamId: string,
  agentConfigId: string,
  knowledge: AgentKnowledgeConfig | null | undefined,
): Promise<void> {
  const knowledgeBaseIds = normalizeKnowledgeBaseIds(knowledge?.knowledgeBaseIds);
  await agentKnowledgeBindingRepo.deleteByAgentConfigId(agentConfigId);

  if (knowledgeBaseIds.length === 0) {
    return;
  }

  // Verify all referenced knowledge bases exist and belong to the team
  const existingIds = new Set<string>();
  for (const kbId of knowledgeBaseIds) {
    const kb = await knowledgeBaseRepo.getByTeamAndId(teamId, kbId);
    if (kb) {
      existingIds.add(kb.id);
    }
  }
  const missingIds = knowledgeBaseIds.filter((id) => !existingIds.has(id));
  if (missingIds.length > 0) {
    throw new InvalidKnowledgeBindingError(`知识库不存在或无权限访问: ${missingIds.join(", ")}`);
  }

  const now = new Date();
  await agentKnowledgeBindingRepo.createMany(
    knowledgeBaseIds.map((knowledgeBaseId, priority) => ({
      id: generateBindingId(),
      agentConfigId,
      knowledgeBaseId,
      priority,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
}
```

- [ ] **Step 6: Update knowledge-runtime.ts — add agentConfigId-based functions**

In `src/services/knowledge-runtime.ts`, add:

```typescript
/**
 * Resolves the ordered bound knowledge bases for an agent by agentConfigId.
 */
export async function resolveBoundKnowledgeBasesByConfigId(
  agentConfigId: string,
  teamId?: string,
): Promise<BoundKnowledgeBase[]> {
  const rows = await agentKnowledgeBindingRepo.listJoinedWithKnowledgeBaseByConfigId(agentConfigId);

  return rows
    .filter((row) => !!row.kbRemoteId && (!teamId || row.kbUserId === teamId))
    .sort((a, b) => a.priority - b.priority)
    .map((row) => ({
      id: row.kbId,
      remoteId: row.kbRemoteId!,
      remoteAccountId: row.kbRemoteAccountId?.trim() || row.kbUserId,
      remoteUserId: row.kbRemoteUserId?.trim() || row.kbUserId,
      priority: row.priority,
    }));
}

/**
 * Searches across the agent's bound knowledge bases by agentConfigId.
 */
export async function searchKnowledgeByConfigId(input: {
  agentConfigId: string;
  query: string;
  topK: number;
  teamId?: string;
}): Promise<KnowledgeSearchResult[]> {
  const knowledgeBases = await resolveBoundKnowledgeBasesByConfigId(input.agentConfigId, input.teamId);
  if (knowledgeBases.length === 0) {
    return [];
  }

  const provider = getKnowledgeRuntimeProvider();
  const results = await provider.search({
    knowledgeBases: knowledgeBases.map((item) => ({
      remoteId: item.remoteId,
      remoteAccountId: item.remoteAccountId,
      remoteUserId: item.remoteUserId,
    })),
    query: input.query,
    topK: input.topK,
  });

  const knowledgeBaseIdByRemoteId = new Map(knowledgeBases.map((item) => [item.remoteId, item.id]));
  const resourceRemoteIds = Array.from(
    new Set(
      results
        .map((item) => item.resourceId?.trim())
        .filter((value): value is string => !!value),
    ),
  );
  const resourceIdByRemoteId = new Map<string, string>();
  if (resourceRemoteIds.length > 0) {
    const resourceRows = await knowledgeResourceRepo.findByRemoteIds(resourceRemoteIds);
    for (const row of resourceRows) {
      if (row.remoteId) {
        resourceIdByRemoteId.set(row.remoteId, row.id);
      }
    }
  }

  return results.map((item) => ({
    title: item.title,
    snippet: item.snippet,
    source: item.source,
    score: item.score,
    knowledgeBaseId: item.knowledgeBaseId
      ? knowledgeBaseIdByRemoteId.get(item.knowledgeBaseId) ?? item.knowledgeBaseId
      : null,
    resourceId: item.resourceId
      ? resourceIdByRemoteId.get(item.resourceId) ?? item.resourceId
      : null,
  }));
}
```

- [ ] **Step 7: Update launch-spec-builder.ts — use agentConfigId**

In `src/services/launch-spec-builder.ts`, change `BuildLaunchSpecInput` and `buildLaunchSpec`:

```typescript
export interface BuildLaunchSpecInput {
  workspacePath: string;
  agentName: string;
  agentConfigId?: string | null;  // 新增
  agentPrompt?: string | null;
  modelRef?: string | null;
  fullConfig: AgentFullConfig;
  environmentSecret: string;
}

export async function buildLaunchSpec(input: BuildLaunchSpecInput): Promise<AgentLaunchSpec> {
  const { workspacePath, agentName, agentConfigId, agentPrompt, modelRef, fullConfig, environmentSecret } = input;

  // ... (existing agent, model, mcpServers code unchanged) ...

  // 优先用 agentConfigId 查询知识库绑定
  const knowledgeBindings = agentConfigId
    ? await listAgentKnowledgeBindingsById(agentConfigId)
    : await listAgentKnowledgeBindings(agentName);
  if (knowledgeBindings.length > 0) {
    mcpServers.push({
      name: "kb",
      type: "streamable-http",
      url: `${getBaseUrl()}/mcp/knowledge`,
      headers: { Authorization: `Bearer ${environmentSecret}` },
      timeout: 15000,
    });
  }

  return {
    workspace: workspacePath,
    agent,
    model,
    skills: [],
    mcpServers,
  };
}
```

Also add the import:
```typescript
import { listAgentKnowledgeBindings, listAgentKnowledgeBindingsById } from "./agent-knowledge";
```

- [ ] **Step 8: Update instance.ts — pass agentConfigId to launch-spec-builder**

In `src/services/instance.ts`, in `spawnInstanceFromEnvironment`, pass `agentConfigId`:

```typescript
  const launchSpec = await buildLaunchSpec({
    workspacePath: cwd,
    agentName,
    agentConfigId: env.agentConfigId ?? null,  // 新增
    agentPrompt,
    modelRef,
    fullConfig,
    environmentSecret: env.secret,
  });
```

- [ ] **Step 9: Update routes/web/config/agents.ts — use agentConfigId for sync**

In `src/routes/web/config/agents.ts`, change the create and update handlers to pass `id` instead of `name`:

For the create handler (after insert succeeds and we have the agentConfig row):
```typescript
// Before: await syncAgentKnowledgeBindings(ctx.userId, name, filtered.knowledge ...)
// After:
const created = await getAgentConfig(ctx, name);
await syncAgentKnowledgeBindingsById(ctx.teamId, created!.id, filtered.knowledge as AgentKnowledgeConfig | null | undefined);
```

For the update handler:
```typescript
// Before: await syncAgentKnowledgeBindings(ctx.userId, name, filtered.knowledge ...)
// After: get the agentConfig first to obtain its id
const existing = await getAgentConfig(ctx, name);
await syncAgentKnowledgeBindingsById(ctx.teamId, existing!.id, filtered.knowledge as AgentKnowledgeConfig | null | undefined);
```

For the list handler (knowledge base count):
```typescript
// Before: knowledgeBaseCount: (await listAgentKnowledgeBindings(a.name)).length,
// After:
knowledgeBaseCount: (await listAgentKnowledgeBindingsById(a.id)).length,
```

Update imports at the top:
```typescript
import {
  listAgentKnowledgeBindingsById,
  syncAgentKnowledgeBindingsById,
} from "../../services/agent-knowledge";
```

- [ ] **Step 10: Update routes/mcp/knowledge.ts — accept agentConfigId**

Read `src/routes/mcp/knowledge.ts` and update all calls that pass `agentName` to use `agentConfigId` instead, calling the new `searchKnowledgeByConfigId` and `resolveBoundKnowledgeBasesByConfigId` functions.

- [ ] **Step 11: Update all test files**

In each test file that mocks `agentKnowledgeBinding` or calls `syncAgentKnowledgeBindings`/`listAgentKnowledgeBindings`:

1. `src/__tests__/agent-knowledge.test.ts` — change all `syncAgentKnowledgeBindings("user", "build", ...)` to `syncAgentKnowledgeBindingsById("teamId", agentConfigId, ...)` where `agentConfigId` is a real UUID inserted into the `agent_config` table. Change `listAgentKnowledgeBindings("build")` to `listAgentKnowledgeBindingsById(agentConfigId)`.

2. `src/__tests__/config-agents.test.ts` — update mock from `syncAgentKnowledgeBindings: async (_ctx, agentName, knowledge)` to `syncAgentKnowledgeBindingsById: async (teamId, agentConfigId, knowledge)`. Update `_agentKnowledgeBindings` key from agentName to agentConfigId.

3. `src/__tests__/permission-flow.test.ts` — update mock `syncAgentKnowledgeBindings` → `syncAgentKnowledgeBindingsById`.

4. `src/__tests__/instance-service.test.ts` — update mock `listAgentKnowledgeBindings` → `listAgentKnowledgeBindingsById`.

5. `src/__tests__/knowledge-mcp-route.test.ts` — update `agentKnowledgeBinding` inserts to include `agentConfigId` field.

6. `src/__tests__/web-knowledge-bases.test.ts` — update `agentKnowledgeBinding` inserts to include `agentConfigId`.

7. All other test files referencing the old functions — update imports and mock signatures.

- [ ] **Step 12: Run all affected tests**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/agent-knowledge.test.ts
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/config-agents.test.ts
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/instance-service.test.ts
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/knowledge-mcp-route.test.ts
```

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "refactor: agentKnowledgeBinding 新增 agentConfigId UUID FK，替代 agentName 字符串关联

- schema: agent_knowledge_binding 表新增 agent_config_id UUID FK
- repo: IAgentKnowledgeBindingRepo 新增 ByConfigId 系列方法
- service: agent-knowledge/knowledge-runtime 新增 ById 版本函数
- launch-spec-builder: 优先用 agentConfigId 查询知识库绑定
- routes: config/agents 和 mcp/knowledge 切换到 ID 关联
- tests: 全部更新为使用 agentConfigId

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: agentKnowledgeBinding — remove agentName column

After Task 1 is deployed and all code uses `agentConfigId`, remove the legacy `agentName` column and its indexes.

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/repositories/knowledge-base.ts`
- Modify: `src/services/agent-knowledge.ts`
- Modify: `src/services/knowledge-runtime.ts`
- Modify: `src/services/launch-spec-builder.ts`

- [ ] **Step 1: Remove agentName column from schema**

In `src/db/schema.ts`, update `agentKnowledgeBinding` — remove the `agentName` column and its indexes:

```typescript
export const agentKnowledgeBinding = pgTable("agent_knowledge_binding", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentConfigId: uuid("agent_config_id")
    .notNull()
    .references(() => agentConfig.id, { onDelete: "cascade" }),
  knowledgeBaseId: uuid("knowledge_base_id")
    .notNull()
    .references(() => knowledgeBase.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  agentConfigIdx: index("idx_agent_knowledge_binding_agent_config").on(table.agentConfigId),
  kbIdx: index("idx_agent_knowledge_binding_kb").on(table.knowledgeBaseId),
  agentConfigKbIdx: uniqueIndex("idx_agent_knowledge_binding_agent_config_kb").on(table.agentConfigId, table.knowledgeBaseId),
}));
```

- [ ] **Step 2: Remove old agentName-based methods from repo**

In `src/repositories/knowledge-base.ts`:
- Remove `listByAgentName`, `listEnabledByAgentName`, `deleteByAgentName` from both interface and class
- Remove `listJoinedWithKnowledgeBase` (replaced by `listJoinedWithKnowledgeBaseByConfigId`)
- Remove old index references

- [ ] **Step 3: Remove old agentName-based functions from services**

In `src/services/agent-knowledge.ts`:
- Remove `listAgentKnowledgeBindings(agentName)` and `syncAgentKnowledgeBindings(userId, agentName, knowledge)`
- Remove import of old repo methods

In `src/services/knowledge-runtime.ts`:
- Remove `resolveBoundKnowledgeBasesForAgent(agentName, userId)`, `searchKnowledgeForAgent`, `readKnowledgeResourceForAgent`
- Keep only the `ByConfigId` versions

In `src/services/launch-spec-builder.ts`:
- Remove the `agentName` fallback in knowledge binding lookup
- Simplify to always use `agentConfigId`

- [ ] **Step 4: Generate migration and push**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit generate --name drop_agent_knowledge_binding_agent_name
cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit push
```

- [ ] **Step 5: Run all tests**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: 删除 agentKnowledgeBinding.agentName 旧字段

- schema: 移除 agent_name 列及旧索引
- repo: 移除 ByAgentName 系列方法
- service: 移除基于 agentName 的函数，仅保留 agentConfigId 版本

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: ScheduledTask — remove environmentId field

The HTML architecture says ScheduledTask is a pure HTTP cron triggerer, not bound to any Environment. The execution code (`executeTaskById`) already ignores `environmentId` — it just does `fetch(task.url)`. The field is schema residual.

**Files:**
- Modify: `src/db/schema.ts` (scheduledTask table)
- Modify: `src/repositories/task.ts` (if environmentId is in insert/update types)

- [ ] **Step 1: Remove environmentId from scheduledTask schema**

In `src/db/schema.ts`, find the `scheduledTask` table definition and remove:

```typescript
// DELETE this line:
  environmentId: varchar("environment_id")
    .references(() => environment.id, { onDelete: "cascade" }),
```

Also remove `taskExecutionLog.environmentId` and `taskExecutionLog.environmentName` if they exist and are unused:

```typescript
// DELETE these lines from taskExecutionLog:
  environmentId: varchar("environment_id"),
  environmentName: varchar("environment_name"),
```

- [ ] **Step 2: Update repository types**

Read `src/repositories/task.ts`. If `ScheduledTaskInsert` or `ScheduledTaskRow` types infer the `environmentId` field from the schema, they will auto-update after the schema change. Check if any repo methods explicitly reference `environmentId` and remove those references.

- [ ] **Step 3: Check for environmentId references in task service and routes**

Grep for `environmentId` in `src/services/task.ts` and `src/routes/web/tasks.ts`. If any route handler passes `environmentId` during task creation or update, remove that logic.

- [ ] **Step 4: Generate migration and push**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit generate --name scheduled_task_drop_environment_id
cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit push
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/task-core.test.ts
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/task-routes.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: 删除 ScheduledTask 残留的 environmentId 字段

ScheduledTask 已是纯 HTTP cron 触发器，environmentId 在执行逻辑中未使用

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Environment — remove agentName column

The `agentConfigId` UUID FK was added in a prior commit and is now the primary join key. `agentName` is a legacy fallback. Since Task 1 migrated all knowledge bindings to `agentConfigId`, and `instance.ts` already prefers `agentConfigId`, we can remove `agentName`.

**Files:**
- Modify: `src/db/schema.ts` (environment table)
- Modify: `src/services/environment-core.ts` (sanitizeResponse)
- Modify: `src/services/environment-web.ts` (create/update)
- Modify: `src/services/launch-spec-builder.ts` (remove agentName from BuildLaunchSpecInput)
- Modify: `src/services/instance.ts` (remove agentName fallback)
- Modify: `src/transport/acp-ws-handler.ts` (if it reads agentName)
- Modify: `src/services/environment-acp.ts` (if it reads agentName)
- Modify: `src/services/agent-task-runner.ts` (if it reads agentName)
- Test: `src/__tests__/environment-core-utils.test.ts`
- Test: `src/__tests__/instance-service.test.ts`

- [ ] **Step 1: Remove agentName from environment schema**

In `src/db/schema.ts`, find the `environment` table and remove:

```typescript
// DELETE this line:
  agentName: varchar("agent_name"),
```

- [ ] **Step 2: Update sanitizeResponse in environment-core.ts**

In `src/services/environment-core.ts`, `sanitizeResponse` function, remove the `agent_name` field from the response object, or change it to derive from the agentConfigId join:

```typescript
// Before:
  agent_name: row.agentName ?? null,
// After: remove this line entirely (frontend should use agent_config_id)
```

- [ ] **Step 3: Update create/update environment params**

In `src/services/environment-core.ts`, `CreateWebEnvironmentParams` and `UpdateWebEnvironmentParams` should not have `agentName`-related fields (they already use `agentConfigId`).

In `src/services/environment-web.ts`, check create and update functions for any `agentName` handling and remove.

- [ ] **Step 4: Update instance.ts and launch-spec-builder.ts**

In `src/services/instance.ts`, `spawnInstanceFromEnvironment`: the `agentName` variable is currently derived from `env.agentName` as fallback. Change to always resolve from `agentConfigId`:

```typescript
// If agentConfigId exists, get the name from the resolved config
// If not, use "general" as default
let agentName = "general";
if (env.agentConfigId) {
  const resolvedAgentConfig = await getAgentConfigById(env.agentConfigId);
  if (resolvedAgentConfig) agentName = resolvedAgentConfig.name;
}
```

In `src/services/launch-spec-builder.ts`, remove `agentName` from `BuildLaunchSpecInput` (it's only used for the agent name in the launch spec, which can be derived from the agentConfigId lookup done in instance.ts).

- [ ] **Step 5: Check acp-ws-handler.ts and environment-acp.ts**

Read `src/transport/acp-ws-handler.ts` and `src/services/environment-acp.ts` for any `agentName` references. These files handle the `/acp/ws` registration where acp-link sends its agent name. If `agentName` is set during registration, replace with a comment that the agent name is informational only and `agentConfigId` should be used for config resolution.

- [ ] **Step 6: Generate migration and push**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit generate --name environment_drop_agent_name
cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit push
```

- [ ] **Step 7: Run tests**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/environment-core-utils.test.ts
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/instance-service.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: 删除 Environment.agentName 旧字段，全面切换到 agentConfigId

Environment 已通过 agentConfigId UUID FK 强绑定 AgentConfig
agentName 字段不再需要

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Drop legacy channelBinding table

The `channelBinding` table is a legacy design replaced by `imChannel` + `imChannelRoute`. All new code uses the new tables. The old table can be dropped.

**Files:**
- Modify: `src/db/schema.ts` (remove channelBinding table)
- Modify: `src/repositories/index.ts` (remove channelBinding re-export if any)
- Test: grep for any remaining channelBinding references in code

- [ ] **Step 1: Verify no code references channelBinding**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && grep -r "channelBinding" src/ --include="*.ts" -l
```

If any files reference it, check if they are dead code or actively used. Only proceed if no active references exist.

- [ ] **Step 2: Remove channelBinding from schema**

In `src/db/schema.ts`, delete the entire `channelBinding` table definition:

```typescript
// DELETE entire block:
export const channelBinding = pgTable("channel_binding", {
  id: uuid("id").primaryKey().defaultRandom(),
  platform: varchar("platform").notNull(),
  chatId: varchar("chat_id"),
  agentId: varchar("agent_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  platformIdx: index("idx_channel_binding_platform").on(table.platform),
  agentIdx: index("idx_channel_binding_agent_id").on(table.agentId),
}));
```

- [ ] **Step 3: Remove any repository references**

Check `src/repositories/channel-binding.ts` — if this file exists and only serves `channelBinding`, delete it. Update `src/repositories/index.ts` to remove the re-export.

- [ ] **Step 4: Generate migration and push**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit generate --name drop_channel_binding_legacy
cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit push
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: 删除遗留 channelBinding 表

已由 imChannel + imChannelRoute 替代

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Sync markdown architecture doc

The markdown doc `docs/arch/16-domain-model.md` describes the old User-owned model and contradicts the HTML version. Rewrite it to match the HTML domain model (Team-owned, Session sunk, ScheduledTask as pure cron, etc.).

**Files:**
- Rewrite: `docs/arch/16-domain-model.md`

- [ ] **Step 1: Rewrite the markdown doc**

Read `docs/arch/domain-model.html` and rewrite `docs/arch/16-domain-model.md` to match. Key changes:

1. **Resource ownership**: "Team 是所有资源的所有权单位" instead of "User 是所有资源的所有者"
2. **Session**: Mark as "已下沉到 acp-link，RCS 不持久化 Session 元数据"
3. **ScheduledTask**: "纯 HTTP cron 触发器，不绑定 Environment"
4. **API Key**: "Team 级别资源，不是 User 个人持有"
5. **Environment-AgentConfig**: "通过 agentConfigId（UUID）强绑定" instead of "通过 agentName 字符串匹配"
6. **IMChannel**: 一等资源，路由规则在 imChannelRoute 中
7. **Workflow**: 独立领域模块
8. **Team roles**: owner / admin / member 三种角色及权限范围

Preserve the ASCII diagrams structure but update labels and relationships. Add the concept cards from the HTML as H3 sections.

- [ ] **Step 2: Commit**

```bash
git add docs/arch/16-domain-model.md
git commit -m "docs: 同步 16-domain-model.md 与 HTML 架构文档

- 资源所有权从 User 改为 Team
- Session 标注为已下沉
- ScheduledTask 改为纯 HTTP cron 描述
- API Key 改为 Team 级别
- Environment-AgentConfig 改为 UUID 强绑定

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

### 1. Spec Coverage
- [x] agentKnowledgeBinding agentName → agentConfigId: Task 1 + Task 2
- [x] ScheduledTask environmentId removal: Task 3
- [x] Environment agentName removal: Task 4
- [x] channelBinding legacy table: Task 5
- [x] Markdown doc sync: Task 6

### 2. Placeholder Scan
- No "TBD", "TODO", "implement later", "fill in details" found
- No "add appropriate error handling" found
- All code steps contain actual code

### 3. Type Consistency
- `agentConfigId` used consistently as `string` (UUID) across all tasks
- `listAgentKnowledgeBindingsById(agentConfigId: string)` → returns `AgentKnowledgeBindingRecord[]`
- `syncAgentKnowledgeBindingsById(teamId: string, agentConfigId: string, knowledge)` → returns `void`
- `resolveBoundKnowledgeBasesByConfigId(agentConfigId: string, teamId?: string)` → returns `BoundKnowledgeBase[]`
- All repo method names follow `ByConfigId` suffix pattern

### Items intentionally excluded from this plan (require separate decisions):
1. **Session complete removal** — needs architectural decision on whether RCS should persist any session metadata
2. **Workflow execution engine** — whole feature, not schema alignment
3. **Team role permission enforcement** — whole feature, needs RBAC design
4. **IMChannel migration verification** — already has new tables, just needs usage audit
5. **Skill binding direction** — current design (Skill FK → AgentConfig) works; reversing is low priority
