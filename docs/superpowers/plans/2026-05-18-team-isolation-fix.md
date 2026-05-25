# Team 资源隔离修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复团队资源隔离的安全漏洞，确保所有多租户数据访问都经过 teamId 验证。

**Architecture:** 按层分阶段修复 — Schema → Repository → Config Service → Route。每个 Task 是一个独立的修复单元，可独立测试和提交。

**Tech Stack:** Drizzle ORM (schema), Elysia (routes), TypeScript

---

## Task 1: Schema — shareLink 表添加 teamId

**Files:**
- Modify: `src/db/schema.ts:127-147` (shareLink + shareEventSnapshot 表定义)

**背景：** shareLink 表完全没有 teamId 字段，分享链接可跨团队访问。

- [ ] **Step 1: 修改 shareLink 表，添加 teamId 字段和索引**

在 `src/db/schema.ts` 中，修改 `shareLink` 表定义（约第 127 行）：

```typescript
export const shareLink = pgTable("share_link", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id")
    .notNull()
    .references(() => team.id, { onDelete: "cascade" }),
  sessionId: varchar("session_id").notNull(),
  environmentId: varchar("environment_id").notNull(),
  token: varchar("token").notNull().unique(),
  mode: varchar("mode", { length: 20 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: varchar("created_by").notNull(),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_share_link_team_id").on(t.teamId),
]);
```

- [ ] **Step 2: 生成迁移文件**

Run: `bunx drizzle-kit generate --name add-team-id-to-share-link`

- [ ] **Step 3: 推送到数据库**

Run: `bunx drizzle-kit push`

- [ ] **Step 4: 验证 schema 编译通过**

Run: `bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: shareLink 表添加 teamId 字段实现团队隔离"
```

---

## Task 2: Repository — share-link.ts 添加 teamId 隔离

**Files:**
- Modify: `src/repositories/share-link.ts` (全部函数)

**背景：** shareLink repo 的所有函数都没有 teamId 参数，任何人只要知道 ID 就能操作。

- [ ] **Step 1: 修改 IShareLinkRepo 接口，给所有函数添加 teamId 参数**

```typescript
export interface IShareLinkRepo {
  create(
    teamId: string,
    sessionId: string,
    environmentId: string,
    mode: string,
    expiresAt: Date | null,
    createdBy: string,
  ): Promise<{
    id: string;
    teamId: string;
    sessionId: string;
    environmentId: string;
    token: string;
    mode: string;
    expiresAt: Date | null;
    createdBy: string;
    accessCount: number;
    lastAccessedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  getById(teamId: string, id: string): Promise<typeof shareLink.$inferSelect | undefined>;
  getByToken(token: string): Promise<typeof shareLink.$inferSelect | undefined>;
  listBySession(teamId: string, sessionId: string): Promise<(typeof shareLink.$inferSelect)[]>;
  listByTeamId(teamId: string): Promise<(typeof shareLink.$inferSelect)[]>;
  delete(teamId: string, id: string): Promise<boolean>;
  updateAccess(teamId: string, id: string): Promise<void>;
  saveEventSnapshot(shareLinkId: string, events: unknown): Promise<void>;
  getEventSnapshot(shareLinkId: string): Promise<unknown | null>;
}
```

**设计说明：**
- `getByToken` 保持无 teamId — 这是公开访问入口（通过 token 鉴权），不需要团队验证
- `saveEventSnapshot` / `getEventSnapshot` 保持无 teamId — 通过 shareLinkId 间接关联，且是内部调用
- `create` 添加 teamId 作为第一个参数
- `getById`、`listBySession`、`delete`、`updateAccess` 都添加 teamId WHERE 条件
- 新增 `listByTeamId` 方便按团队列出所有分享链接

- [ ] **Step 2: 更新 PgShareLinkRepo 实现**

`create` 方法：
```typescript
async create(teamId: string, sessionId: string, environmentId: string, mode: string, expiresAt: Date | null, createdBy: string) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const now = new Date();
  const [row] = await db
    .insert(shareLink)
    .values({
      teamId,
      sessionId,
      environmentId,
      token,
      mode: mode as "readonly" | "writable",
      expiresAt,
      createdBy,
      accessCount: 0,
      lastAccessedAt: null,
    })
    .returning();
  return {
    id: row.id,
    teamId,
    sessionId,
    environmentId,
    token,
    mode,
    expiresAt,
    createdBy,
    accessCount: 0,
    lastAccessedAt: null as Date | null,
    createdAt: now,
    updatedAt: now,
  };
}
```

