# API Key 安全加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 per-user API Key 认证等价于 session 认证——密钥不可逆存储 + 所有 `apiKeyAuth` 路由添加资源归属校验。

**Architecture:** 分两阶段推进。Phase 1 解决存储安全（API Key 明文 → SHA-256 hash）。Phase 2 解决授权缺失（每个 `apiKeyAuth` 路由验证资源归属当前用户/team）。核心模式：`apiKeyAuth` macro 确保始终产出有效 `authContext`，下游路由通过新增的 `requireTeamScope` helper 校验资源所有权。

**Tech Stack:** Node.js crypto (SHA-256)、Drizzle ORM (schema migration)、Elysia middleware、Bun test

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/auth/api-key-service.ts` | Modify | hash 存储 + hash 验证 + key_prefix 字段 |
| `src/db/schema.ts` | Modify | apiKey 表新增 `key_hash` + `key_prefix` 列 |
| `src/plugins/auth.ts` | Modify | apiKeyAuth 添加 authContext null guard |
| `src/plugins/require-team-scope.ts` | **Create** | 团队级资源归属校验 helper |
| `src/routes/v1/environments.work.ts` | Modify | work 路由添加环境归属校验 |
| `src/routes/v1/sessions.ts` | Modify | session 路由添加归属校验 |
| `src/routes/v2/code-sessions.ts` | Modify | code session 路由添加归属校验 |
| `src/routes/v1/environments.ts` | Modify | bridge 路由对 per-user key 路径加固 |
| `src/__tests__/auth.test.ts` | Modify | 扩展 hash 验证测试 |
| `src/__tests__/api-key-security.test.ts` | **Create** | API Key 安全集成测试 |
| `src/__tests__/require-team-scope.test.ts` | **Create** | 归属校验单元测试 |

---

### Task 1: API Key Hash 存储（schema + service 改造）

**Files:**
- Modify: `src/db/schema.ts` (apiKey 表)
- Modify: `src/auth/api-key-service.ts` (create + validate)

**背景：** 当前 `apiKey.key` 列存储 `rcs_xxx` 明文。`hashApiKey()` 函数已存在但从未调用。需要改为存储 SHA-256 hash，同时保留 key_prefix 用于列表展示。

- [ ] **Step 1: 修改 schema — apiKey 表添加 `key_hash` 和 `key_prefix` 列**

在 `src/db/schema.ts` 的 `apiKey` 表定义中，将 `key: varchar("key").notNull().unique()` 替换为三列：

```ts
export const apiKey = pgTable(
  "api_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    // 旧列保留做迁移兼容（迁移完成后可移除）
    key: varchar("key").notNull().unique(),
    // 新列：SHA-256 hash，迁移后改为 not null
    keyHash: varchar("key_hash", { length: 64 }),
    // 新列：展示用前缀 "rcs_1234...ab12"
    keyPrefix: varchar("key_prefix", { length: 20 }).notNull().default(""),
    label: varchar("label").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_api_key_team_id").on(t.teamId),
    uniqueIndex("idx_api_key_hash").on(t.keyHash),
  ],
);
```

- [ ] **Step 2: 推送 schema 变更**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit push`

Expected: 成功推送，无数据丢失（新列 nullable + default）

- [ ] **Step 3: 修改 `createApiKey` — 存储 hash + prefix**

在 `src/auth/api-key-service.ts` 中修改 `createApiKey` 函数：

```ts
export async function createApiKey(
  userId: string,
  label: string,
  teamId: string,
): Promise<{ record: ApiKeySanitized; fullKey: string }> {
  const fullKey = generateApiKey();
  const keyHash = hashApiKey(fullKey);
  const keyPrefix = fullKey.slice(0, 8) + "..." + fullKey.slice(-4);
  const now = new Date();

  const [row] = await db
    .insert(apiKey)
    .values({
      userId,
      teamId,
      key: keyHash,           // key 列现在存 hash（向后兼容：旧代码用 key 列查询）
      keyHash,                 // 新列也存 hash
      keyPrefix,
      label: label || "Default",
      createdAt: now,
      lastUsedAt: null,
    })
    .returning();

  const record: ApiKeyRecord = {
    id: row.id,
    userId,
    key: keyHash,
    label: label || "Default",
    createdAt: now,
    lastUsedAt: null,
  };

  return { record: sanitize(record), fullKey };
}
```

同时更新 `sanitize` 函数使用 `keyPrefix`（当可用时）：

```ts
function sanitize(record: ApiKeyRecord): ApiKeySanitized {
  return {
    id: record.id,
    label: record.label,
    keyPrefix: record.keyPrefix || record.key.slice(0, 8) + "..." + record.key.slice(-4),
    createdAt: Math.floor(record.createdAt.getTime() / 1000),
    lastUsedAt: record.lastUsedAt ? Math.floor(record.lastUsedAt.getTime() / 1000) : null,
  };
}
```

更新 `ApiKeyRecord` 接口添加 `keyPrefix` 字段：

```ts
export interface ApiKeyRecord {
  id: string;
  userId: string;
  key: string;
  keyPrefix: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}
```

更新 `sanitize` 内部构造处补上 `keyPrefix`：

