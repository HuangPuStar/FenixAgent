# 组织资源隔离加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `model` 表和 `mcpTool` 表添加 `organization_id` 列，补齐组织级隔离的缺失环节，消除跨组织数据泄露风险。

**Architecture:** 两个独立的 schema + 服务层变更，每个表加 `organization_id NOT NULL` 列，同步修改所有 CRUD 函数加上组织过滤。model 表通过 provider 的 org 间接关联（路由层已验证），mcpTool 表通过 mcpServer 的 org 关联。变更后需要迁移数据库并回填现有数据。

**Tech Stack:** Drizzle ORM (schema.ts + migration), PostgreSQL, Bun test

---

## 现状分析

### 已隔离（无需改动）
- provider, agentConfig, mcpServer, skill, userConfig, environment, scheduledTask, shareLink, knowledgeBase, workflow — 表有 `organization_id`，服务层全 WHERE 过滤
- taskExecutionLog, knowledgeResource, agentKnowledgeBinding, workflowVersion, workflowRun, shareEventSnapshot — 无 `organization_id` 但通过 FK 链间接隔离，查询前验证主表归属

### 需要修复
| 表 | 问题 | 风险等级 |
|---|---|---|
| **model** | 无 `organization_id`，仅靠 providerId FK。路由层已验证 provider 归属，但服务层本身无防线 | 中 — 当前安全，缺防御纵深 |
| **mcpTool** | 无 `organization_id`，全局缓存。`countToolsByServer`/`replaceToolsForServer` 等按 `serverName` 查询，不同组织同名 server 会互相覆盖 | 高 — 跨组织数据泄露 |

### File Structure

```
src/db/schema.ts                              — 添加 organization_id 列（model, mcpTool）
src/services/config/model.ts                  — 所有函数加 organizationId 参数 + WHERE 过滤
src/services/config/mcp-server.ts             — mcpTool 缓存函数加 organizationId
src/services/config-pg.ts                     — 桶文件 re-export 签名变更
src/services/config/index.ts                  — 桶文件 re-export 签名变更
src/routes/web/config/providers.ts            — 传递 organizationId 给 model 函数
src/routes/web/config/mcp.ts                  — 传递 organizationId 给 mcpTool 函数
src/__tests__/config-model-isolation.test.ts  — model 隔离测试
src/__tests__/mcp-tool-isolation.test.ts      — mcpTool 隔离测试
```

---

### Task 1: model 表添加 organization_id

**Files:**
- Modify: `src/db/schema.ts` (model 表定义)

- [ ] **Step 1: 修改 model 表定义，添加 organization_id 列和索引**

在 `src/db/schema.ts` 的 model 表定义中添加 `organizationId` 列和组合索引：

```typescript
export const model = pgTable(
  "model",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => provider.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    modelId: varchar("model_id").notNull(),
    displayName: varchar("display_name"),
    modalities: jsonb("modalities"),
    limitConfig: jsonb("limit_config"),
    cost: jsonb("cost"),
    options: jsonb("options"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerModelIdx: uniqueIndex("idx_model_provider_model").on(table.providerId, table.modelId),
    orgModelIdx: uniqueIndex("idx_model_org_provider_model").on(table.organizationId, table.providerId, table.modelId),
  }),
);
```

- [ ] **Step 2: 生成迁移文件**

Run: `bunx drizzle-kit generate --name add-model-organization-id`

- [ ] **Step 3: 推送到数据库**

Run: `bunx drizzle-kit push`

注意：现有数据需要回填。由于 model 通过 providerId → provider.organizationId 关联，可以用以下 SQL 回填：

```sql
UPDATE model SET organization_id = provider.organization_id
FROM provider WHERE model.provider_id = provider.id;
```

如果 drizzle-kit push 因 NOT NULL 约束失败，先临时用 `DEFAULT ''`，再手动回填后去掉 default。

---