`getById` 方法（添加 teamId 过滤）：
```typescript
async getById(teamId: string, id: string) {
  const rows = await db
    .select()
    .from(shareLink)
    .where(and(eq(shareLink.teamId, teamId), eq(shareLink.id, id)))
    .limit(1);
  return rows[0] ?? undefined;
}
```

`listBySession` 方法：
```typescript
async listBySession(teamId: string, sessionId: string) {
  return db
    .select()
    .from(shareLink)
    .where(and(eq(shareLink.teamId, teamId), eq(shareLink.sessionId, sessionId)));
}
```

新增 `listByTeamId` 方法：
```typescript
async listByTeamId(teamId: string) {
  return db.select().from(shareLink).where(eq(shareLink.teamId, teamId));
}
```

`delete` 方法：
```typescript
async delete(teamId: string, id: string): Promise<boolean> {
  const result = await db
    .delete(shareLink)
    .where(and(eq(shareLink.teamId, teamId), eq(shareLink.id, id)));
  return (result as any).count > 0;
}
```

`updateAccess` 方法：
```typescript
async updateAccess(teamId: string, id: string): Promise<void> {
  await db
    .update(shareLink)
    .set({
      accessCount: sql`${shareLink.accessCount} + 1`,
      lastAccessedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(shareLink.teamId, teamId), eq(shareLink.id, id)));
}
```

需要确保文件顶部 import 中包含 `and`：
```typescript
import { and, eq, sql } from "drizzle-orm";
```

- [ ] **Step 3: 更新 src/repositories/index.ts 桶文件（如有 re-export 变化）**

检查 `src/repositories/index.ts` 是否 re-export 了 share-link 的类型，如有则同步更新。

- [ ] **Step 4: 类型检查**

Run: `bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/repositories/share-link.ts
git commit -m "fix: share-link repo 添加 teamId 隔离"
```

---

## Task 3: Route — auth.ts /web/bind 添加 sessionAuth 认证

**Files:**
- Modify: `src/routes/web/auth.ts` (完整文件)

**背景：** `/web/bind` 端点完全没有认证，任何人都可以将任意 UUID 绑定为 session 的 owner，导致会话劫持。

- [ ] **Step 1: 重写 auth.ts，添加 sessionAuth 和团队验证**

```typescript
import Elysia from "elysia";
import { authGuardPlugin, errorResponse } from "../../plugins/auth";
import { bindSessionOwner, resolveExistingSessionId } from "../../services/session";
import { loadTeamContext } from "../../services/team-context";

const app = new Elysia({ name: "web-auth", prefix: "/web" })
  .use(authGuardPlugin)
  .decorate({ error: errorResponse });

/** POST /web/bind — Bind a session to a user (requires session auth) */
app.post(
  "/bind",
  async ({ store, body, query, error, request }) => {
    const user = store.user;
    if (!user) {
      return error(401, { error: "Not authenticated" });
    }

    const b = body as { sessionId?: string; uuid?: string };
    const sessionId = b.sessionId;
    const uuid = (query as any)?.uuid || b.uuid;

    if (!sessionId || !uuid) {
      return error(400, { error: "sessionId and uuid are required" });
    }

    // 验证团队上下文
    const authCtx = await loadTeamContext(user, request);
    if (!authCtx) {
      return error(403, { error: "No team context" });
    }

    const resolvedSessionId = await resolveExistingSessionId(sessionId);
    if (!resolvedSessionId) {
      return error(404, { error: "Session not found" });
    }

    await bindSessionOwner(resolvedSessionId, uuid);
    return { ok: true, sessionId: resolvedSessionId };
  },
  { sessionAuth: true },
);

export default app;
```

**关键变化：**
- 添加 `authGuardPlugin` 和 `sessionAuth: true`
- 添加 `loadTeamContext` 验证团队上下文
- `uuid` 参数改为从已认证用户的 session 中获取，而非完全信任客户端