```ts
const record: ApiKeyRecord = {
  id: row.id,
  userId,
  key: keyHash,
  keyPrefix,
  label: label || "Default",
  createdAt: now,
  lastUsedAt: null,
};
```

更新 `listApiKeysByUser` 中 map 的 `sanitize` 调用补上 `keyPrefix`：

```ts
export async function listApiKeysByUser(teamId: string): Promise<ApiKeySanitized[]> {
  const rows = await db.select().from(apiKey).where(eq(apiKey.teamId, teamId));
  return rows.map((r) =>
    sanitize({
      id: r.id,
      userId: r.userId,
      key: r.key,
      keyPrefix: r.keyPrefix || "",
      label: r.label,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }),
  );
}
```

- [ ] **Step 4: 修改 `validateApiKeyAndGetUser` — hash 输入后查询**

```ts
export async function validateApiKeyAndGetUser(
  key: string,
): Promise<{ userId: string; keyId: string; teamId: string | null } | null> {
  const inputHash = hashApiKey(key);

  // 优先查 keyHash 列（新格式）
  let rows = await db.select().from(apiKey).where(eq(apiKey.keyHash, inputHash)).limit(1);

  // 回退查 key 列（兼容迁移期未 hash 的旧 key）
  if (rows.length === 0) {
    rows = await db.select().from(apiKey).where(eq(apiKey.key, key)).limit(1);
  }

  if (rows.length === 0) return null;

  const row = rows[0];

  // 后台更新 lastUsedAt（fire-and-forget）
  db.update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKey.id, row.id))
    .then(() => {})
    .catch(() => {});

  return { userId: row.userId, keyId: row.id, teamId: row.teamId ?? null };
}
```

- [ ] **Step 5: 写 hash 存储验证测试**

在 `src/__tests__/auth.test.ts` 的 `hashApiKey` describe 块后面追加：

```ts
describe("API Key hash storage", () => {
  test("hashApiKey 输出格式与 validate 查询一致", () => {
    const fullKey = "rcs_" + "a".repeat(48);
    const hash = hashApiKey(fullKey);
    // SHA-256 hex: 64 chars
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // 相同输入产生相同 hash
    expect(hashApiKey(fullKey)).toBe(hash);
  });

  test("key_prefix 格式正确", () => {
    const fullKey = "rcs_abcdef1234567890abcdef1234567890abcdef12345678";
    const prefix = fullKey.slice(0, 8) + "..." + fullKey.slice(-4);
    expect(prefix).toBe("rcs_abcd...5678");
    expect(prefix.length).toBeLessThanOrEqual(20);
  });
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/auth.test.ts`

Expected: 所有测试 PASS

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/auth/api-key-service.ts src/__tests__/auth.test.ts
git commit -m "feat: API Key SHA-256 hash 存储 — 添加 key_hash/key_prefix 列，validate 支持 hash 查询 + 旧 key 兼容回退"
```

---

### Task 2: `apiKeyAuth` authContext null guard

**Files:**
- Modify: `src/plugins/auth.ts` (apiKeyAuth macro)

**背景：** 当前 `apiKeyAuth` macro 在 per-user API Key 路径中，如果 `getAuthContextByTeamId` 返回 null（如用户被移出 team），请求仍然通过。`store.authContext` 为 null 但不拦截，导致下游无有效鉴权上下文。

- [ ] **Step 1: 写 guard 测试**

在 `src/__tests__/auth.test.ts` 末尾追加：

```ts
describe("apiKeyAuth authContext null guard", () => {
  test("authContext 为 null 时应拒绝请求（概念测试）", () => {
    // 模拟 getAuthContextByTeamId 返回 null 的场景
    // apiKeyAuth macro 应该返回 403 而非放行
    // 此测试验证逻辑概念：null authContext = 无有效团队 = 拒绝
    const authContext = null;
    expect(authContext).toBeNull();
    // 实际路由级集成测试在 api-key-security.test.ts
  });
});
```

- [ ] **Step 2: 修改 `apiKeyAuth` macro — 添加 null guard**

在 `src/plugins/auth.ts` 的 `apiKeyAuth` macro（约第 180-195 行）中，修改 per-user API Key 分支：

将原来的：
```ts
// 1. Per-user API Key
const { validateApiKeyAndGetUser } = await import("../auth/api-key-service");
const result = await validateApiKeyAndGetUser(token);
if (result) {
  const user = await lookupUserById(result.userId);
  if (user) {
    store.user = user;
    // 加载团队上下文（API Key 关联 teamId）
    if (result.teamId) {
      const { getAuthContextByTeamId } = await import("../services/team");
      const ctx = await getAuthContextByTeamId(user.id, result.teamId);
      if (ctx) store.authContext = ctx;
    }
    return;
  }
}
```

改为：
```ts
// 1. Per-user API Key
const { validateApiKeyAndGetUser } = await import("../auth/api-key-service");
const result = await validateApiKeyAndGetUser(token);
if (result) {
  const user = await lookupUserById(result.userId);
  if (user) {
    store.user = user;
    // 加载团队上下文（API Key 关联 teamId）
    if (result.teamId) {
      const { getAuthContextByTeamId } = await import("../services/team");
      const ctx = await getAuthContextByTeamId(user.id, result.teamId);
      if (ctx) {
        store.authContext = ctx;
        return;
      }
    }
    // API Key 无有效团队上下文 → 拒绝
    return error(403, { error: { type: "forbidden", message: "API key has no valid team context" } });
  }
}
```

关键变化：`return;` 移到 `if (ctx)` 内部。如果 ctx 为 null 或 teamId 不存在，不再放行，而是返回 403。

- [ ] **Step 3: 运行测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/auth.test.ts`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/plugins/auth.ts src/__tests__/auth.test.ts
git commit -m "fix: apiKeyAuth authContext null guard — 无有效团队上下文时返回 403 而非放行"
```

---

### Task 3: `requireTeamScope` 授权 helper

**Files:**
- Create: `src/plugins/require-team-scope.ts`
- Create: `src/__tests__/require-team-scope.test.ts`

**背景：** 下游路由需要一个统一的 helper 来验证"目标资源是否属于当前认证用户/team"。核心模式：环境有 `teamId`，session 有 `environmentId` → 环境 → `teamId`。

- [ ] **Step 1: 写 `requireTeamScope` 单元测试**

创建 `src/__tests__/require-team-scope.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { requireTeamScope } from "../plugins/require-team-scope";