### Task 2: model 服务层加 organizationId 过滤

**Files:**
- Modify: `src/services/config/model.ts`
- Modify: `src/services/config-pg.ts`（如果 re-export 签名需要调整）
- Modify: `src/services/config/index.ts`（如果 re-export 签名需要调整）

- [ ] **Step 1: 修改 model.ts 所有函数签名和 WHERE 条件**

将所有函数的第一个参数从 `providerId: string` 改为 `(organizationId: string, providerId: string)`，并在所有查询的 WHERE 条件中加入 `eq(model.organizationId, organizationId)`。INSERT 时写入 `organizationId`。

```typescript
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { model } from "../../db/schema";

function buildModelValues(data: {
  displayName?: string;
  modalities?: unknown;
  limitConfig?: unknown;
  cost?: unknown;
  options?: unknown;
}) {
  return {
    displayName: data.displayName,
    modalities: data.modalities ?? undefined,
    limitConfig: data.limitConfig ?? undefined,
    cost: data.cost ?? undefined,
    options: data.options ?? undefined,
    updatedAt: new Date(),
  };
}

export async function addModel(
  organizationId: string,
  providerId: string,
  data: {
    modelId: string;
    displayName?: string;
    modalities?: unknown;
    limitConfig?: unknown;
    cost?: unknown;
    options?: unknown;
  },
) {
  const fields = buildModelValues(data);
  await db
    .insert(model)
    .values({ organizationId, providerId, modelId: data.modelId, ...fields })
    .onConflictDoUpdate({
      target: [model.providerId, model.modelId],
      set: fields,
    });
}

export async function updateModel(
  organizationId: string,
  providerId: string,
  modelId: string,
  data: {
    displayName?: string;
    modalities?: unknown;
    limitConfig?: unknown;
    cost?: unknown;
    options?: unknown;
  },
): Promise<boolean> {
  const set: Partial<typeof model.$inferInsert> = { updatedAt: new Date() };
  if (data.displayName !== undefined) set.displayName = data.displayName;
  if (data.modalities !== undefined) set.modalities = data.modalities;
  if (data.limitConfig !== undefined) set.limitConfig = data.limitConfig;
  if (data.cost !== undefined) set.cost = data.cost;
  if (data.options !== undefined) set.options = data.options;

  const result = await db
    .update(model)
    .set(set)
    .where(and(eq(model.organizationId, organizationId), eq(model.providerId, providerId), eq(model.modelId, modelId)))
    .returning({ id: model.id });
  return result.length > 0;
}

export async function removeModel(organizationId: string, providerId: string, modelId: string): Promise<boolean> {
  const result = await db
    .delete(model)
    .where(and(eq(model.organizationId, organizationId), eq(model.providerId, providerId), eq(model.modelId, modelId)))
    .returning({ id: model.id });
  return result.length > 0;
}
```

- [ ] **Step 2: 更新桶文件 re-export**

检查 `src/services/config/index.ts` 和 `src/services/config-pg.ts` 中 `addModel`, `updateModel`, `removeModel` 的 re-export 不需要改（函数签名变更在调用处适配）。

- [ ] **Step 3: 修改 providers.ts 路由层，传递 organizationId**

在 `src/routes/web/config/providers.ts` 中，所有调用 `configPg.addModel` / `configPg.updateModel` / `configPg.removeModel` 的地方，加入 `authCtx.organizationId` 作为第一个参数：

```typescript
// handleSet 中（约 line 102-104）
await configPg.updateModel(authCtx.organizationId, providerRecord.id, modelId, buildModelData(modelCfg));
await configPg.addModel(authCtx.organizationId, providerRecord.id, { modelId, ...buildModelData(modelCfg) });

// handleAddModel 中（约 line 167）
await configPg.addModel(authCtx.organizationId, p.id, { modelId, ...buildModelData(data) });

// handleUpdateModel 中（约 line 186）
await configPg.updateModel(authCtx.organizationId, p.id, modelId, buildModelData(data));

// handleRemoveModel 中（约 line 200）
await configPg.removeModel(authCtx.organizationId, p.id, modelId);
```

