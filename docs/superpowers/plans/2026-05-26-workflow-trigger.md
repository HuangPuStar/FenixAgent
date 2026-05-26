# Workflow Trigger 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Workflow 引入 public webhook 触发器，外部服务（如 GitHub）可通过 hash URL 触发 workflow 执行。

**Architecture:** 新增 `workflow_trigger` 表存储触发器映射（hash → workflowId），新增 `/hooks/:publicHash` 端点（无认证）接收外部 POST 请求并异步触发 workflow engine run。管理接口通过现有 `/web/workflow-defs` 路由的 action 分发机制扩展。

**Tech Stack:** Drizzle ORM (schema + migration)、Elysia (route)、Zod v4 (validation)、Bun test

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/db/schema.ts` | 新增 `workflowTrigger` 表定义 |
| `drizzle/` | `drizzle-kit generate` 生成迁移 |
| `src/repositories/workflow-trigger.ts` | **新建**：trigger 数据访问层（接口 + 实现） |
| `src/repositories/index.ts` | 导出新 repository |
| `src/services/workflow-trigger.ts` | **新建**：trigger 业务逻辑（创建/删除/regenerate/触发） |
| `src/routes/hooks.ts` | **新建**：`POST /hooks/:publicHash` 无认证端点 |
| `src/routes/web/workflow-defs.ts` | 扩展 action 分发：createTrigger / listTriggers / deleteTrigger / regenerateHash / enableTrigger / disableTrigger |
| `src/index.ts` | 挂载 `/hooks/*` 路由 |
| `src/__tests__/workflow-trigger.test.ts` | **新建**：repository + service + hooks 路由测试 |

---

### Task 1: Schema — 新增 workflow_trigger 表

**Files:**
- Modify: `src/db/schema.ts` (在文件末尾 `userConfig` 表之后追加)
- Create: `drizzle/` 迁移文件（通过 `drizzle-kit generate` 生成）

- [ ] **Step 1: 在 `src/db/schema.ts` 末尾追加 workflowTrigger 表定义**

在 `userConfig` 表定义之后追加：

```typescript
// ────────────────────────────────────────────
// Workflow Trigger（外部触发器）
// ────────────────────────────────────────────

export const workflowTrigger = pgTable(
  "workflow_trigger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 30 }).notNull().default("webhook"),
    publicHash: varchar("public_hash", { length: 64 }).notNull().unique(),
    secret: varchar("secret"),
    config: jsonb("config"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hashIdx: uniqueIndex("idx_workflow_trigger_hash").on(table.publicHash),
    orgWorkflowIdx: index("idx_workflow_trigger_org_workflow").on(table.organizationId, table.workflowId),
  }),
);
```

- [ ] **Step 2: 生成迁移文件**

Run: `bunx drizzle-kit generate --name workflow_trigger`

Expected: `drizzle/` 目录下生成新迁移 SQL 文件，包含 `workflow_trigger` 表的 CREATE TABLE 语句

- [ ] **Step 3: 同步到开发数据库**

Run: `bun run db:push`

Expected: 无错误输出，数据库已包含 `workflow_trigger` 表

- [ ] **Step 4: 提交**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: 新增 workflow_trigger 表定义"
```

---

### Task 2: Repository — workflow-trigger 数据访问层

**Files:**
- Create: `src/repositories/workflow-trigger.ts`
- Modify: `src/repositories/index.ts`
- Create: `src/__tests__/workflow-trigger-repo.test.ts`

- [ ] **Step 1: 写 repository 测试**

创建 `src/__tests__/workflow-trigger-repo.test.ts`：

```typescript
import { afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

// mock db
mock.module("../db", () => {
  const chain: Record<string, any> = {};
  const selectReturn = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain };
  chain.where = () => chain;
  chain.orderBy = () => chain;
  chain.limit = () => chain;
  chain.from = () => chain;
  const insertReturn = { values: () => ({ returning: () => Promise.resolve([]) }) };
  const updateReturn = { set: () => ({ where: () => Promise.resolve([]) }) };
  const deleteReturn = { where: () => ({ returning: () => Promise.resolve([]) }) };

  return {
    db: {
      select: () => selectReturn,
      insert: () => insertReturn,
      update: () => updateReturn,
      delete: () => deleteReturn,
    },
  };
});

// mock schema
mock.module("../db/schema", () => ({
  workflowTrigger: {
    id: "id",
    organizationId: "organization_id",
    workflowId: "workflow_id",
    type: "type",
    publicHash: "public_hash",
    secret: "secret",
    config: "config",
    enabled: "enabled",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
}));

describe("workflow-trigger-repo", () => {
  // getByHash 能被导入且类型正确
  test("repo exports are defined", async () => {
    const mod = await import("../repositories/workflow-trigger");
    expect(typeof mod.workflowTriggerRepo).toBe("object");
    expect(typeof mod.workflowTriggerRepo.getByHash).toBe("function");
    expect(typeof mod.workflowTriggerRepo.create).toBe("function");
    expect(typeof mod.workflowTriggerRepo.delete).toBe("function");
    expect(typeof mod.workflowTriggerRepo.update).toBe("function");
    expect(typeof mod.workflowTriggerRepo.listByWorkflow).toBe("function");
    expect(typeof mod.workflowTriggerRepo.listByOrg).toBe("function");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/__tests__/workflow-trigger-repo.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 repository**

创建 `src/repositories/workflow-trigger.ts`：

```typescript
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { workflowTrigger } from "../db/schema";

export type WorkflowTriggerRow = typeof workflowTrigger.$inferSelect;
export type WorkflowTriggerInsert = typeof workflowTrigger.$inferInsert;

export interface IWorkflowTriggerRepo {
  getByHash(publicHash: string): Promise<WorkflowTriggerRow | null>;
  getById(id: string): Promise<WorkflowTriggerRow | null>;
  create(data: WorkflowTriggerInsert): Promise<WorkflowTriggerRow>;
  delete(id: string): Promise<boolean>;
  update(id: string, data: Partial<WorkflowTriggerInsert>): Promise<void>;
  listByWorkflow(workflowId: string): Promise<WorkflowTriggerRow[]>;
  listByOrg(organizationId: string): Promise<WorkflowTriggerRow[]>;
}

class PgWorkflowTriggerRepo implements IWorkflowTriggerRepo {
  async getByHash(publicHash: string): Promise<WorkflowTriggerRow | null> {
    const [row] = await db
      .select()
      .from(workflowTrigger)
      .where(eq(workflowTrigger.publicHash, publicHash))
      .limit(1);
    return row ?? null;
  }

  async getById(id: string): Promise<WorkflowTriggerRow | null> {
    const [row] = await db.select().from(workflowTrigger).where(eq(workflowTrigger.id, id)).limit(1);
    return row ?? null;
  }

  async create(data: WorkflowTriggerInsert): Promise<WorkflowTriggerRow> {
    const [row] = await db.insert(workflowTrigger).values(data).returning();
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(workflowTrigger)
      .where(eq(workflowTrigger.id, id))
      .returning({ id: workflowTrigger.id });
    return result.length > 0;
  }

  async update(id: string, data: Partial<WorkflowTriggerInsert>): Promise<void> {
    await db.update(workflowTrigger).set(data).where(eq(workflowTrigger.id, id));
  }

  async listByWorkflow(workflowId: string): Promise<WorkflowTriggerRow[]> {
    return db.select().from(workflowTrigger).where(eq(workflowTrigger.workflowId, workflowId)).orderBy(desc(workflowTrigger.createdAt));
  }

  async listByOrg(organizationId: string): Promise<WorkflowTriggerRow[]> {
    return db.select().from(workflowTrigger).where(eq(workflowTrigger.organizationId, organizationId)).orderBy(desc(workflowTrigger.createdAt));
  }
}

export const workflowTriggerRepo = new PgWorkflowTriggerRepo();
```

- [ ] **Step 4: 在 `src/repositories/index.ts` 中导出**

在文件顶部的 export type 块中追加：

```typescript
export type { IWorkflowTriggerRepo, WorkflowTriggerInsert, WorkflowTriggerRow } from "./workflow-trigger";
export { workflowTriggerRepo } from "./workflow-trigger";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test src/__tests__/workflow-trigger-repo.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/repositories/workflow-trigger.ts src/repositories/index.ts src/__tests__/workflow-trigger-repo.test.ts
git commit -m "feat: workflow trigger repository 层"
```

---

### Task 3: Service — trigger 业务逻辑

**Files:**
- Create: `src/services/workflow-trigger.ts`
- Create: `src/__tests__/workflow-trigger-service.test.ts`

- [ ] **Step 1: 写 service 测试**

创建 `src/__tests__/workflow-trigger-service.test.ts`：

```typescript
import { afterEach, describe, expect, mock, test } from "bun:test";

// mock repository
const mockRepo = {
  getByHash: mock(() => Promise.resolve(null)),
  getById: mock(() => Promise.resolve(null)),
  create: mock(() => Promise.resolve({} as any)),
  delete: mock(() => Promise.resolve(false)),
  update: mock(() => Promise.resolve()),
  listByWorkflow: mock(() => Promise.resolve([])),
  listByOrg: mock(() => Promise.resolve([])),
};

mock.module("../repositories/workflow-trigger", () => ({
  workflowTriggerRepo: mockRepo,
  __mockRepo: mockRepo,
}));

// mock config
mock.module("../config", () => ({
  config: { baseUrl: "http://localhost:3000" },
  getBaseUrl: () => "http://localhost:3000",
}));

// mock workflow engine
mock.module("../services/workflow", () => ({
  getTeamEngine: () => ({ run: mock(() => Promise.resolve({ runId: "run-1", status: "RUNNING" })) }),
}));

// mock workflow-def repo (getVersionYaml)
mock.module("../repositories/workflow-def", () => ({
  getVersionYaml: () => Promise.resolve("name: test\n"),
}));

describe("workflow-trigger-service", () => {
  afterEach(() => {
    mockRepo.getByHash.mockClear();
    mockRepo.getById.mockClear();
    mockRepo.create.mockClear();
    mockRepo.delete.mockClear();
    mockRepo.update.mockClear();
    mockRepo.listByWorkflow.mockClear();
  });

  // createTrigger 生成 hash 并调用 repo.create
  test("createTrigger generates hash and returns webhookUrl", async () => {
    const { createTrigger } = await import("../services/workflow-trigger");
    mockRepo.create.mockImplementation(async (data: any) => ({
      id: "trig-1",
      organizationId: data.organizationId,
      workflowId: data.workflowId,
      type: data.type,
      publicHash: data.publicHash,
      secret: data.secret ?? null,
      config: data.config ?? null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const result = await createTrigger({
      organizationId: "org-1",
      workflowId: "wf-1",
      type: "webhook",
      userId: "user-1",
    });

    expect(result.webhookUrl).toContain("/hooks/");
    expect(result.publicHash).toBeDefined();
    expect(result.publicHash.length).toBeGreaterThanOrEqual(32);
    expect(mockRepo.create).toHaveBeenCalled();
  });

  // maskHash 只显示前 6 位
  test("maskHash returns first 6 chars + ***", async () => {
    const { maskHash } = await import("../services/workflow-trigger");
    expect(maskHash("abcdef1234567890")).toBe("abcdef***");
    expect(maskHash("short")).toBe("short***");
  });

  // deleteTrigger 校验归属后删除
  test("deleteTrigger returns false when trigger not found", async () => {
    const { deleteTrigger } = await import("../services/workflow-trigger");
    mockRepo.getById.mockResolvedValueOnce(null);
    const result = await deleteTrigger("trig-1", "org-1");
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/__tests__/workflow-trigger-service.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 service**

创建 `src/services/workflow-trigger.ts`：

```typescript
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { workflowTriggerRepo } from "../repositories/workflow-trigger";
import type { WorkflowTriggerRow } from "../repositories/workflow-trigger";
import { getBaseUrl } from "./config";

// ── 类型 ──

export interface CreateTriggerInput {
  organizationId: string;
  workflowId: string;
  type: string;
  userId: string;
  config?: Record<string, unknown>;
}

export interface TriggerView {
  id: string;
  workflowId: string;
  type: string;
  publicHash: string;
  maskedHash: string;
  webhookUrl: string | null;
  secret: string | null;
  config: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── 辅助 ──

/** 生成 32 字节 hex hash */
export function generateHash(): string {
  return randomBytes(32).toString("hex");
}