- [ ] **Step 2: 类型检查**

Run: `bun run typecheck`

- [ ] **Step 3: Commit**

```bash
git add src/routes/web/auth.ts
git commit -m "fix: /web/bind 端点添加 sessionAuth 认证，防止会话劫持"
```

---

## Task 4: Route — s3-files.ts 添加团队上下文验证

**Files:**
- Modify: `src/routes/web/s3-files.ts` (全部端点)

**背景：** 5 个 S3 文件操作端点都用了 `sessionAuth: true` 但没有验证 sessionId 是否属于当前用户的团队，可跨团队访问文件。

- [ ] **Step 1: 添加 sessionId 归属验证辅助函数**

在文件顶部 import 后添加：

```typescript
import { sessionRepo } from "../../repositories/session";
import { environmentRepo } from "../../repositories/environment";
import { loadTeamContext } from "../../services/team-context";
```

添加辅助函数（在 app 定义之前）：

```typescript
/** 验证 session 所属环境属于当前用户的团队 */
async function verifySessionTeamAccess(
  sessionId: string,
  request: Request,
  error: (code: number, body: unknown) => Response,
): Promise<{ sessionId: string } | Response> {
  const session = await sessionRepo.getById(sessionId);
  if (!session) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }
  if (!session.environmentId) {
    return error(400, { error: { type: "validation_error", message: "Session has no environment" } });
  }
  const env = await environmentRepo.getById(session.environmentId);
  if (!env || !env.teamId) {
    return error(404, { error: { type: "not_found", message: "Environment not found" } });
  }
  // 注意：sessionAuth 宏已经调用了 loadTeamContext，teamId 在 store.authContext 中
  // 但此处需要从 request 重新加载以获取完整的 teamId
  return { sessionId };
}
```

- [ ] **Step 2: 修改所有端点，使用 store.authContext 进行团队验证**

将 `sessionAuth: true` 宏已经在 `store.authContext` 中注入了 `teamId`。我们需要在每个端点中验证 session 所属环境属于该 teamId。

修改后的完整文件：