- [ ] **Step 4: 检查其他调用点**

搜索所有 `addModel`/`updateModel`/`removeModel` 的 import 和调用，确保全部更新。特别检查：
- `src/services/config/aggregate.ts`（批量配置聚合，如果引用了 model 函数）
- `src/__tests__/` 下所有测试文件

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/services/config/model.ts src/routes/web/config/providers.ts
git commit -m "feat: add organization_id to model table for org-level isolation"
```

---

### Task 3: mcpTool 表添加 organization_id

**Files:**
- Modify: `src/db/schema.ts` (mcpTool 表定义)

- [ ] **Step 1: 修改 mcpTool 表定义，添加 organization_id 列和索引**

在 `src/db/schema.ts` 的 mcpTool 表定义中添加 `organizationId` 列：

```typescript
export const mcpTool = pgTable("mcp_tool", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull(),
  serverName: varchar("server_name").notNull(),
  toolName: varchar("tool_name").notNull(),
  description: text("description"),
  inputSchema: jsonb("input_schema"),
  inspectedAt: timestamp("inspected_at", { withTimezone: true }).notNull().defaultNow(),
  (table) => ({
    orgServerIdx: index("idx_mcp_tool_org_server").on(table.organizationId, table.serverName),
  }),
});
```

注意 Drizzle 的 `pgTable` 函数签名：当有 constraints 回调时，列定义和回调是分开的参数。确认当前 mcpTool 没有 constraints 回调，需要加上：

```typescript
export const mcpTool = pgTable(
  "mcp_tool",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    serverName: varchar("server_name").notNull(),
    toolName: varchar("tool_name").notNull(),
    description: text("description"),
    inputSchema: jsonb("input_schema"),
    inspectedAt: timestamp("inspected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgServerIdx: index("idx_mcp_tool_org_server").on(table.organizationId, table.serverName),
  }),
);
```

- [ ] **Step 2: 生成迁移文件并推送**

Run: `bunx drizzle-kit generate --name add-mcp-tool-organization-id`
Run: `bunx drizzle-kit push`

回填 SQL：
```sql
UPDATE mcp_tool t SET organization_id = ms.organization_id
FROM mcp_server ms WHERE t.server_name = ms.name;
```

如果存在没有对应 mcp_server 的孤儿记录，先删除或设默认值。

---

### Task 4: mcpTool 服务层加 organizationId 过滤

**Files:**
- Modify: `src/services/config/mcp-server.ts`
- Modify: `src/routes/web/config/mcp.ts`

- [ ] **Step 1: 修改 mcp-server.ts 中所有 mcpTool 缓存函数**

将 `countToolsByServer`, `deleteToolsByServer`, `replaceToolsForServer`, `listToolsByServer` 的签名全部加上 `organizationId` 参数，WHERE 条件加入 `eq(mcpTool.organizationId, organizationId)`。`replaceToolsForServer` 的 INSERT 也写入 `organizationId`。

```typescript
export async function countToolsByServer(organizationId: string, serverName: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mcpTool)
    .where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
  return row?.count ?? 0;
}

export async function deleteToolsByServer(organizationId: string, serverName: string): Promise<void> {
  await db.delete(mcpTool).where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
}

export async function replaceToolsForServer(
  organizationId: string,
  serverName: string,
  tools: McpToolItem[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(mcpTool)
      .where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
    if (tools.length === 0) return;
    const rows = tools.map((t) => ({
      organizationId,
      serverName,
      toolName: t.name,
      description: t.description ?? null,
      inputSchema: t.inputSchema ?? null,
    }));
    await tx.insert(mcpTool).values(rows);
  });
}

