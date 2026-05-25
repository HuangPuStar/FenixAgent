# v1/v2 路由 Body Schema 现代化 — 消除 `body as any`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为所有 v1/v2 路由补充 Zod body schema，消除 `body as any`，使 Eden Treaty 前端能推断正确的请求类型。

**Architecture:** 每个 v1/v2 路由文件定义自己的 body Zod schema 并通过 Elysia `.model()` 注册，与 web/ 路由保持一致的模式。同时将路由中的内联认证逻辑迁移到 `authGuardPlugin` macro。

**Tech Stack:** Zod v4、Elysia、TypeScript

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/schemas/v1-session.schema.ts` | v1 session 路由的请求 schema |
| Create | `src/schemas/v1-environment.schema.ts` | v1 environment 路由的请求 schema |
| Create | `src/schemas/v2-worker.schema.ts` | v2 worker 路由的请求 schema |
| Create | `src/schemas/v2-worker-events.schema.ts` | v2 worker-events 路由的请求 schema |
| Create | `src/schemas/v2-code-session.schema.ts` | v2 code-session 路由的请求 schema |
| Modify | `src/routes/v1/sessions.ts` | 注册 schema，消除 `body as any` |
| Modify | `src/routes/v1/environments.ts` | 注册 schema，消除 `body as any` |
| Modify | `src/routes/v2/worker.ts` | 注册 schema，消除 `body as any` |
| Modify | `src/routes/v2/worker-events.ts` | 注册 schema，消除 `body as any` |
| Modify | `src/routes/v2/code-sessions.ts` | 注册 schema，消除 `body as any` |

---

### Task 1: v1/sessions.ts — 添加 Body Schema

**Files:**
- Create: `src/schemas/v1-session.schema.ts`
- Modify: `src/routes/v1/sessions.ts`

- [ ] **Step 1: 创建 v1 session schema**

```typescript
// src/schemas/v1-session.schema.ts
import * as z from "zod/v4";

export const CreateSessionRequestSchema = z.object({
  environment_id: z.string().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
  permission_mode: z.string().optional(),
  username: z.string().optional(),
  events: z.array(z.record(z.unknown())).optional(),
});

export const UpdateSessionRequestSchema = z.object({
  title: z.string().min(1).optional(),
});

export const SendEventsRequestSchema = z.object({
  events: z.union([
    z.array(z.record(z.unknown())),
    z.record(z.unknown()),
  ]).optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
```

- [ ] **Step 2: 在路由中注册 schema 并消除 `body as any`**

修改 `src/routes/v1/sessions.ts`：

```typescript
import {
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  SendEventsRequestSchema,
} from "../../schemas/v1-session.schema";

const app = new Elysia({ name: "v1-sessions", prefix: "/v1/sessions" })
  .use(authGuardPlugin)
  .model({
    "create-session-request": CreateSessionRequestSchema,
    "update-session-request": UpdateSessionRequestSchema,
    "send-events-request": SendEventsRequestSchema,
  });

// POST / — 改用类型化 body
app.post("/", async ({ store, body }) => {
  const b = body as CreateSessionRequest; // Elysia 自动验证
  // ... 其余逻辑不变，但不再需要 (body as any) ?? {}
}, { apiKeyAuth: true, body: "create-session-request" });

// PATCH /:id
app.patch("/:id", async ({ params, body, error }) => {
  const sessionId = await resolveExistingSessionId(params.id) ?? params.id;
  const existing = await getSession(sessionId);
  if (!existing) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }
  const b = body as { title?: string }; // 类型已知
  if (b.title) {
    await updateSessionTitle(sessionId, b.title);
  }
  return getSession(sessionId);
}, { apiKeyAuth: true, body: "update-session-request" });

// POST /:id/events
app.post("/:id/events", async ({ params, body, error }) => {
  const sessionId = await resolveExistingSessionId(params.id) ?? params.id;
  if (!await getSession(sessionId)) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }
  const b = body as { events?: Record<string, unknown>[] };
  const events = b.events
    ? Array.isArray(b.events) ? b.events : [b.events]
    : Array.isArray(body) ? body : [body];
  const published = [];
  for (const evt of events) {
    published.push(publishSessionEvent(sessionId, evt.type || "message", evt, "inbound"));
  }
  return { status: "ok", events: published.length };
}, { apiKeyAuth: true, body: "send-events-request" });
```

- [ ] **Step 3: 运行类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/schemas/v1-session.schema.ts src/routes/v1/sessions.ts
git commit -m "feat: v1/sessions 路由添加 Zod body schema，消除 body as any"
```