/** masked 展示：前 6 位 + *** */
export function maskHash(hash: string): string {
  if (hash.length <= 6) return `${hash}***`;
  return `${hash.slice(0, 6)}***`;
}

/** 构造完整 webhook URL */
function buildWebhookUrl(publicHash: string): string {
  return `${getBaseUrl()}/hooks/${publicHash}`;
}

/** 将行转换为视图（masked hash，不含完整 webhookUrl） */
export function rowToMaskedView(row: WorkflowTriggerRow): TriggerView {
  return {
    id: row.id,
    workflowId: row.workflowId,
    type: row.type,
    publicHash: maskHash(row.publicHash),
    maskedHash: maskHash(row.publicHash),
    webhookUrl: null,
    secret: row.secret ?? null,
    config: (row.config as Record<string, unknown>) ?? null,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 将行转换为完整视图（含完整 webhookUrl，仅在 create/regenerate 时使用） */
function rowToFullView(row: WorkflowTriggerRow): TriggerView {
  return {
    ...rowToMaskedView(row),
    publicHash: row.publicHash,
    webhookUrl: buildWebhookUrl(row.publicHash),
  };
}

// ── CRUD ──

export async function createTrigger(input: CreateTriggerInput): Promise<TriggerView> {
  const publicHash = generateHash();
  const row = await workflowTriggerRepo.create({
    organizationId: input.organizationId,
    workflowId: input.workflowId,
    type: input.type,
    publicHash,
    enabled: true,
    config: input.config ?? null,
  });
  return rowToFullView(row);
}

export async function listTriggers(workflowId: string): Promise<TriggerView[]> {
  const rows = await workflowTriggerRepo.listByWorkflow(workflowId);
  return rows.map(rowToMaskedView);
}

export async function deleteTrigger(triggerId: string, organizationId: string): Promise<boolean> {
  const row = await workflowTriggerRepo.getById(triggerId);
  if (!row || row.organizationId !== organizationId) return false;
  return workflowTriggerRepo.delete(triggerId);
}

export async function regenerateHash(triggerId: string, organizationId: string): Promise<TriggerView | null> {
  const row = await workflowTriggerRepo.getById(triggerId);
  if (!row || row.organizationId !== organizationId) return null;
  const newHash = generateHash();
  await workflowTriggerRepo.update(triggerId, { publicHash: newHash, updatedAt: new Date() });
  const updated = await workflowTriggerRepo.getById(triggerId);
  return updated ? rowToFullView(updated) : null;
}

export async function enableTrigger(triggerId: string, organizationId: string): Promise<boolean> {
  const row = await workflowTriggerRepo.getById(triggerId);
  if (!row || row.organizationId !== organizationId) return false;
  await workflowTriggerRepo.update(triggerId, { enabled: true, updatedAt: new Date() });
  return true;
}

export async function disableTrigger(triggerId: string, organizationId: string): Promise<boolean> {
  const row = await workflowTriggerRepo.getById(triggerId);
  if (!row || row.organizationId !== organizationId) return false;
  await workflowTriggerRepo.update(triggerId, { enabled: false, updatedAt: new Date() });
  return true;
}

// ── Webhook 处理 ──

export interface WebhookPayload {
  headers: Record<string, string>;
  body: unknown;
  query: Record<string, string>;
  triggerType: string;
}

/**
 * 处理 webhook 请求：查 hash → 验证 trigger → 异步触发 workflow。
 * 返回 true 表示已接受，false 表示 trigger 未找到/disabled。
 */
export async function handleWebhookRequest(
  publicHash: string,
  headers: Record<string, string>,
  body: unknown,
  query: Record<string, string>,
): Promise<{ accepted: boolean; error?: string }> {
  const row = await workflowTriggerRepo.getByHash(publicHash);
  if (!row || !row.enabled) return { accepted: false, error: "trigger not found" };

  // 异步触发 workflow，不等待完成
  const inputs: WebhookPayload = {
    headers,
    body,
    query,
    triggerType: row.type,
  };

  // fire-and-forget：不 await engine.run 完成
  triggerWorkflow(row.organizationId, row.workflowId, inputs).catch((err) => {
    console.error(`[workflow-trigger] Failed to trigger workflow ${row.workflowId}:`, err);
  });

  return { accepted: true };
}

/** 触发 workflow 执行 */
async function triggerWorkflow(organizationId: string, workflowId: string, inputs: WebhookPayload): Promise<void> {
  const { getTeamEngine } = await import("./workflow");
  const { getVersionYaml } = await import("../repositories/workflow-def");

  const engine = getTeamEngine(organizationId);

  // 获取最新版本的 YAML
  const { db } = await import("../db");
  const { workflow } = await import("../db/schema");
  const [wf] = await db.select().from(workflow).where(eq(workflow.id, workflowId)).limit(1);
  if (!wf) throw new Error(`Workflow ${workflowId} not found`);

  const version = wf.latestVersion ?? 0;
  const yaml = await getVersionYaml(workflowId, version);
  if (!yaml) throw new Error(`No YAML found for workflow ${workflowId} version ${version}`);

  await engine.run(yaml, inputs);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/__tests__/workflow-trigger-service.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/workflow-trigger.ts src/__tests__/workflow-trigger-service.test.ts
git commit -m "feat: workflow trigger service 层"
```

---

### Task 4: Route — `/hooks/:publicHash` 无认证端点

**Files:**
- Create: `src/routes/hooks.ts`
- Modify: `src/index.ts` (挂载 hooks 路由)

- [ ] **Step 1: 实现 hooks 路由**

创建 `src/routes/hooks.ts`：

```typescript
/**
 * Webhook 接收端点。
 *
 * POST /hooks/:publicHash — 无需认证，通过 hash 标识 trigger。
 * 收到请求后异步触发对应 workflow，立即返回 200。
 */
import Elysia from "elysia";
import { handleWebhookRequest } from "../services/workflow-trigger";

const app = new Elysia({ name: "hooks" });

app.post("/hooks/:publicHash", async ({ params, request, body, query, error }) => {
  const { publicHash } = params as { publicHash: string };

  // 请求体大小检查（1MB）
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > 1024 * 1024) {
    return error(413, { error: "payload too large" });
  }

  // 提取 headers
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });

  // body 可能是 JSON 或文本
  let parsedBody: unknown = body;
  if (typeof body === "string") {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      parsedBody = body;
    }
  }

  // 提取 query params
  const url = new URL(request.url);
  const queryObj: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    queryObj[k] = v;
  });

  const result = await handleWebhookRequest(publicHash, headers, parsedBody, queryObj);

  if (!result.accepted) {
    return error(404, { error: result.error });
  }

  return { received: true };
});