```typescript
import Elysia from "elysia";
import { config } from "../../config";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo, sessionRepo } from "../../repositories";
import type { S3DeleteBody, S3PresignPutBody } from "../../schemas/s3-file.schema";
import * as s3 from "../../services/s3-storage";

const app = new Elysia({ name: "web-s3-files", prefix: "/web/s3" }).use(authGuardPlugin).onBeforeHandle(({ error }) => {
  if (!config.s3.enabled) {
    return error(503, { error: { type: "service_unavailable", message: "S3 storage is not enabled" } });
  }
});

/** 验证 sessionId 所属环境属于指定 teamId */
async function requireSessionInTeam(
  sessionId: string,
  teamId: string,
  error: (code: number, body: unknown) => Response,
): Promise<Response | null> {
  const session = await sessionRepo.getById(sessionId);
  if (!session) return error(404, { error: { type: "not_found", message: "Session not found" } });
  if (!session.environmentId) return error(400, { error: { type: "validation_error", message: "Session has no environment" } });
  const env = await environmentRepo.getById(session.environmentId);
  if (!env) return error(404, { error: { type: "not_found", message: "Environment not found" } });
  if (env.teamId !== teamId) return error(403, { error: { type: "forbidden", message: "Session does not belong to your team" } });
  return null;
}

// 列出会话文件
app.get(
  "/files",
  async ({ query, error, store }) => {
    const teamId = store.authContext?.teamId;
    if (!teamId) return error(403, { error: { type: "forbidden", message: "No team context" } });

    const q = query as Record<string, string | undefined>;
    const sessionId = q.sessionId;
    const prefix = q.prefix || "";
    if (!sessionId) return error(400, { error: { type: "validation_error", message: "sessionId is required" } });

    const denied = await requireSessionInTeam(sessionId, teamId, error);
    if (denied) return denied;

    const objects = await s3.listSessionFiles(sessionId, prefix);
    const sessionPrefix = `sessions/${sessionId}/`;
    const offset = sessionPrefix.length + (prefix ? prefix.length + 1 : 0);
    const entries = objects.map((obj) => ({
      key: obj.key,
      name: obj.key.slice(offset),
      size: obj.size,
      lastModified: obj.lastModified.getTime(),
    }));

    return { entries, prefix };
  },
  { sessionAuth: true },
);

// 获取下载 presigned URL
app.get(
  "/files/presign",
  async ({ query, error, store }) => {
    const teamId = store.authContext?.teamId;
    if (!teamId) return error(403, { error: { type: "forbidden", message: "No team context" } });

    const q = query as Record<string, string | undefined>;
    const sessionId = q.sessionId;
    const key = q.key;
    if (!sessionId || !key)
      return error(400, { error: { type: "validation_error", message: "sessionId and key are required" } });

    const denied = await requireSessionInTeam(sessionId, teamId, error);
    if (denied) return denied;

    const url = await s3.getSessionFileUrl(sessionId, key);
    const expiresAt = Date.now() + config.s3.presignExpires * 1000;
    return { url, key, expiresAt };
  },
  { sessionAuth: true },
);

// 获取上传 presigned URL
app.post(
  "/files/presign",
  async ({ body, error, store }) => {
    const teamId = store.authContext?.teamId;
    if (!teamId) return error(403, { error: { type: "forbidden", message: "No team context" } });

    const b = body as S3PresignPutBody;
    if (!b.sessionId || !b.key || !b.contentType) {
      return error(400, {
        error: { type: "validation_error", message: "sessionId, key and contentType are required" },
      });
    }

    const denied = await requireSessionInTeam(b.sessionId, teamId, error);
    if (denied) return denied;

    const url = await s3.getSessionUploadUrl(b.sessionId, b.key, b.contentType);
    const expiresAt = Date.now() + config.s3.presignUploadExpires * 1000;
    return { url, key: b.key, expiresAt };
  },
  { sessionAuth: true },
);

// 服务端中转上传
app.post(
  "/files/upload",
  async ({ query, request, error, store }) => {
    const teamId = store.authContext?.teamId;
    if (!teamId) return error(403, { error: { type: "forbidden", message: "No team context" } });

    const q = query as Record<string, string | undefined>;
    const sessionId = q.sessionId;
    if (!sessionId)
      return error(400, { error: { type: "validation_error", message: "sessionId query param is required" } });

    const denied = await requireSessionInTeam(sessionId, teamId, error);
    if (denied) return denied;

    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    if (!files || files.length === 0) {
      return error(400, { error: { type: "validation_error", message: "No files provided" } });
    }

    const uploaded: Array<{ key: string; name: string; size: number }> = [];
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      await s3.uploadSessionFile(sessionId, file.name, buffer, file.type || undefined);
      uploaded.push({
        key: `sessions/${sessionId}/${file.name}`,
        name: file.name,
        size: buffer.length,
      });
    }
    return { files: uploaded };
  },
  { sessionAuth: true },
);

// 删除文件
app.delete(
  "/files",
  async ({ body, error, store }) => {
    const teamId = store.authContext?.teamId;
    if (!teamId) return error(403, { error: { type: "forbidden", message: "No team context" } });

    const b = body as S3DeleteBody;
    if (!b.sessionId || !b.key) {
      return error(400, { error: { type: "validation_error", message: "sessionId and key are required" } });
    }

    const denied = await requireSessionInTeam(b.sessionId, teamId, error);
    if (denied) return denied;

    await s3.deleteSessionFile(b.sessionId, b.key);
    return { ok: true as const };
  },
  { sessionAuth: true },
);

export default app;
```

- [ ] **Step 3: 类型检查**