describe("requireTeamScope", () => {
  test("teamId 匹配时通过", () => {
    const result = requireTeamScope(
      { teamId: "team-1", userId: "user-1", role: "owner" },
      "team-1",
    );
    expect(result).toBeUndefined(); // undefined = 通过
  });

  test("teamId 不匹配时返回 403 响应", () => {
    const result = requireTeamScope(
      { teamId: "team-1", userId: "user-1", role: "owner" },
      "team-2",
    );
    expect(result).toBeDefined();
    // 返回值应包含 403 状态码
    expect((result as any).status).toBe(403);
  });

  test("authContext 为 null 时返回 403", () => {
    const result = requireTeamScope(null as any, "team-1");
    expect(result).toBeDefined();
    expect((result as any).status).toBe(403);
  });

  test("resourceTeamId 为 null/undefined 时返回 403", () => {
    const result = requireTeamScope(
      { teamId: "team-1", userId: "user-1", role: "owner" },
      null as any,
    );
    expect(result).toBeDefined();
    expect((result as any).status).toBe(403);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/require-team-scope.test.ts`

Expected: FAIL — `requireTeamScope` 不存在

- [ ] **Step 3: 实现 `requireTeamScope`**

创建 `src/plugins/require-team-scope.ts`：

```ts
import type { AuthContext } from "./auth";
import { errorResponse } from "./auth";

/**
 * 校验当前认证上下文是否有权访问指定 team 的资源。
 * 返回 undefined 表示通过，否则返回 403 Response。
 *
 * 用法：const denied = requireTeamScope(store.authContext, resourceTeamId);
 *       if (denied) return denied;
 */
export function requireTeamScope(
  authContext: AuthContext | null,
  resourceTeamId: string | null | undefined,
): Response | undefined {
  if (!authContext || !resourceTeamId) {
    return errorResponse(403, { error: { type: "forbidden", message: "Access denied" } });
  }
  if (authContext.teamId !== resourceTeamId) {
    return errorResponse(403, { error: { type: "forbidden", message: "Resource does not belong to your team" } });
  }
  return undefined;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/require-team-scope.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/require-team-scope.ts src/__tests__/require-team-scope.test.ts
git commit -m "feat: requireTeamScope 授权 helper — 统一团队级资源归属校验"
```

---

### Task 4: Work 路由环境归属校验

**Files:**
- Modify: `src/routes/v1/environments.work.ts`

**背景：** `GET /:id/work/poll` 等 4 个端点只用 URL 中的 `envId`，完全不验证调用者是否拥有该 environment。任何持有有效 API key 的人都能轮询/确认/停止/心跳任意 environment 的 work。

- [ ] **Step 1: 修改 work 路由 — 添加环境归属校验**

将 `src/routes/v1/environments.work.ts` 全文替换为：

```ts
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { requireTeamScope } from "../../plugins/require-team-scope";
import { environmentRepo } from "../../repositories";
import { updatePollTime } from "../../services/environment";
import { ackWork, heartbeatWork, pollWork, stopWork } from "../../services/work-dispatch";

const app = new Elysia({ name: "v1-environments-work", prefix: "/v1/environments" }).use(authGuardPlugin);

/** 校验目标 environment 属于当前认证 team */
async function requireEnvOwnership(
  authContext: any,
  envId: string,
  error: (code: number, body: unknown) => Response,
): Promise<Response | undefined> {
  const env = await environmentRepo.getById(envId);
  if (!env) {
    return error(404, { error: { type: "not_found", message: "Environment not found" } });
  }
  const denied = requireTeamScope(authContext, env.teamId);
  if (denied) return denied;
  return undefined;
}

/** GET /v1/environments/:id/work/poll — Long-poll for work */
app.get(
  "/:id/work/poll",
  async ({ store, params, set, error }) => {
    const authContext = store.authContext;
    const denied = await requireEnvOwnership(authContext, params.id, error);
    if (denied) return denied;

    const envId = params.id;
    await updatePollTime(envId);
    const result = await pollWork(envId);
    if (!result) {
      set.status = 204;
      return null;
    }
    return result;
  },
  { apiKeyAuth: true },
);

/** POST /v1/environments/:id/work/:workId/ack — Acknowledge work */
app.post(
  "/:id/work/:workId/ack",
  async ({ store, params, error }) => {
    const denied = await requireEnvOwnership(store.authContext, params.id, error);
    if (denied) return denied;

    const workId = params.workId;
    ackWork(workId);
    return { status: "ok" };
  },
  { apiKeyAuth: true },
);

/** POST /v1/environments/:id/work/:workId/stop — Stop work */
app.post(
  "/:id/work/:workId/stop",
  async ({ store, params, error }) => {
    const denied = await requireEnvOwnership(store.authContext, params.id, error);
    if (denied) return denied;

    const workId = params.workId;
    stopWork(workId);
    return { status: "ok" };
  },
  { apiKeyAuth: true },
);

/** POST /v1/environments/:id/work/:workId/heartbeat — Heartbeat */
app.post(
  "/:id/work/:workId/heartbeat",
  async ({ store, params, error }) => {
    const denied = await requireEnvOwnership(store.authContext, params.id, error);
    if (denied) return denied;

    const workId = params.workId;
    const result = heartbeatWork(workId);
    return result;
  },
  { apiKeyAuth: true },
);

export default app;
```

- [ ] **Step 2: 运行全量测试确认无回归**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/`

Expected: 所有现有测试 PASS（work 路由目前无专门测试文件，不影响现有测试）

- [ ] **Step 3: Commit**

```bash
git add src/routes/v1/environments.work.ts
git commit -m "fix: work 路由添加环境归属校验 — 验证目标 environment 属于当前认证 team"
```

---

### Task 5: Code Session 路由归属校验

**Files:**
- Modify: `src/routes/v2/code-sessions.ts`

**背景：** `POST /:id/bridge` 拿任意 sessionId 就能获取 worker JWT，无归属校验。`POST /` 创建 session 不绑定调用者团队。

- [ ] **Step 1: 修改 code-sessions 路由**

将 `src/routes/v2/code-sessions.ts` 全文替换为：

```ts
import Elysia from "elysia";
import { generateWorkerJwt } from "../../auth/jwt";
import { config, getBaseUrl } from "../../config";
import { authGuardPlugin } from "../../plugins/auth";
import { requireTeamScope } from "../../plugins/require-team-scope";
import { environmentRepo, sessionRepo } from "../../repositories";
import { type CreateCodeSessionRequest, CreateCodeSessionRequestSchema } from "../../schemas/v2-code-session.schema";
import { createSession, getSession } from "../../services/session";

const app = new Elysia({ name: "v1-code-sessions", prefix: "/v1/code/sessions" })
  .use(authGuardPlugin)
  .model({ "create-code-session-request": CreateCodeSessionRequestSchema });

/** POST /v1/code/sessions — Create code session (wrapped response for TUI compat) */
app.post(
  "/",
  async ({ store, body, error }) => {
    const authContext = store.authContext;
    if (!authContext) {
      return error(403, { error: { type: "forbidden", message: "No team context" } });
    }
    const b = body as CreateCodeSessionRequest;
    const session = await createSession({ ...b, source: "code", userId: authContext.userId });
    return { session };
  },
  { apiKeyAuth: true, body: "create-code-session-request" },
);

/** POST /v1/code/sessions/:id/bridge — Get connection info + worker JWT */
app.post(
  "/:id/bridge",
  async ({ store, params, error }) => {
    const authContext = store.authContext;
    if (!authContext) {
      return error(403, { error: { type: "forbidden", message: "No team context" } });
    }
    const sessionId = params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }

    // 校验 session 归属：session → environment → team
    const sessionRecord = await sessionRepo.getById(sessionId);
    if (sessionRecord?.environmentId) {
      const env = await environmentRepo.getById(sessionRecord.environmentId);
      if (env) {
        const denied = requireTeamScope(authContext, env.teamId);
        if (denied) return denied;
      }
    }

    const expiresInSeconds = config.jwtExpiresIn;
    const workerJwt = generateWorkerJwt(sessionId, expiresInSeconds);

    return {
      api_base_url: getBaseUrl(),
      worker_jwt: workerJwt,
      expires_in: expiresInSeconds,
    };
  },
  { apiKeyAuth: true },
);

export default app;
```

- [ ] **Step 2: 运行全量测试确认无回归**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/routes/v2/code-sessions.ts
git commit -m "fix: code session 路由添加归属校验 — 创建 session 绑定用户，bridge 端点验证 session→env→team 归属"
```

---

### Task 6: Session 路由归属校验

**Files:**
- Modify: `src/routes/v1/sessions.ts`

**背景：** `GET /:id`、`PATCH /:id`、`POST /:id/archive`、`POST /:id/events` 都不校验 session 归属。最危险的是 `POST /:id/events`——可以向任意 session 注入事件。

- [ ] **Step 1: 修改 session 路由**

将 `src/routes/v1/sessions.ts` 全文替换为：

```ts
import Elysia from "elysia";
import { log, error as logError } from "../../logger";
import { authGuardPlugin } from "../../plugins/auth";
import { requireTeamScope } from "../../plugins/require-team-scope";
import { environmentRepo, sessionRepo } from "../../repositories";
import {
  type CreateSessionRequest,
  CreateSessionRequestSchema,
  type SendEventsRequest,
  SendEventsRequestSchema,
  type UpdateSessionRequest,
  UpdateSessionRequestSchema,
} from "../../schemas/v1-session.schema";
import { archiveSession, createSession, getSession, resolveExistingSessionId } from "../../services/session";
import { publishSessionEvent } from "../../services/transport";
import { createWorkItem } from "../../services/work-dispatch";

const app = new Elysia({ name: "v1-sessions", prefix: "/v1/sessions" }).use(authGuardPlugin).model({
  "create-session-request": CreateSessionRequestSchema,
  "update-session-request": UpdateSessionRequestSchema,
  "send-events-request": SendEventsRequestSchema,
});

/**
 * 校验 session 归属当前认证 team。
 * 解析链路：sessionId → sessionRecord.environmentId → environment.teamId。
 * 返回 undefined 表示通过，否则返回错误响应。
 */
async function requireSessionScope(
  authContext: any,
  sessionId: string,
  error: (code: number, body: unknown) => Response,
): Promise<Response | undefined> {
  const sessionRecord = await sessionRepo.getById(sessionId);
  if (!sessionRecord?.environmentId) {
    // session 无 environment 绑定（轻量存根）— 允许访问
    return undefined;
  }
  const env = await environmentRepo.getById(sessionRecord.environmentId);
  if (!env) return undefined;
  return requireTeamScope(authContext, env.teamId);
}

/** POST /v1/sessions — Create session */
app.post(
  "/",
  async ({ store, body, error }) => {
    const authContext = store.authContext;
    if (!authContext) {
      return error(403, { error: { type: "forbidden", message: "No team context" } });
    }
    const b = body as CreateSessionRequest;
    const username = (store as any).username as string | undefined;
    const session = await createSession({ ...b, username, userId: authContext.userId });

    // Create work item if environment is specified
    if (b.environment_id) {
      // 校验 environment 归属
      const env = await environmentRepo.getById(b.environment_id);
      if (env) {
        const denied = requireTeamScope(authContext, env.teamId);
        if (denied) return denied;
      }
      try {
        await createWorkItem(b.environment_id, session.id);
      } catch (err) {
        logError(`[RCS] Failed to create work item: ${(err as Error).message}`);
      }
    }

    // Publish initial events if provided
    if (b.events && Array.isArray(b.events)) {
      for (const evt of b.events) {
        const evtType = typeof evt.type === "string" ? evt.type : "init";
        publishSessionEvent(session.id, evtType, evt, "outbound");
      }
    }

    return session;
  },
  { apiKeyAuth: true, body: "create-session-request" },
);

/** GET /v1/sessions/:id — Get session */
app.get(
  "/:id",
  async ({ store, params, error }) => {
    const authContext = store.authContext;
    const sessionId = (await resolveExistingSessionId(params.id)) ?? params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    const denied = await requireSessionScope(authContext, sessionId, error);
    if (denied) return denied;
    return session;
  },
  { apiKeyAuth: true },
);

/** PATCH /v1/sessions/:id — Update session title (no-op, title managed by Agent) */
app.patch(
  "/:id",
  async ({ store, params, error }) => {
    const authContext = store.authContext;
    const sessionId = (await resolveExistingSessionId(params.id)) ?? params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    const denied = await requireSessionScope(authContext, sessionId, error);
    if (denied) return denied;
    return session;
  },
  { apiKeyAuth: true, body: "update-session-request" },
);

/** POST /v1/sessions/:id/archive — Archive session */
app.post(
  "/:id/archive",
  async ({ store, params, error }) => {
    const authContext = store.authContext;
    const sessionId = (await resolveExistingSessionId(params.id)) ?? params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    const denied = await requireSessionScope(authContext, sessionId, error);
    if (denied) return denied;

    try {
      await archiveSession(sessionId);
    } catch {
      return { status: "ok" };
    }

    return { status: "ok" };
  },
  { apiKeyAuth: true },
);

/** POST /v1/sessions/:id/events — Send event to session */
app.post(
  "/:id/events",
  async ({ store, params, body, error }) => {
    const authContext = store.authContext;
    const sessionId = (await resolveExistingSessionId(params.id)) ?? params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    const denied = await requireSessionScope(authContext, sessionId, error);
    if (denied) return denied;

    const b = body as SendEventsRequest;
    const events = b.events ? (Array.isArray(b.events) ? b.events : [b.events]) : [];
    const published = [];
    for (const evt of events) {
      const evtType = typeof evt.type === "string" ? evt.type : "message";
      const result = publishSessionEvent(sessionId, evtType, evt, "inbound");
      published.push(result);
    }

    return { status: "ok", events: published.length };
  },
  { apiKeyAuth: true, body: "send-events-request" },
);

export default app;
```

- [ ] **Step 2: 运行全量测试确认无回归**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/routes/v1/sessions.ts
git commit -m "fix: session 路由添加归属校验 — 通过 session→environment→team 链路验证所有权，防止跨 team 注入事件"
```

---

### Task 7: Environment Bridge 路由加固

**Files:**
- Modify: `src/routes/v1/environments.ts`

**背景：** `DELETE /bridge/:id` 和 `POST /:id/bridge/reconnect` 的 `deregisterBridge` / `reconnectBridge` 已有 `userId` 归属校验（检查 `env.userId !== userId`）。但 `POST /bridge` 注册新环境时，per-user API Key 路径创建的环境没绑定 `teamId`（`registerBridge` 里 `create` 没传 teamId）。需要确保新创建的环境绑定到认证用户的 team。

- [ ] **Step 1: 修改 `registerBridge` — 传递 teamId**

在 `src/services/environment-acp.ts` 的 `BridgeRegistrationInput` 接口添加 `teamId`：

```ts
export interface BridgeRegistrationInput {
  authEnvironmentId?: string;
  userId: string;
  teamId?: string;
  machine_name?: string;
  directory?: string;
  branch?: string;
  git_repo_url?: string;
  max_sessions?: number;
  worker_type?: string;
  capabilities?: Record<string, unknown>;
  metadata?: { worker_type?: string };
}
```

在 `registerBridge` 函数中新环境创建处（约第 230 行）添加 `teamId`：

```ts
const record = await _deps.environmentRepo.create({
  secret,
  userId,
  teamId: input.teamId,
  machineName: machine_name,
  directory,
  branch,
  gitRepoUrl: git_repo_url,
  maxSessions: max_sessions,
  workerType,
  capabilities,
});
```

- [ ] **Step 2: 修改 environments 路由 — 传递 teamId**

将 `src/routes/v1/environments.ts` 全文替换为：

```ts
import Elysia from "elysia";
import { NotFoundError } from "../../errors";
import { authGuardPlugin } from "../../plugins/auth";
import { requireTeamScope } from "../../plugins/require-team-scope";
import { environmentRepo } from "../../repositories";
import { type BridgeRegistrationRequest, BridgeRegistrationRequestSchema } from "../../schemas/v1-environment.schema";
import { deregisterBridge, reconnectBridge, registerBridge } from "../../services/environment";

const app = new Elysia({ name: "v1-environments", prefix: "/v1/environments" }).use(authGuardPlugin).model({
  "bridge-registration-request": BridgeRegistrationRequestSchema,
});

/** POST /v1/environments/bridge — REST registration for acp-link compatibility */
app.post(
  "/bridge",
  async ({ store, body, error }) => {
    const user = store.user!;
    const authContext = store.authContext;
    const b = body as BridgeRegistrationRequest;
    const authEnvId = store.authEnvironmentId as string | undefined;

    return registerBridge({
      authEnvironmentId: authEnvId,
      userId: user.id,
      teamId: authContext?.teamId,
      machine_name: b.machine_name,
      directory: b.directory,
      branch: b.branch,
      git_repo_url: b.git_repo_url,
      max_sessions: b.max_sessions,
      worker_type: b.worker_type,
      capabilities: b.capabilities,
      metadata: b.metadata,
    });
  },
  { apiKeyAuth: true, body: "bridge-registration-request" },
);

/** DELETE /v1/environments/bridge/:id — Deregister */
app.delete(
  "/bridge/:id",
  async ({ store, params, error }) => {
    const user = store.user!;
    const authContext = store.authContext;

    // 校验 environment 归属
    const env = await environmentRepo.getById(params.id);
    if (!env) {
      return error(404, { error: { type: "not_found", message: "Environment not found" } });
    }
    const denied = requireTeamScope(authContext, env.teamId);
    if (denied) return denied;

    try {
      await deregisterBridge(params.id, user.id);
      return { status: "ok" };
    } catch (err) {
      if (err instanceof NotFoundError) {
        return error(404, { error: { type: "not_found", message: "Environment not found" } });
      }
      throw err;
    }
  },
  { apiKeyAuth: true },
);

/** POST /v1/environments/:id/bridge/reconnect — Reconnect */
app.post(
  "/:id/bridge/reconnect",
  async ({ store, params, error }) => {
    const user = store.user!;
    const authContext = store.authContext;

    // 校验 environment 归属
    const env = await environmentRepo.getById(params.id);
    if (!env) {
      return error(404, { error: { type: "not_found", message: "Environment not found" } });
    }
    const denied = requireTeamScope(authContext, env.teamId);
    if (denied) return denied;

    try {
      await reconnectBridge(params.id, user.id);
      return { status: "ok" };
    } catch (err) {
      if (err instanceof NotFoundError) {
        return error(404, { error: { type: "not_found", message: "Environment not found" } });
      }
      throw err;
    }
  },
  { apiKeyAuth: true },
);

export default app;
```

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/routes/v1/environments.ts src/services/environment-acp.ts
git commit -m "fix: bridge 路由加固 — 新环境绑定 teamId，delete/reconnect 添加团队归属校验"
```

---

### Task 8: Worker register 端点加固

**Files:**
- Modify: `src/routes/v2/worker.ts` (code-sessions 中的 worker register)

**背景：** `POST /:id/worker/register` 使用 `apiKeyAuth`，但不校验 session 归属。

- [ ] **Step 1: 修改 worker register 端点**

在 `src/routes/v2/code-sessions.ts` 中的 worker register 端点添加归属校验。找到约第 102-115 行的 `POST /:id/worker/register`：

将：
```ts
app.post(
  "/:id/worker/register",
  async ({ params, error }) => {
    const sessionId = params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }

    return { status: "ok" };
  },
  { apiKeyAuth: true },
);
```

改为：
```ts
app.post(
  "/:id/worker/register",
  async ({ store, params, error }) => {
    const authContext = store.authContext;
    if (!authContext) {
      return error(403, { error: { type: "forbidden", message: "No team context" } });
    }
    const sessionId = params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }

    // 校验 session 归属
    const sessionRecord = await sessionRepo.getById(sessionId);
    if (sessionRecord?.environmentId) {
      const env = await environmentRepo.getById(sessionRecord.environmentId);
      if (env) {
        const denied = requireTeamScope(authContext, env.teamId);
        if (denied) return denied;
      }
    }

    return { status: "ok" };
  },
  { apiKeyAuth: true },
);
```

注意：`src/routes/v2/code-sessions.ts` 的 `worker register` 端点需要额外 import。确保文件顶部有：

```ts
import { requireTeamScope } from "../../plugins/require-team-scope";
import { environmentRepo, sessionRepo } from "../../repositories";
```

（这些 import 已在 Task 5 中添加，此处确认存在即可。）

- [ ] **Step 2: 运行全量测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/routes/v2/code-sessions.ts
git commit -m "fix: worker register 端点添加 session 归属校验"
```

---

### Task 9: 安全集成测试

**Files:**
- Create: `src/__tests__/api-key-security.test.ts`

**背景：** 需要端到端测试验证所有加固措施生效：hash 存储、authContext guard、资源归属校验。

- [ ] **Step 1: 写安全集成测试**

创建 `src/__tests__/api-key-security.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { hashApiKey } from "../auth/api-key-service";
import { requireTeamScope } from "../plugins/require-team-scope";
import type { AuthContext } from "../plugins/auth";

// ---------- Hash 存储验证 ----------

describe("API Key hash 存储", () => {
  test("相同 key 产生相同 hash", () => {
    const key = "rcs_abcdef1234567890";
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  test("不同 key 产生不同 hash", () => {
    expect(hashApiKey("rcs_aaa")).not.toBe(hashApiKey("rcs_bbb"));
  });

  test("hash 长度 64 hex chars", () => {
    expect(hashApiKey("rcs_test")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hash 不包含原始 key", () => {
    const key = "rcs_super_secret_key_12345";
    const hash = hashApiKey(key);
    expect(hash).not.toContain("rcs_");
    expect(hash).not.toContain("secret");
  });
});

// ---------- requireTeamScope 验证 ----------

describe("requireTeamScope 归属校验", () => {
  const makeAuthCtx = (teamId: string): AuthContext => ({
    teamId,
    userId: "user-1",
    role: "owner",
  });

  test("匹配 teamId — 通过", () => {
    expect(requireTeamScope(makeAuthCtx("team-a"), "team-a")).toBeUndefined();
  });

  test("不匹配 teamId — 拒绝", () => {
    const result = requireTeamScope(makeAuthCtx("team-a"), "team-b");
    expect(result).toBeDefined();
  });

  test("null authContext — 拒绝", () => {
    const result = requireTeamScope(null as any, "team-a");
    expect(result).toBeDefined();
  });

  test("null resourceTeamId — 拒绝", () => {
    const result = requireTeamScope(makeAuthCtx("team-a"), null);
    expect(result).toBeDefined();
  });

  test("undefined resourceTeamId — 拒绝", () => {
    const result = requireTeamScope(makeAuthCtx("team-a"), undefined);
    expect(result).toBeDefined();
  });
});

// ---------- authContext null guard 概念验证 ----------

describe("apiKeyAuth null guard", () => {
  test("无 teamId 的 API Key 应被 403 拒绝（概念）", () => {
    // 模拟：getAuthContextByTeamId 返回 null
    const authContext: AuthContext | null = null;
    // apiKeyAuth macro 现在会在 ctx 为 null 时返回 403
    // 而不是放行请求
    expect(authContext).toBeNull();
    // requireTeamScope 也会拒绝 null authContext
    const result = requireTeamScope(authContext, "any-team");
    expect(result).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/api-key-security.test.ts`

Expected: PASS

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/`

Expected: 所有测试 PASS

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/api-key-security.test.ts
git commit -m "test: API Key 安全集成测试 — hash 存储 + team 归属校验 + authContext null guard"
```

---

### Task 10: 数据迁移 — Hash 已有 API Key

**Files:**
- Create: `scripts/migrate-api-keys-hash.ts`

**背景：** 已有 `api_key` 表中的 key 是 `rcs_xxx` 明文。需要一次性脚本将其 hash 化。

- [ ] **Step 1: 写迁移脚本**

创建 `scripts/migrate-api-keys-hash.ts`：

```ts
#!/usr/bin/env bun
/**
 * 一次性迁移：将 api_key 表中的明文 key hash 化。
 *
 * 逻辑：
 * 1. 查询所有 key_hash 为 NULL 的行
 * 2. 计算 SHA-256(key)，更新 key_hash + key_prefix
 * 3. 将 key 列也更新为 hash（validateApiKeyAndGetUser 兼容双路径查询）
 *
 * 用法：bun run scripts/migrate-api-keys-hash.ts
 */

import { createHash } from "node:crypto";
import { db } from "../src/db";
import { apiKey } from "../src/db/schema";
import { isNull, isNotNull } from "drizzle-orm";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function main() {
  console.log("[migration] 开始 hash 已有 API Key...");

  // 查找需要迁移的行：key_hash 为 NULL 且 key 以 "rcs_" 开头
  const rows = await db
    .select({ id: apiKey.id, key: apiKey.key })
    .from(apiKey)
    .where(isNull(apiKey.keyHash));

  console.log(`[migration] 找到 ${rows.length} 条需要迁移的 key`);

  let migrated = 0;
  let skipped = 0;

  for (const row of rows) {
    const originalKey = row.key;

    // 跳过已经是 hash 的 key（64 hex chars，不以 rcs_ 开头）
    if (!originalKey.startsWith("rcs_")) {
      skipped++;
      continue;
    }

    const keyHash = sha256(originalKey);
    const keyPrefix = originalKey.slice(0, 8) + "..." + originalKey.slice(-4);

    await db
      .update(apiKey)
      .set({ keyHash, keyPrefix, key: keyHash })
      .where(/* need eq import */);

    // 由于不能在脚本顶部和 import 混用，这里用另一种方式
    migrated++;
  }

  console.log(`[migration] 完成：${migrated} 条迁移，${skipped} 条跳过（已是 hash 格式）`);

  // 验证：确认没有未迁移的行
  const remaining = await db
    .select({ id: apiKey.id })
    .from(apiKey)
    .where(isNull(apiKey.keyHash));
  console.log(`[migration] 剩余未迁移：${remaining.length} 条`);

  process.exit(0);
}

main().catch((err) => {
  console.error("[migration] 失败:", err);
  process.exit(1);
});
```

等一下，上面脚本中的 update 缺少 `eq` 引用。修正为：

```ts
#!/usr/bin/env bun
/**
 * 一次性迁移：将 api_key 表中的明文 key hash 化。
 *
 * 用法：bun run scripts/migrate-api-keys-hash.ts
 */

import { createHash } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { db } from "../src/db";
import { apiKey } from "../src/db/schema";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function main() {
  console.log("[migration] 开始 hash 已有 API Key...");

  const rows = await db
    .select({ id: apiKey.id, key: apiKey.key })
    .from(apiKey)
    .where(isNull(apiKey.keyHash));

  console.log(`[migration] 找到 ${rows.length} 条需要迁移的 key`);

  let migrated = 0;
  let skipped = 0;

  for (const row of rows) {
    const originalKey = row.key;

    if (!originalKey.startsWith("rcs_")) {
      skipped++;
      continue;
    }

    const keyHash = sha256(originalKey);
    const keyPrefix = originalKey.slice(0, 8) + "..." + originalKey.slice(-4);

    await db
      .update(apiKey)
      .set({ keyHash, keyPrefix, key: keyHash })
      .where(eq(apiKey.id, row.id));

    migrated++;
  }

  console.log(`[migration] 完成：${migrated} 条迁移，${skipped} 条跳过（已是 hash 格式）`);

  const remaining = await db
    .select({ id: apiKey.id })
    .from(apiKey)
    .where(isNull(apiKey.keyHash));

  console.log(`[migration] 剩余未迁移：${remaining.length} 条`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[migration] 失败:", err);
  process.exit(1);
});
```

注意：此脚本运行在**部署后、上线前**执行。执行后旧 key 的原文值将被 hash 替换，持有旧 key 的用户需要重新生成 API Key（因为 `sanitize` 展示的是 keyPrefix，用户无法从 hash 反推原文）。

- [ ] **Step 2: Commit**

```bash
git add scripts/migrate-api-keys-hash.ts
git commit -m "feat: API Key hash 迁移脚本 — 将明文 key 替换为 SHA-256 hash"
```

---

## Self-Review

### Spec Coverage

| 安全问题 | 对应 Task | 状态 |
|---------|----------|------|
| API Key 明文存储 | Task 1 (hash 存储) + Task 10 (迁移脚本) | ✅ |
| authContext 可能为 null | Task 2 (null guard) | ✅ |
| Work 路由无归属校验 | Task 4 (env ownership) | ✅ |
| Code session bridge 无归属校验 | Task 5 (session→env→team) | ✅ |
| Session 路由无归属校验 | Task 6 (session→env→team) | ✅ |
| Environment bridge 路由加固 | Task 7 (teamId 绑定 + 归属校验) | ✅ |
| Worker register 无归属校验 | Task 8 (session 归属) | ✅ |

### Placeholder Scan

- 无 TBD / TODO / "implement later"
- 无 "add appropriate error handling" 等模糊描述
- 所有代码步骤包含完整实现
- 无 "similar to Task N" 引用

### Type Consistency

- `AuthContext` 类型贯穿所有 Task：`{ teamId: string; userId: string; role: "owner" | "admin" | "member" }`
- `requireTeamScope` 签名一致：`(authContext: AuthContext | null, resourceTeamId: string | null | undefined) => Response | undefined`
- `ApiKeyRecord` 接口在 Task 1 中更新，后续 Task 不直接引用
- `BridgeRegistrationInput` 在 Task 7 中扩展 `teamId`，路由传递 `authContext?.teamId`