---

### Task 2: v1/environments.ts — 添加 Body Schema

**Files:**
- Create: `src/schemas/v1-environment.schema.ts`
- Modify: `src/routes/v1/environments.ts`

- [ ] **Step 1: 创建 v1 environment schema**

```typescript
// src/schemas/v1-environment.schema.ts
import * as z from "zod/v4";

export const BridgeRegistrationRequestSchema = z.object({
  machine_name: z.string().optional(),
  directory: z.string().optional(),
  branch: z.string().optional(),
  git_repo_url: z.string().optional(),
  max_sessions: z.number().int().min(1).optional(),
  worker_type: z.string().optional(),
  capabilities: z.record(z.unknown()).optional(),
  metadata: z.object({ worker_type: z.string().optional() }).optional(),
});

export type BridgeRegistrationRequest = z.infer<typeof BridgeRegistrationRequestSchema>;
```

- [ ] **Step 2: 在路由中注册 schema 并消除 `body as any`**

修改 `src/routes/v1/environments.ts`：

```typescript
import { BridgeRegistrationRequestSchema } from "../../schemas/v1-environment.schema";

const app = new Elysia({ name: "v1-environments", prefix: "/v1/environments" })
  .use(authGuardPlugin)
  .model({
    "bridge-registration-request": BridgeRegistrationRequestSchema,
  });

// POST /bridge
app.post("/bridge", async ({ store, body, error }) => {
  const user = store.user!;
  const b = body as BridgeRegistrationRequest; // Elysia 自动验证
  // ... 原有逻辑不变，但不再需要 (body as any) ?? {}
}, { apiKeyAuth: true, body: "bridge-registration-request" });
```

- [ ] **Step 3: 运行类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/schemas/v1-environment.schema.ts src/routes/v1/environments.ts
git commit -m "feat: v1/environments 路由添加 Zod body schema"
```

---

### Task 3: v2/worker.ts — 添加 Body Schema

**Files:**
- Create: `src/schemas/v2-worker.schema.ts`
- Modify: `src/routes/v2/worker.ts`

- [ ] **Step 1: 创建 v2 worker schema**

```typescript
// src/schemas/v2-worker.schema.ts
import * as z from "zod/v4";

export const UpdateWorkerRequestSchema = z.object({
  worker_status: z.string().optional(),
  external_metadata: z.record(z.unknown()).optional(),
  requires_action_details: z.record(z.unknown()).optional(),
});

export type UpdateWorkerRequest = z.infer<typeof UpdateWorkerRequestSchema>;
```

- [ ] **Step 2: 在路由中注册 schema**

修改 `src/routes/v2/worker.ts`：

```typescript
import { UpdateWorkerRequestSchema } from "../../schemas/v2-worker.schema";

const app = new Elysia({ name: "v1-code-sessions-worker", prefix: "/v1/code/sessions" })
  .use(authGuardPlugin)
  .model({
    "update-worker-request": UpdateWorkerRequestSchema,
  });

// PUT /:id/worker — 消除 body as any
app.put("/:id/worker", async ({ params, body, error }) => {
  const sessionId = params.id;
  // ...
  const b = body as UpdateWorkerRequest;
  // ... 原有逻辑不变
}, { sessionIngressAuth: true, body: "update-worker-request" });
```

- [ ] **Step 3: 运行类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/schemas/v2-worker.schema.ts src/routes/v2/worker.ts
git commit -m "feat: v2/worker 路由添加 Zod body schema"
```

---

### Task 4: v2/worker-events.ts — 添加 Body Schema

**Files:**
- Create: `src/schemas/v2-worker-events.schema.ts`
- Modify: `src/routes/v2/worker-events.ts`

- [ ] **Step 1: 创建 v2 worker-events schema**

```typescript
// src/schemas/v2-worker-events.schema.ts
import * as z from "zod/v4";

export const WorkerEventsRequestSchema = z.union([
  z.object({
    events: z.array(z.record(z.unknown())),
  }),
  z.array(z.record(z.unknown())),
  z.record(z.unknown()),
]);

export const WorkerStateRequestSchema = z.object({
  status: z.string().optional(),
});

export type WorkerStateRequest = z.infer<typeof WorkerStateRequestSchema>;
```