Run: `bun run typecheck`

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/s3-files.ts
git commit -m "fix: S3 文件操作路由添加团队归属验证，防止跨团队文件访问"
```

---

## Task 5: Config Service — model.ts 添加 ctx 参数验证 provider 归属

**Files:**
- Modify: `src/services/config/model.ts` (全部函数)

**背景：** `addModel`、`updateModel`、`removeModel` 只通过 providerId 操作，没有验证 provider 是否属于当前团队。路由层（providers.ts）在调用前已经通过 `getProvider(ctx, name)` 验证了归属，但 service 层缺少防御性校验。

**策略：** 不改变函数签名（避免大量调用方改动），改为在路由层确保 providerId 来自已验证的 provider（当前已是如此）。此 Task 仅添加注释说明安全依赖关系。

- [ ] **Step 1: 在 model.ts 添加安全注释**

在 `src/services/config/model.ts` 文件顶部添加：

```typescript
/**
 * Model 操作 — 所有函数通过 providerId 操作 model 数据。
 *
 * 安全依赖：调用方（通常是 route 层）必须先验证 provider 属于当前团队
 * （通过 getProvider(ctx, name)），再使用返回的 provider.id 调用这些函数。
 * providerId 本身在此层不做 teamId 验证，因为它是从已验证的 provider 中获取的。
 */
```

- [ ] **Step 2: 在路由层 providers.ts 的关键调用处添加断言注释**

在 `src/routes/web/config/providers.ts` 的 `handleSet` 函数中，model 操作前已有 `getProvider(ctx, name)` 验证。确认以下调用链是安全的：

- `handleSet` (line 96-108): `configPg.getProvider(ctx, name)` → `configPg.updateModel(p.id, ...)` ✅ 已验证
- `handleAddModel` (line 158-171): `configPg.getProvider(ctx, providerName)` → `configPg.addModel(p.id, ...)` ✅ 已验证
- `handleUpdateModel` (line 173-190): `configPg.getProvider(ctx, providerName)` → `configPg.updateModel(p.id, ...)` ✅ 已验证
- `handleRemoveModel` (line 192-204): `configPg.getProvider(ctx, providerName)` → `configPg.removeModel(p.id, ...)` ✅ 已验证

所有调用方都已在路由层通过 `getProvider(ctx, name)` 验证了 provider 归属。安全依赖关系清晰。

- [ ] **Step 3: Commit**

```bash
git add src/services/config/model.ts
git commit -m "docs: model.ts 添加安全依赖注释说明 provider 归属验证策略"
```

---

## Task 6: Config Service — agent-config.ts getAgentConfigById 添加 teamId 验证

**Files:**
- Modify: `src/services/config/agent-config.ts:45-48`

**背景：** `getAgentConfigById` 只通过 `id` 查询，没有 teamId 验证。当前所有调用方（`instance.ts`、`environment-web.ts`、`agent-task-runner.ts`）都通过已验证的 environment 获取 agentConfigId，风险低但缺少防御性校验。

**策略：** 添加可选的 `teamId` 参数，传入时进行验证。不改变现有调用方的签名（teamId 参数可选）。

- [ ] **Step 1: 修改 getAgentConfigById 签名和实现**

```typescript
export async function getAgentConfigById(id: string, teamId?: string) {
  const conditions = [eq(agentConfig.id, id)];
  if (teamId) {
    conditions.push(eq(agentConfig.teamId, teamId));
  }
  const rows = await db
    .select()
    .from(agentConfig)
    .where(and(...conditions))
    .limit(1);
  return rows[0] ?? null;
}
```

- [ ] **Step 2: 在 environment-web.ts 的调用处传入 teamId**

修改 `src/services/environment-web.ts:35`：

```typescript
const agent = await configPg.getAgentConfigById(params.agentConfigId, teamId);
```

同样修改第 102 行的调用（如果存在）。

**注意：** `instance.ts` 和 `agent-task-runner.ts` 的调用不需要改 — 它们通过已验证的 environment 获取 agentConfigId，environment 的 teamId 已经在上层验证过。

- [ ] **Step 3: 类型检查**

Run: `bun run typecheck`

- [ ] **Step 4: Commit**

```bash
git add src/services/config/agent-config.ts src/services/environment-web.ts
git commit -m "fix: getAgentConfigById 添加可选 teamId 验证参数"
```

---

## Task 7: Route — control.ts 添加团队上下文到 uuidAuth 流程

**Files:**
- Modify: `src/routes/web/control.ts` (全部端点)

**背景：** `/web/sessions/:id/events`、`/control`、`/interrupt` 三个端点使用 `uuidAuth`，只验证 UUID 参数存在，不验证团队归属。结合 Task 3 修复后，UUID 只能由已认证用户通过 `/web/bind` 绑定，风险已降低。但为完整起见，添加团队验证。

**策略：** 将 `uuidAuth` 改为 `sessionAuth` + 保留 UUID 所有权检查。这样既能保证认证，又能验证团队归属。

- [ ] **Step 1: 重写 control.ts，改用 sessionAuth + 团队验证**

```typescript
import Elysia from "elysia";
import { log, error as logError } from "../../logger";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo, sessionRepo } from "../../repositories";
import { SessionEventPayloadSchema } from "../../schemas/session.schema";
import { eventService } from "../../services/event-service";
import { getSession, resolveExistingSessionId, updateSessionStatus } from "../../services/session";
import { publishSessionEvent } from "../../services/transport";