export default app;
```

- [ ] **Step 2: 在 `src/index.ts` 中挂载 hooks 路由**

在 `import` 区域（约第 26 行附近）追加 import：

```typescript
import hooksRoutes from "./routes/hooks";
```

在路由挂载区域（`app.use(acpRoutes)` 之后），追加：

```typescript
// Webhook trigger routes (no auth)
.use(hooksRoutes);
```

- [ ] **Step 3: 验证编译通过**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无类型错误（或仅已有的无关错误）

- [ ] **Step 4: 提交**

```bash
git add src/routes/hooks.ts src/index.ts
git commit -m "feat: POST /hooks/:publicHash 无认证 webhook 端点"
```

---

### Task 5: Route — workflow-defs 扩展 trigger 管理 action

**Files:**
- Modify: `src/routes/web/workflow-defs.ts`

- [ ] **Step 1: 在 workflow-defs 路由中新增 trigger action 分发**

在 `src/routes/web/workflow-defs.ts` 文件顶部的 import 区域追加：

```typescript
import {
  createTrigger,
  deleteTrigger,
  disableTrigger,
  enableTrigger,
  listTriggers,
  regenerateHash,
} from "../../services/workflow-trigger";
```

在 `switch` 语句中 `default:` 之前，追加以下 case 分支：

```typescript
        case "createTrigger": {
          const workflowId = payload.workflowId as string;
          const type = (payload.type as string) || "webhook";
          const triggerConfig = payload.config as Record<string, unknown> | undefined;
          if (!workflowId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          }
          const trigger = await createTrigger({
            organizationId: authCtx.organizationId,
            workflowId,
            type,
            userId: authCtx.userId,
            config: triggerConfig,
          });
          return { success: true, data: trigger };
        }

        case "listTriggers": {
          const workflowId = payload.workflowId as string;
          if (!workflowId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          }
          const triggers = await listTriggers(workflowId);
          return { success: true, data: triggers };
        }

        case "deleteTrigger": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "triggerId is required" } });
          }
          const deleted = await deleteTrigger(triggerId, authCtx.organizationId);
          if (!deleted) return error(404, { error: { type: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true };
        }

        case "regenerateHash": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "triggerId is required" } });
          }
          const result = await regenerateHash(triggerId, authCtx.organizationId);
          if (!result) return error(404, { error: { type: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true, data: result };
        }

        case "enableTrigger": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "triggerId is required" } });
          }
          const ok = await enableTrigger(triggerId, authCtx.organizationId);
          if (!ok) return error(404, { error: { type: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true };
        }

        case "disableTrigger": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "triggerId is required" } });
          }
          const ok = await disableTrigger(triggerId, authCtx.organizationId);
          if (!ok) return error(404, { error: { type: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true };
        }
```

- [ ] **Step 2: 验证编译通过**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无新增类型错误

- [ ] **Step 3: 提交**

```bash
git add src/routes/web/workflow-defs.ts
git commit -m "feat: workflow-defs 新增 trigger 管理 action 分发"
```

---

### Task 6: 集成测试 — hooks 路由端到端验证

**Files:**
- Create: `src/__tests__/workflow-trigger-hooks.test.ts`

- [ ] **Step 1: 写 hooks 路由集成测试**

创建 `src/__tests__/workflow-trigger-hooks.test.ts`：

```typescript
import { describe, expect, mock, test } from "bun:test";

// mock service 层
const mockHandleResult = { accepted: true };
const mockHandleWebhookRequest = mock(() => Promise.resolve(mockHandleResult));

mock.module("../services/workflow-trigger", () => ({
  handleWebhookRequest: mockHandleWebhookRequest,
}));

describe("hooks route — POST /hooks/:publicHash", () => {
  // handleWebhookRequest 被正确调用
  test("delegates to handleWebhookRequest with correct params", async () => {
    const { handleWebhookRequest } = await import("../services/workflow-trigger");

    await handleWebhookRequest("abc123", { "x-github-event": "push" }, { ref: "refs/heads/main" }, {});

    expect(handleWebhookRequest).toHaveBeenCalledWith(
      "abc123",
      expect.objectContaining({ "x-github-event": "push" }),
      { ref: "refs/heads/main" },
      {},
    );
  });

  // trigger not found 返回 { accepted: false }
  test("returns not found for invalid hash", async () => {
    const { handleWebhookRequest } = await import("../services/workflow-trigger");
    mockHandleWebhookRequest.mockResolvedValueOnce({ accepted: false, error: "trigger not found" });

    const result = await handleWebhookRequest("nonexistent", {}, {}, {});
    expect(result.accepted).toBe(false);
    expect(result.error).toBe("trigger not found");
  });
});
```

- [ ] **Step 2: 运行全部 workflow-trigger 相关测试**

Run: `bun test src/__tests__/workflow-trigger`
Expected: 全部 PASS

- [ ] **Step 3: 提交**

```bash
git add src/__tests__/workflow-trigger-hooks.test.ts
git commit -m "test: workflow trigger hooks 路由集成测试"
```

---

### Task 7: Precheck 全量验证

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck`
Expected: 全部通过（format + import sort + tsc + biome check）

- [ ] **Step 2: 运行全部后端测试**

Run: `bun test src/__tests__/`
Expected: 全部通过

- [ ] **Step 3: 最终提交（如有 format 修复）**

```bash
git add -A
git commit -m "chore: precheck 修复"
```