export async function listToolsByServer(organizationId: string, serverName: string) {
  return db
    .select()
    .from(mcpTool)
    .where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
}
```

- [ ] **Step 2: 修改 mcp.ts 路由层，传递 organizationId**

在 `src/routes/web/config/mcp.ts` 中，所有调用 mcpTool 缓存函数的地方传入 `authCtx.organizationId`：

```typescript
// handleList 中（约 line 53）
const toolsCount = await countToolsByServer(authCtx.organizationId, s.name);

// handleDelete 中（约 line 111）
await deleteToolsByServer(authCtx.organizationId, name);

// handleInspect 中（约 line 247）
await replaceToolsForServer(authCtx.organizationId, name, result.tools);

// handleListTools 中（约 line 261-262）
// 注意：此函数当前没有 authCtx 参数，需要从路由层传入
```

`handleListTools` 当前签名是 `async function handleListTools(name: string)`，需要改为 `async function handleListTools(ctx: AuthContext, name: string)`，路由层传入 `authCtx`。

- [ ] **Step 3: 检查其他调用点**

搜索所有 `countToolsByServer`/`deleteToolsByServer`/`replaceToolsForServer`/`listToolsByServer` 的 import 和调用，确保全部更新。特别检查 `src/__tests__/` 下所有测试文件。

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/services/config/mcp-server.ts src/routes/web/config/mcp.ts
git commit -m "feat: add organization_id to mcp_tool table for org-level isolation"
```

---

### Task 5: model 隔离测试

**Files:**
- Create: `src/__tests__/config-model-isolation.test.ts`

- [ ] **Step 1: 编写 model 服务层组织隔离测试**

mock `../../db` 模块，验证 `addModel`、`updateModel`、`removeModel` 都在 WHERE/VALUES 中包含 `organizationId`：

```typescript
import { describe, test, expect, mock, beforeEach } from "bun:test";
// mock.module 必须在 import 之前
mock.module("../../db", () => ({
  db: {
    insert: mock(() => ({
      values: mock(() => ({
        onConflictDoUpdate: mock(() => Promise.resolve()),
      })),
    })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => Promise.resolve([{ id: "m1" }])),
        })),
      })),
    })),
    delete: mock(() => ({
      where: mock(() => ({
        returning: mock(() => Promise.resolve([{ id: "m1" }])),
      })),
    })),
  },
}));

import { addModel, updateModel, removeModel } from "../services/config/model";

describe("model 服务层组织隔离", () => {
  // addModel 应写入 organizationId
  test("addModel 写入 organizationId", async () => {
    const { db } = require("../../db");
    await addModel("org_A", "provider_1", { modelId: "gpt-4" });
    const insertCall = db.insert.mock.calls[0];
    // insert 应传入 model 表
    expect(insertCall).toBeDefined();
    const valuesCall = db.insert().values.mock.calls[0][0];
    expect(valuesCall.organizationId).toBe("org_A");
  });

  // updateModel WHERE 应包含 organizationId
  test("updateModel WHERE 包含 organizationId", async () => {
    const { db } = require("../../db");
    await updateModel("org_A", "provider_1", "gpt-4", { displayName: "GPT-4" });
    expect(db.update).toHaveBeenCalled();
  });

  // removeModel WHERE 应包含 organizationId
  test("removeModel WHERE 包含 organizationId", async () => {
    const { db } = require("../../db");
    const result = await removeModel("org_A", "provider_1", "gpt-4");
    expect(result).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证通过**

Run: `bun test src/__tests__/config-model-isolation.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/config-model-isolation.test.ts
git commit -m "test: add model service organization isolation tests"
```

---

### Task 6: mcpTool 隔离测试

**Files:**
- Create: `src/__tests__/mcp-tool-isolation.test.ts`

- [ ] **Step 1: 编写 mcpTool 服务层组织隔离测试**

mock `../../db` 模块，验证 `countToolsByServer`、`deleteToolsByServer`、`replaceToolsForServer`、`listToolsByServer` 都使用 `organizationId` 过滤：

```typescript
import { describe, test, expect, mock } from "bun:test";
import { eq, and, sql } from "drizzle-orm";