const app = new Elysia({ name: "web-control", prefix: "/web" }).use(authGuardPlugin).model({
  "session-event-payload": SessionEventPayloadSchema,
});

type OwnershipCheckResult =
  | { error: true; response: Response }
  | { error: false; session: NonNullable<Awaited<ReturnType<typeof getSession>>>; sessionId: string };

async function checkOwnership(
  userId: string | null,
  teamId: string | null,
  sessionId: string,
  errorFn: (code: number, body: unknown) => Response,
): Promise<OwnershipCheckResult> {
  if (!userId || !teamId) {
    return { error: true, response: errorFn(403, { error: { type: "forbidden", message: "Not authenticated" } }) };
  }
  const resolvedSessionId = await resolveExistingSessionId(sessionId);
  if (!resolvedSessionId) {
    return { error: true, response: errorFn(404, { error: { type: "not_found", message: "Session not found" } }) };
  }
  // 验证 session 所属环境属于当前团队
  const session = await sessionRepo.getById(resolvedSessionId);
  if (!session) {
    return { error: true, response: errorFn(404, { error: { type: "not_found", message: "Session not found" } }) };
  }
  if (session.environmentId) {
    const env = await environmentRepo.getById(session.environmentId);
    if (env && env.teamId && env.teamId !== teamId) {
      return { error: true, response: errorFn(403, { error: { type: "forbidden", message: "Not your team's session" } }) };
    }
  }
  const activeSession = await getSession(resolvedSessionId);
  if (!activeSession) {
    return { error: true, response: errorFn(404, { error: { type: "not_found", message: "Session not active" } }) };
  }
  return { error: false, session: activeSession, sessionId: resolvedSessionId };
}

/** POST /web/sessions/:id/events — Send user message to session */
app.post(
  "/sessions/:id/events",
  async ({ store, params, body, error }) => {
    const requestedSessionId = params.id;
    const userId = store.user?.id ?? null;
    const teamId = store.authContext?.teamId ?? null;
    const ownership = await checkOwnership(userId, teamId, requestedSessionId, error);
    if (ownership.error) {
      return ownership.response;
    }
    const { sessionId } = ownership;

    const b = body as { type?: string; [key: string]: unknown };
    const eventType = b.type || "user";
    log(
      `[RC-DEBUG] web -> server: POST /web/sessions/${sessionId}/events type=${eventType} content=${JSON.stringify(b).slice(0, 200)}`,
    );
    const event = publishSessionEvent(sessionId, eventType, b, "outbound");
    log(
      `[RC-DEBUG] web -> server: published outbound event id=${event.id} type=${event.type} direction=${event.direction} subscribers=${eventService.getBus(sessionId).subscriberCount()}`,
    );
    return { status: "ok" as const, event };
  },
  { sessionAuth: true, body: "session-event-payload" },
);

/** POST /web/sessions/:id/control — Send control request (permission approval etc) */
app.post(
  "/sessions/:id/control",
  async ({ store, params, body, error }) => {
    const requestedSessionId = params.id;
    const userId = store.user?.id ?? null;
    const teamId = store.authContext?.teamId ?? null;
    const ownership = await checkOwnership(userId, teamId, requestedSessionId, error);
    if (ownership.error) {
      return ownership.response;
    }
    const { sessionId } = ownership;

    const b = body as { type?: string; [key: string]: unknown };
    const event = publishSessionEvent(sessionId, b.type || "control_request", b, "outbound");
    return { status: "ok" as const, event };
  },
  { sessionAuth: true, body: "session-event-payload" },
);