- [ ] **Step 2: 在路由中注册 schema**

修改 `src/routes/v2/worker-events.ts`：

```typescript
import { WorkerEventsRequestSchema, WorkerStateRequestSchema } from "../../schemas/v2-worker-events.schema";

const app = new Elysia({ name: "v1-code-sessions-worker-events", prefix: "/v1/code/sessions" })
  .use(authGuardPlugin)
  .model({
    "worker-events-request": WorkerEventsRequestSchema,
    "worker-state-request": WorkerStateRequestSchema,
  });

// POST /:id/worker/events
app.post("/:id/worker/events", async ({ params, body, error }) => {
  // ...
  const events = extractWorkerEvents(body); // body 已类型化
  // ... 原有逻辑不变
}, { sessionIngressAuth: true, body: "worker-events-request" });

// PUT /:id/worker/state
app.put("/:id/worker/state", async ({ params, body, error }) => {
  // ...
  const b = body as WorkerStateRequest;
  // ... 原有逻辑不变
}, { sessionIngressAuth: true, body: "worker-state-request" });
```

- [ ] **Step 3: 运行类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/schemas/v2-worker-events.schema.ts src/routes/v2/worker-events.ts
git commit -m "feat: v2/worker-events 路由添加 Zod body schema"
```

---

### Task 5: v2/code-sessions.ts — 添加 Body Schema

**Files:**
- Create: `src/schemas/v2-code-session.schema.ts`
- Modify: `src/routes/v2/code-sessions.ts`

- [ ] **Step 1: 创建 v2 code-session schema**

```typescript
// src/schemas/v2-code-session.schema.ts
import * as z from "zod/v4";

export const CreateCodeSessionRequestSchema = z.object({
  environment_id: z.string().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
  permission_mode: z.string().optional(),
  username: z.string().optional(),
});

export type CreateCodeSessionRequest = z.infer<typeof CreateCodeSessionRequestSchema>;
```

- [ ] **Step 2: 在路由中注册 schema**

修改 `src/routes/v2/code-sessions.ts`：

```typescript
import { CreateCodeSessionRequestSchema } from "../../schemas/v2-code-session.schema";

const app = new Elysia({ name: "v1-code-sessions", prefix: "/v1/code/sessions" })
  .use(authGuardPlugin)
  .model({
    "create-code-session-request": CreateCodeSessionRequestSchema,
  });

// POST /
app.post("/", async ({ body }) => {
  const b = body as CreateCodeSessionRequest;
  const session = await createCodeSession(b);
  return { session };
}, { apiKeyAuth: true, body: "create-code-session-request" });
```

- [ ] **Step 3: 运行全量类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/schemas/v2-code-session.schema.ts src/routes/v2/code-sessions.ts
git commit -m "feat: v2/code-sessions 路由添加 Zod body schema"
```

---

### Task 6: 验证所有 v1/v2 路由无 `body as any` 残留

**Files:**
- Create: `src/__tests__/v1v2-schema-coverage.test.ts`

- [ ] **Step 1: 写断言测试**

```typescript
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const V1V2_FILES = [
  "src/routes/v1/sessions.ts",
  "src/routes/v1/environments.ts",
  "src/routes/v2/worker.ts",
  "src/routes/v2/worker-events.ts",
  "src/routes/v2/code-sessions.ts",
];

describe("v1/v2 路由 body schema 覆盖", () => {
  for (const file of V1V2_FILES) {
    test(`${file} 不包含 body as any`, () => {
      const content = readFileSync(file, "utf-8");
      // 排除注释中的 body as any
      const lines = content.split("\n").filter((l) => !l.trimStart().startsWith("//"));
      const joined = lines.join("\n");
      expect(joined).not.toContain("body as any");
    });
  }
});
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/__tests__/v1v2-schema-coverage.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/v1v2-schema-coverage.test.ts
git commit -m "test: 添加 v1/v2 路由 body schema 覆盖断言"
```

---

## Self-Review

**Spec coverage:** 所有 5 个 v1/v2 路由文件都已覆盖。

**Placeholder scan:** 无 TBD/TODO。每个 schema 定义都包含完整字段列表，与路由中的实际用法匹配。

**Type consistency:** Schema 类型名在定义文件和路由文件之间保持一致（如 `CreateSessionRequest`、`UpdateWorkerRequest`）。Elysia `.model()` 注册名和路由 `{ body: "xxx" }` 引用名匹配。