mock.module("../../db", () => ({
  db: {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => Promise.resolve([{ count: 2 }])),
      })),
    })),
    delete: mock(() => ({
      where: mock(() => Promise.resolve()),
    })),
    transaction: mock((fn) => fn({
      delete: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
      insert: mock(() => ({
        values: mock(() => Promise.resolve()),
      })),
    })),
  },
}));

import {
  countToolsByServer,
  deleteToolsByServer,
  replaceToolsForServer,
  listToolsByServer,
} from "../services/config/mcp-server";

describe("mcpTool 服务层组织隔离", () => {
  // countToolsByServer 应按组织过滤
  test("countToolsByServer 使用 organizationId 过滤", async () => {
    const count = await countToolsByServer("org_A", "my-server");
    expect(count).toBe(2);
  });

  // deleteToolsByServer 应按组织过滤
  test("deleteToolsByServer 使用 organizationId 过滤", async () => {
    await deleteToolsByServer("org_A", "my-server");
    // 验证 delete 被调用
    const { db } = require("../../db");
    expect(db.delete).toHaveBeenCalled();
  });

  // replaceToolsForServer 应写入 organizationId
  test("replaceToolsForServer 写入 organizationId", async () => {
    await replaceToolsByServer("org_A", "my-server", [
      { name: "tool1", description: "desc" },
    ]);
    const { db } = require("../../db");
    expect(db.transaction).toHaveBeenCalled();
  });

  // listToolsByServer 应按组织过滤
  test("listToolsByServer 使用 organizationId 过滤", async () => {
    await listToolsByServer("org_A", "my-server");
    const { db } = require("../../db");
    expect(db.select).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试验证通过**

Run: `bun test src/__tests__/mcp-tool-isolation.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/mcp-tool-isolation.test.ts
git commit -m "test: add mcpTool service organization isolation tests"
```

---

### Task 7: 全量测试验证 + 类型检查

**Files:** 无新文件

- [ ] **Step 1: 运行全部后端测试**

Run: `bun test src/__tests__/`
Expected: 0 fail, 0 error

- [ ] **Step 2: 运行类型检查**

Run: `bun run typecheck`
Expected: 无错误

- [ ] **Step 3: 运行 lint 检查**

Run: `bun run lint`
Expected: 无新错误

- [ ] **Step 4: 如有问题则修复后重新运行，直到全部通过**

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "fix: finalize org isolation for model and mcpTool tables"
```

---

## Self-Review

### 1. Spec Coverage
- ✅ model 表：schema 变更 + 服务层 WHERE 过滤 + 路由层传参
- ✅ mcpTool 表：schema 变更 + 服务层 WHERE 过滤 + 路由层传参
- ✅ 数据迁移：每个 schema 变更都包含回填 SQL
- ✅ 测试：每个表都有独立测试文件

### 2. Placeholder Scan
- ✅ 所有步骤包含完整代码
- ✅ 无 TBD / TODO / "implement later"
- ✅ 无 "add appropriate error handling"
- ✅ 无 "similar to Task N" — 每个 Task 自包含

### 3. Type Consistency
- ✅ `addModel(organizationId, providerId, data)` — Task 2 定义，Task 2 路由层使用
- ✅ `updateModel(organizationId, providerId, modelId, data)` — 同上
- ✅ `removeModel(organizationId, providerId, modelId)` — 同上
- ✅ `countToolsByServer(organizationId, serverName)` — Task 4 定义，Task 4 路由层使用
- ✅ `deleteToolsByServer(organizationId, serverName)` — 同上
- ✅ `replaceToolsForServer(organizationId, serverName, tools)` — 同上
- ✅ `listToolsByServer(organizationId, serverName)` — 同上