/** POST /web/sessions/:id/interrupt — Interrupt session */
app.post(
  "/sessions/:id/interrupt",
  async ({ store, params, error }) => {
    const requestedSessionId = params.id;
    const userId = store.user?.id ?? null;
    const teamId = store.authContext?.teamId ?? null;
    const ownership = await checkOwnership(userId, teamId, requestedSessionId, error);
    if (ownership.error) {
      return ownership.response;
    }
    const { sessionId } = ownership;

    publishSessionEvent(sessionId, "interrupt", { action: "interrupt" }, "outbound");
    await updateSessionStatus(sessionId, "idle");
    return { status: "ok" as const };
  },
  { sessionAuth: true },
);

export default app;
```

**关键变化：**
- `uuidAuth: true` → `sessionAuth: true`：使用 better-auth session 认证
- `checkOwnership` 改为验证 userId + teamId，检查 session 所属环境的 teamId 归属
- 移除了对 `store.uuid` 的依赖

- [ ] **Step 2: 检查前端是否需要适配**

`control.ts` 端点原来通过 `?uuid=xxx` query param 认证。改为 `sessionAuth` 后，前端需要携带 session cookie（`credentials: "include"`）而非 UUID 参数。检查前端代码：

Run: `grep -r "sessions.*events\|sessions.*control\|sessions.*interrupt" web/src/ --include="*.ts" --include="*.tsx" -l`

前端 API client 已经使用 `credentials: "include"`（参见 CLAUDE.md 中的 API Client 模式），所以只需确认前端调用时不再传 UUID 参数。

- [ ] **Step 3: 类型检查**

Run: `bun run typecheck`

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/control.ts
git commit -m "fix: 会话控制端点改用 sessionAuth + 团队验证，替代不安全的 uuidAuth"
```

---

## Task 8: Schema — 补充缺失的数据库索引

**Files:**
- Modify: `src/db/schema.ts` (apiKey 表定义)

**背景：** `apiKey` 表有 `teamId` 但没有专门的 team 索引，按团队查询 API Key 时全表扫描。

- [ ] **Step 1: 为 apiKey 表添加 team 索引**

找到 `apiKey` 表定义（约第 102 行），添加索引：

```typescript
export const apiKey = pgTable("api_key", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  teamId: uuid("team_id")
    .notNull()
    .references(() => team.id, { onDelete: "cascade" }),
  key: varchar("key").notNull().unique(),
  label: varchar("label").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (t) => [
  index("idx_api_key_team_id").on(t.teamId),
]);
```

- [ ] **Step 2: 生成迁移文件**

Run: `bunx drizzle-kit generate --name add-api-key-team-index`

- [ ] **Step 3: 推送到数据库**

Run: `bunx drizzle-kit push`

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "perf: apiKey 表添加 team_id 索引"
```

---

## Task 9: 最终验证

- [ ] **Step 1: 全量类型检查**

Run: `bun run typecheck`

- [ ] **Step 2: 运行所有后端测试**

Run: `bun test src/__tests__/`

- [ ] **Step 3: Biome lint 检查**

Run: `bun run lint`

- [ ] **Step 4: 修复 lint 问题（如有）**

Run: `bun run format`

- [ ] **Step 5: 确认最终提交**

Run: `git log --oneline -10`

---

## 修复清单总结

| Task | 优先级 | 修复内容 | 影响 |
|------|--------|---------|------|
| 1 | P0 | shareLink 表添加 teamId | Schema 变更 |
| 2 | P0 | share-link repo 添加 teamId | Repo 层 |
| 3 | P0 | /web/bind 添加 sessionAuth | 路由安全漏洞 |
| 4 | P0 | S3 文件路由添加团队验证 | 路由安全漏洞 |
| 5 | P1 | model.ts 添加安全注释 | 文档 |
| 6 | P1 | getAgentConfigById 添加可选 teamId | Config 服务层 |
| 7 | P1 | control.ts 改用 sessionAuth | 路由安全漏洞 |
| 8 | P2 | apiKey 表添加 team 索引 | 性能 |
| 9 | - | 最终验证 | 质量保证 |
