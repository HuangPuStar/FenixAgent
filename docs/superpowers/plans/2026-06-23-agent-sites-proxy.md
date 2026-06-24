# Agent Sites 全包裹代理 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RCS 全包裹代理 agent-sites（`http://8.163.76.248:26778`），加多租户权限控制。新建 `agentSiteApp` 表存 app 映射 + platform token，4 档 visibility 控制业务前端访问。

**Architecture:** 三层代理 — L1 管理 API（`/web/agent-sites/apps/*`，RCS 鉴权，透传 master key）→ L2 PB Admin API（`/web/agent-sites/apps/{id}/api/*`，RCS 鉴权，注入 platform token 凭证代换）→ L3 业务前端（`/{appId}/*`，按 visibility 4 档鉴权，透传无鉴权/透传 PB Rules）。agent-sites URL 和 master key 存 RCS 环境变量，platform token 明文存 DB。

**Tech Stack:** Bun + Elysia + Drizzle ORM + React 19 + TanStack Router + Tailwind CSS v4 + shadcn/ui

**关键决策汇总：**
- Q1：全代理，业务前端按 visibility 控制公开/私有
- Q2：app 归属 org + owner(user)，org 内自动共享，member.role 控制写权限
- Q3：RCS 后端持有 platform token，用户透明
- Q4/Q6：业务前端 URL 直接 `/{appId}/`，跟 agent-sites 一致（推翻 `/sites/` 前缀）
- Q5：L2 PB Admin API 透传（`/{id}/api/*`），org 内任何成员可调
- Q7：4 档 visibility（private | org | authenticated | public），默认 private，owner+admin 可改
- Q8：API 字段 camelCase，`platformToken` 不在响应中返回
- Q10：删除 app 时先调 agent-sites DELETE 再 RCS DB hard delete

---

### Task 1: 环境变量 — 加 AGENT_SITES 配置项

**Files:**
- Modify: `src/env.ts`

- [ ] **Step 1: 在 envSchema 中加两个可选字段**

```typescript
// 在 envSchema 中，HINDSIGHT_MCP_URL 之后加：

// ── 可选：Agent Sites 代理 ──
AGENT_SITES_BASE_URL: z.string().optional(),
AGENT_SITES_MASTER_KEY: z.string().optional(),
```

- [ ] **Step 2: 运行 env 测试确认 schema 仍通过**

```bash
bun test src/__tests__/env-validation.test.ts
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/env.ts
git commit -m "feat(agent-sites): add AGENT_SITES_BASE_URL and AGENT_SITES_MASTER_KEY env vars

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 2: DB Schema — 加 agentSiteApp 表

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: 在 schema.ts 末尾（machine 表之后）加表定义**

```typescript
// ────────────────────────────────────────────
// Agent Sites 代理 — app 映射与凭证
// ────────────────────────────────────────────

export const agentSiteApp = pgTable(
  "agent_site_app",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    remoteAppId: varchar("remote_app_id", { length: 64 }).notNull(),
    name: varchar("name", { length: 32 }).notNull(),
    description: text("description"),
    platformToken: text("platform_token").notNull(),
    platformTokenId: varchar("platform_token_id", { length: 64 }).notNull(),
    visibility: varchar("visibility", { length: 20 }).notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    remoteAppIdIdx: uniqueIndex("idx_agent_site_app_remote_app_id").on(table.remoteAppId),
    orgVisibilityIdx: index("idx_agent_site_app_org_visibility").on(
      table.organizationId,
      table.visibility,
    ),
    orgIdx: index("idx_agent_site_app_org").on(table.organizationId),
    userIdx: index("idx_agent_site_app_user").on(table.userId),
  }),
);
```

- [ ] **Step 2: 生成迁移文件**

```bash
bun run db:generate --name add-agent-site-app
```
Expected: 生成 `drizzle/` 下的迁移 SQL 文件

- [ ] **Step 3: 同步到开发数据库**

```bash
bun run db:push
```
Expected: 表创建成功，无错误

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(agent-sites): add agentSiteApp table with visibility and platformToken

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 3: 客户端模块 — src/services/agent-sites.ts

**Files:**
- Create: `src/services/agent-sites.ts`

- [ ] **Step 1: 创建客户端模块**

```typescript
/** Agent Sites 远程 API 客户端。封装 master key 鉴权 + 错误处理。 */

import { env } from "../env";

function baseUrl(): string {
  const url = env.AGENT_SITES_BASE_URL;
  if (!url) throw new Error("AGENT_SITES_BASE_URL not configured");
  return url;
}

function masterKey(): string {
  const key = env.AGENT_SITES_MASTER_KEY;
  if (!key) throw new Error("AGENT_SITES_MASTER_KEY not configured");
  return key;
}

const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  // merge client signal with timeout signal
  const existing = init.signal;
  if (existing) {
    existing.addEventListener("abort", () => ctrl.abort());
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function agentSitesFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${baseUrl()}${path}`;
  const headers = new Headers(init.headers);
  headers.set("X-Master-Key", masterKey());
  if (!headers.has("content-type") && init.method !== "GET" && init.method !== "HEAD") {
    headers.set("content-type", "application/json");
  }
  return fetchWithTimeout(url, { ...init, headers });
}

export class AgentSitesError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentSitesError";
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body?.error?.message ?? body?.message ?? res.statusText;
    throw new AgentSitesError(res.status, message);
  }
  return res.json() as Promise<T>;
}

// ── L1 平台管理 API ──────────────────────────────

export interface RemoteApp {
  id: string;       // app-xxxxxxxx
  name: string;
  port: number;
  status: string;   // starting | running | error
  api_path: string;
  created_at: string;
}

/** POST /api/apps — 创建远程 app */
export async function createRemoteApp(name: string): Promise<RemoteApp> {
  const res = await agentSitesFetch("/api/apps", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const json = await handleResponse<{ data: RemoteApp }>(res);
  return json.data;
}

/** DELETE /api/apps/{id} — 删除远程 app */
export async function deleteRemoteApp(remoteAppId: string): Promise<void> {
  const res = await agentSitesFetch(`/api/apps/${encodeURIComponent(remoteAppId)}`, {
    method: "DELETE",
  });
  await handleResponse(res);
}

interface RemoteToken {
  token_id: string;
  app_id: string;
  token: string;
  status: string;
  issued_at: string;
}

/** POST /api/tokens — 申请 platform token */
export async function issuePlatformToken(remoteAppId: string): Promise<RemoteToken> {
  const res = await agentSitesFetch("/api/tokens", {
    method: "POST",
    body: JSON.stringify({ app_id: remoteAppId }),
  });
  const json = await handleResponse<{ data: RemoteToken }>(res);
  return json.data;
}

/** DELETE /api/tokens/{id} — 吊销 platform token */
export async function revokePlatformToken(tokenId: string): Promise<void> {
  const res = await agentSitesFetch(`/api/tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
  });
  await handleResponse(res);
}

/** PUT /api/apps/{id}/files/{*path} — 上传单个静态文件 */
export async function uploadRemoteFile(
  remoteAppId: string,
  filePath: string,
  body: BodyInit,
): Promise<{ data: { path: string; bytes: number } }> {
  const res = await agentSitesFetch(
    `/api/apps/${encodeURIComponent(remoteAppId)}/files/${encodeURIComponent(filePath)}`,
    { method: "PUT", headers: new Headers(), body },
  );
  return handleResponse(res);
}

/** POST /api/apps/{id}/files/bundle — 批量上传 gzip tar */
export async function uploadRemoteBundle(
  remoteAppId: string,
  body: BodyInit,
): Promise<{ data: { files: { path: string; bytes: number }[] } }> {
  const res = await agentSitesFetch(
    `/api/apps/${encodeURIComponent(remoteAppId)}/files/bundle`,
    { method: "POST", headers: new Headers(), body },
  );
  return handleResponse(res);
}

// ── L2/L3 透传 ───────────────────────────────────

/**
 * 透传请求到 agent-sites。不注入 master key——L2 用 platform token，
 * L3 无鉴权或 PB user token。调用方负责设置正确的 headers。
 */
export async function proxyToAgentSites(appId: string, path: string, request: Request): Promise<Response> {
  const targetUrl = `${baseUrl()}/${encodeURIComponent(appId)}${path}`;
  // rebuild URL with query string from original request
  const srcUrl = new URL(request.url);
  const url = new URL(targetUrl);
  srcUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie"); // RCS session cookie 不透传

  const init: RequestInit = {
    method: request.method,
    headers,
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  try {
    const res = await fetch(url.toString(), init);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(null, { status: 499, statusText: "Client Closed Request" });
    }
    return new Response(
      JSON.stringify({
        error: {
          type: "bad_gateway",
          message: `Agent Sites unreachable: ${err instanceof Error ? err.message : String(err)}`,
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

/** 判断 agent-sites 是否已配置 */
export function isAgentSitesConfigured(): boolean {
  return !!env.AGENT_SITES_BASE_URL && !!env.AGENT_SITES_MASTER_KEY;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/agent-sites.ts
git commit -m "feat(agent-sites): add agent-sites remote API client module

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 4: Repository — src/repositories/agent-site-app.ts

**Files:**
- Create: `src/repositories/agent-site-app.ts`
- Modify: `src/repositories/index.ts`

- [ ] **Step 1: 创建 repository 文件**

```typescript
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agentSiteApp } from "../db/schema";

export type AgentSiteAppRow = typeof agentSiteApp.$inferSelect;
export type AgentSiteAppInsert = typeof agentSiteApp.$inferInsert;

export type Visibility = "private" | "org" | "authenticated" | "public";

export interface CreateAppParams {
  organizationId: string;
  userId: string;
  remoteAppId: string;
  name: string;
  description?: string;
  platformToken: string;
  platformTokenId: string;
  visibility?: Visibility;
}

class AgentSiteAppRepo {
  async create(params: CreateAppParams): Promise<AgentSiteAppRow> {
    const [row] = await db
      .insert(agentSiteApp)
      .values({
        organizationId: params.organizationId,
        userId: params.userId,
        remoteAppId: params.remoteAppId,
        name: params.name,
        description: params.description ?? null,
        platformToken: params.platformToken,
        platformTokenId: params.platformTokenId,
        visibility: params.visibility ?? "private",
      })
      .returning();
    return row;
  }

  async listByOrg(organizationId: string): Promise<AgentSiteAppRow[]> {
    return db
      .select()
      .from(agentSiteApp)
      .where(eq(agentSiteApp.organizationId, organizationId))
      .orderBy(agentSiteApp.createdAt);
  }

  async getById(id: string): Promise<AgentSiteAppRow | undefined> {
    const rows = await db
      .select()
      .from(agentSiteApp)
      .where(eq(agentSiteApp.id, id))
      .limit(1);
    return rows[0];
  }

  async getByRemoteAppId(remoteAppId: string): Promise<AgentSiteAppRow | undefined> {
    const rows = await db
      .select()
      .from(agentSiteApp)
      .where(eq(agentSiteApp.remoteAppId, remoteAppId))
      .limit(1);
    return rows[0];
  }

  async update(
    id: string,
    data: Partial<Pick<AgentSiteAppRow, "name" | "description" | "visibility" | "platformToken" | "platformTokenId">>,
  ): Promise<AgentSiteAppRow | undefined> {
    const [row] = await db
      .update(agentSiteApp)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(agentSiteApp.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db.delete(agentSiteApp).where(eq(agentSiteApp.id, id));
    return (result as unknown as { count: number }).count > 0;
  }
}

export const agentSiteAppRepo = new AgentSiteAppRepo();
```

- [ ] **Step 2: 在 repositories/index.ts 加导出**

```typescript
export type { AgentSiteAppInsert, AgentSiteAppRow, Visibility } from "./agent-site-app";
export { agentSiteAppRepo } from "./agent-site-app";
```

- [ ] **Step 3: Commit**

```bash
git add src/repositories/agent-site-app.ts src/repositories/index.ts
git commit -m "feat(agent-sites): add agentSiteApp repository

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 5: Schema 定义 — src/schemas/agent-site.schema.ts

**Files:**
- Create: `src/schemas/agent-site.schema.ts`
- Modify: `src/schemas/index.ts`

- [ ] **Step 1: 创建 schema 文件**

```typescript
import * as z from "zod/v4";

/** Agent Sites App 响应对象 */
export const AgentSiteAppSchema = z.object({
  id: z.string().describe("RCS 内 app UUID。"),
  organizationId: z.string().describe("所属组织 ID。"),
  userId: z.string().describe("创建者用户 ID（owner）。"),
  remoteAppId: z.string().describe("agent-sites 远程 app id（形如 app-xxxxxxxx）。"),
  name: z.string().describe("展示名称。"),
  description: z.string().nullable().describe("描述。"),
  visibility: z.enum(["private", "org", "authenticated", "public"]).describe("业务前端可见性。"),
  createdAt: z.number().describe("创建时间（秒级时间戳）。"),
  updatedAt: z.number().describe("更新时间（秒级时间戳）。"),
});

export type AgentSiteApp = z.infer<typeof AgentSiteAppSchema>;

/** GET /web/agent-sites/apps 列表响应 */
export const AgentSiteAppListResponseSchema = z.object({
  success: z.literal(true),
  data: AgentSiteAppSchema.array(),
});

/** GET /web/agent-sites/apps/{id} 详情响应 */
export const AgentSiteAppDetailResponseSchema = z.object({
  success: z.literal(true),
  data: AgentSiteAppSchema,
});

/** POST /web/agent-sites/apps 创建请求 */
export const CreateAgentSiteAppRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, "name 必须为 kebab-case")
    .describe("app 展示名称（kebab-case，仅展示用不唯一）。"),
  description: z.string().optional().describe("可选描述。"),
  visibility: z
    .enum(["private", "org", "authenticated", "public"])
    .optional()
    .default("private")
    .describe("业务前端可见性，默认 private。"),
});

/** PATCH /web/agent-sites/apps/{id} 更新请求 */
export const UpdateAgentSiteAppRequestSchema = z.object({
  name: z.string().min(1).max(32).optional().describe("新的展示名称。"),
  description: z.string().optional().describe("新的描述。"),
  visibility: z
    .enum(["private", "org", "authenticated", "public"])
    .optional()
    .describe("新的可见性。"),
});

/** DELETE/POST rotate-token 等简单操作的成功响应 */
export const AgentSiteAppOkResponseSchema = z.object({
  success: z.literal(true),
});
```

- [ ] **Step 2: 在 schemas/index.ts 加导出**

```typescript
// Agent Sites
export {
  type AgentSiteApp,
  AgentSiteAppDetailResponseSchema,
  AgentSiteAppListResponseSchema,
  AgentSiteAppOkResponseSchema,
  AgentSiteAppSchema,
  type CreateAgentSiteAppRequest,
  CreateAgentSiteAppRequestSchema,
  type UpdateAgentSiteAppRequest,
  UpdateAgentSiteAppRequestSchema,
} from "./agent-site.schema";
```

- [ ] **Step 3: Commit**

```bash
git add src/schemas/agent-site.schema.ts src/schemas/index.ts
git commit -m "feat(agent-sites): add request/response schemas

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 6: 路由 — L1 管理 API + L2 代理

**Files:**
- Create: `src/routes/web/agent-sites.ts`
- Modify: `src/routes/web/index.ts`

- [ ] **Step 1: 创建 L1+L2 路由文件**

```typescript
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { requireOrgScope } from "../../plugins/require-team-scope";
import { agentSiteAppRepo } from "../../repositories/agent-site-app";
import type { AgentSiteAppInsert } from "../../repositories/agent-site-app";
import {
  createRemoteApp,
  deleteRemoteApp,
  issuePlatformToken,
  proxyToAgentSites,
  revokePlatformToken,
  uploadRemoteBundle,
  uploadRemoteFile,
} from "../../services/agent-sites";
import {
  AgentSiteAppDetailResponseSchema,
  AgentSiteAppListResponseSchema,
  AgentSiteAppOkResponseSchema,
  CreateAgentSiteAppRequestSchema,
  UpdateAgentSiteAppRequestSchema,
} from "../../schemas/agent-site.schema";

/** 将 DB row 转为 API 响应（秒级时间戳，不包含 platformToken） */
function toResponse(row: AgentSiteAppInsert & { id: string }) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    remoteAppId: row.remoteAppId,
    name: row.name,
    description: row.description ?? null,
    visibility: row.visibility ?? "private",
    createdAt: row.createdAt ? Math.floor(new Date(row.createdAt).getTime() / 1000) : 0,
    updatedAt: row.updatedAt ? Math.floor(new Date(row.updatedAt).getTime() / 1000) : 0,
  };
}

/** 判断当前用户是否对 app 有写权限（owner 或 org admin） */
function canWrite(row: { userId: string }, ctx: { userId: string; role: string }): boolean {
  return row.userId === ctx.userId || ctx.role === "owner" || ctx.role === "admin";
}

const app = new Elysia({ name: "web-agent-sites", prefix: "/agent-sites" })
  .use(authGuardPlugin)
  .model({
    "agent-site-app-list-response": AgentSiteAppListResponseSchema,
    "agent-site-app-detail-response": AgentSiteAppDetailResponseSchema,
    "agent-site-app-ok-response": AgentSiteAppOkResponseSchema,
    "create-agent-site-app-request": CreateAgentSiteAppRequestSchema,
    "update-agent-site-app-request": UpdateAgentSiteAppRequestSchema,
  })

  // ── L1: App CRUD ────────────────────────────────────

  .get(
    "/apps",
    async ({ store }) => {
      const authCtx = store.authContext!;
      const rows = await agentSiteAppRepo.listByOrg(authCtx.organizationId);
      return { success: true as const, data: rows.map(toResponse) };
    },
    {
      sessionAuth: true,
      requireOrgScope: true,
      response: "agent-site-app-list-response",
      detail: { tags: ["Agent Sites"], summary: "获取 agent sites app 列表", description: "返回当前组织下所有 app。", },
    },
  )

  .get(
    "/apps/:id",
    async ({ params, store }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return new Response(JSON.stringify({ error: { type: "not_found", message: "App 不存在" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return { success: true as const, data: toResponse(row) };
    },
    {
      sessionAuth: true,
      requireOrgScope: true,
      response: "agent-site-app-detail-response",
      detail: { tags: ["Agent Sites"], summary: "获取 agent site app 详情", description: "返回单个 app 的详细信息。", },
    },
  )

  .post(
    "/apps",
    async ({ store, body }) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      const b = body as { name: string; description?: string; visibility?: string };

      // 1. 在 agent-sites 创建远程 app
      const remote = await createRemoteApp(b.name);

      // 2. 申请 platform token
      const token = await issuePlatformToken(remote.id);

      // 3. 写入 RCS DB
      const row = await agentSiteAppRepo.create({
        organizationId: authCtx.organizationId,
        userId: user.id,
        remoteAppId: remote.id,
        name: remote.name,
        description: b.description,
        platformToken: token.token,
        platformTokenId: token.token_id,
        visibility: (b.visibility as "private" | "org" | "authenticated" | "public") ?? "private",
      });

      return { success: true as const, data: toResponse(row) };
    },
    {
      sessionAuth: true,
      requireOrgScope: true,
      body: "create-agent-site-app-request",
      response: "agent-site-app-detail-response",
      detail: { tags: ["Agent Sites"], summary: "创建 agent site app", description: "在 agent-sites 创建远程 app + 申请 token + 写 RCS DB。", },
    },
  )

  .patch(
    "/apps/:id",
    async ({ params, store, body }) => {
      const authCtx = store.authContext!;
      const b = body as { name?: string; description?: string; visibility?: string };
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return new Response(JSON.stringify({ error: { type: "not_found", message: "App 不存在" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (!canWrite(row, authCtx)) {
        return new Response(JSON.stringify({ error: { type: "forbidden", message: "无权限修改此 app" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      const updated = await agentSiteAppRepo.update(params.id, {
        name: b.name,
        description: b.description,
        visibility: b.visibility as "private" | "org" | "authenticated" | "public" | undefined,
      });
      return { success: true as const, data: toResponse(updated!) };
    },
    {
      sessionAuth: true,
      requireOrgScope: true,
      body: "update-agent-site-app-request",
      response: "agent-site-app-detail-response",
      detail: { tags: ["Agent Sites"], summary: "更新 agent site app", description: "修改 app 名称、描述或可见性。owner/admin 可操作。", },
    },
  )

  .delete(
    "/apps/:id",
    async ({ params, store }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return new Response(JSON.stringify({ error: { type: "not_found", message: "App 不存在" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (!canWrite(row, authCtx)) {
        return new Response(JSON.stringify({ error: { type: "forbidden", message: "无权限删除此 app" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      // 先调 agent-sites 删除远程 app
      await deleteRemoteApp(row.remoteAppId);
      // 再 RCS DB hard delete
      await agentSiteAppRepo.delete(params.id);
      return { success: true as const };
    },
    {
      sessionAuth: true,
      requireOrgScope: true,
      response: "agent-site-app-ok-response",
      detail: { tags: ["Agent Sites"], summary: "删除 agent site app", description: "删除远程 app + RCS DB 硬删除。owner/admin 可操作。", },
    },
  )

  // ── L1: Token 管理 ──────────────────────────────────

  .post(
    "/apps/:id/rotate-token",
    async ({ params, store }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return new Response(JSON.stringify({ error: { type: "not_found", message: "App 不存在" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (!canWrite(row, authCtx)) {
        return new Response(JSON.stringify({ error: { type: "forbidden", message: "无权限操作此 app" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      // 吊销旧 token（忽略 agent-sites 错误，旧 token 可能已过期）
      try {
        await revokePlatformToken(row.platformTokenId);
      } catch {
        console.warn(`[agent-sites] 吊销旧 token 失败 tokenId=${row.platformTokenId}，继续申请新 token`);
      }
      // 申请新 token
      const token = await issuePlatformToken(row.remoteAppId);
      await agentSiteAppRepo.update(params.id, {
        platformToken: token.token,
        platformTokenId: token.token_id,
      });
      return { success: true as const };
    },
    {
      sessionAuth: true,
      requireOrgScope: true,
      response: "agent-site-app-ok-response",
      detail: { tags: ["Agent Sites"], summary: "重签 platform token", description: "吊销旧 token + 申请新 token + 更新 DB。owner/admin 可操作。", },
    },
  )

  // ── L1: 文件上传 ────────────────────────────────────

  .put(
    "/apps/:id/files/:path",
    async ({ params, request, store }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return new Response(JSON.stringify({ error: { type: "not_found", message: "App 不存在" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (!canWrite(row, authCtx)) {
        return new Response(JSON.stringify({ error: { type: "forbidden", message: "无权限上传文件" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      const result = await uploadRemoteFile(row.remoteAppId, params.path, request.body!);
      return { success: true as const, data: result.data };
    },
    {
      sessionAuth: true,
      requireOrgScope: true,
      detail: { tags: ["Agent Sites"], summary: "上传前端静态文件", description: "单文件上传到 agent-sites。owner/admin 可操作。", },
    },
  )

  .post(
    "/apps/:id/files/bundle",
    async ({ params, request, store }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return new Response(JSON.stringify({ error: { type: "not_found", message: "App 不存在" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (!canWrite(row, authCtx)) {
        return new Response(JSON.stringify({ error: { type: "forbidden", message: "无权限上传文件" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      const result = await uploadRemoteBundle(row.remoteAppId, request.body!);
      return { success: true as const, data: result.data };
    },
    {
      sessionAuth: true,
      requireOrgScope: true,
      detail: { tags: ["Agent Sites"], summary: "批量上传前端文件", description: "gzip tar 批量上传到 agent-sites。owner/admin 可操作。", },
    },
  )

  // ── L2: PB Admin API 透传 ────────────────────────────

  .all(
    "/apps/:id/api/:path",
    async ({ params, request, store }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return new Response(JSON.stringify({ error: { type: "not_found", message: "App 不存在" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      // 注入 platform token（凭证代换），RCS 鉴权已由 sessionAuth + requireOrgScope 处理
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${row.platformToken}`);
      // 构造新 Request 以便 proxyToAgentSites 使用
      const proxyReq = new Request(request.url, {
        method: request.method,
        headers,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
        signal: request.signal,
      });
      return proxyToAgentSites(row.remoteAppId, `/api/${params.path}`, proxyReq);
    },
    {
      sessionAuth: true,
      requireOrgScope: true,
      detail: { tags: ["Agent Sites"], summary: "透传 PB Admin API", description: "注入 platform token 后透传到 agent-sites PB API。任何 org 成员可调。", hide: true },
    },
  );

export default app;
```

- [ ] **Step 2: 在 web/index.ts 注册路由**

```typescript
import webAgentSites from "./agent-sites";
```

在 `.use(webAuth)` 之后加：

```typescript
  .use(webAgentSites)
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/web/agent-sites.ts src/routes/web/index.ts
git commit -m "feat(agent-sites): add L1 management + L2 proxy routes

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 7: 路由 — L3 业务前端代理（`/{appId}/*` 公开路由）

**Files:**
- Create: `src/routes/agent-sites-proxy.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 创建 L3 代理路由**

```typescript
import Elysia from "elysia";
import { agentSiteAppRepo } from "../repositories/agent-site-app";
import { isAgentSitesConfigured, proxyToAgentSites } from "../services/agent-sites";
import { authGuardPlugin, type AuthContext } from "../plugins/auth";
import type { Visibility } from "../repositories/agent-site-app";

/** 内存 LRU 缓存：remoteAppId → (visibility, organizationId, userId)，60s TTL */
const appCache = new Map<string, { row: { visibility: Visibility; organizationId: string; userId: string }; ts: number }>();
const CACHE_TTL_MS = 60_000;

async function getAppByRemoteId(remoteAppId: string) {
  const cached = appCache.get(remoteAppId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.row;
  const row = await agentSiteAppRepo.getByRemoteAppId(remoteAppId);
  if (!row) return null;
  const slim: { visibility: Visibility; organizationId: string; userId: string } = {
    visibility: row.visibility as Visibility,
    organizationId: row.organizationId,
    userId: row.userId,
  };
  appCache.set(remoteAppId, { row: slim, ts: Date.now() });
  return slim;
}

/** 校验 app_id 格式：必须以 app- 开头 */
const APP_ID_RE = /^app-[a-z0-9]+$/;

/**
 * 按 visibility 检查访问权限。返回 null 表示允许访问，返回 Response 表示拒绝。
 * authCtx 可能为 null（未登录用户），此时只有 public visibility 允许访问。
 */
function checkVisibility(
  slim: { visibility: Visibility; organizationId: string; userId: string },
  authCtx: AuthContext | null,
): Response | null {
  if (slim.visibility === "public") return null;
  if (!authCtx) {
    // 未登录 → 302 重定向到登录页（response 仍由调用方构造以注入 redirect）
    return new Response("", { status: 302 });
  }
  if (slim.visibility === "private" && authCtx.userId !== slim.userId) {
    return new Response("Forbidden — 此 app 仅创建者可访问", { status: 403 });
  }
  if (slim.visibility === "org" && authCtx.organizationId !== slim.organizationId) {
    return new Response("Forbidden — 此 app 仅组织内可访问", { status: 403 });
  }
  // "authenticated" 已通过 authCtx 非 null 检查
  return null;
}

const app = new Elysia({ name: "agent-sites-proxy" })
  .use(authGuardPlugin);

// 业务前端：/{appId}（仅 app 首页，无子路径）
app.get("/:appId", async ({ params, request, store, set }) => {
  if (!APP_ID_RE.test(params.appId)) return; // 不是 agent-sites app，留给其他路由
  if (!isAgentSitesConfigured()) return;
  const slim = await getAppByRemoteId(params.appId);
  if (!slim) return; // 不在 RCS DB 中 → Elysia 继续匹配其他路由

  const authCtx: AuthContext | null = store.authContext ?? null;
  const reject = checkVisibility(slim, authCtx);
  if (reject) {
    if (reject.status === 302) {
      set.status = 302;
      set.headers = { location: `/login?redirect=${encodeURIComponent(new URL(request.url).pathname)}` };
      return "";
    }
    set.status = reject.status;
    return reject.body;
  }
  return proxyToAgentSites(params.appId, "/", request);
});

// 业务前端：/{appId}/*（子路径：静态文件 + PB API）
// Elysia 用 :path* 做 catch-all，匹配 /{appId}/a/b/c 等多段路径
app.all("/:appId/:path*", async ({ params, request, store, set }) => {
  if (!APP_ID_RE.test(params.appId)) return;
  if (!isAgentSitesConfigured()) return;

  const slim = await getAppByRemoteId(params.appId);
  if (!slim) return;

  const authCtx: AuthContext | null = store.authContext ?? null;
  const reject = checkVisibility(slim, authCtx);
  if (reject) {
    if (reject.status === 302) {
      set.status = 302;
      set.headers = { location: `/login?redirect=${encodeURIComponent(new URL(request.url).pathname)}` };
      return "";
    }
    set.status = reject.status;
    return reject.body;
  }

  // params.path 是剩余全部路径（如 "api/collections" 或 "index.html"）
  const subPath = `/${params.path ?? ""}`;
  return proxyToAgentSites(params.appId, subPath, request);
});

export default app;
```

- [ ] **Step 2: 在 src/index.ts 注册 L3 路由（放在 webApp 之后、workflowStaticApp 之前）**

```typescript
import agentSitesProxyApp from "./routes/agent-sites-proxy";
```

在 `.use(webApp)` 之后加：

```typescript
  // Agent Sites L3 business frontend proxy (/app-* prefix)
  .use(agentSitesProxyApp)
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/agent-sites-proxy.ts src/index.ts
git commit -m "feat(agent-sites): add L3 business frontend proxy with visibility check

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 8: 前端 — 路由 + 页面组件

**Files:**
- Create: `web/src/routes/agent/_panel/sites.tsx`
- Create: `web/src/pages/agent-panel/pages/AgentSitesPage.tsx`

- [ ] **Step 1: 创建路由文件**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentSitesPage").then((m) => ({ default: m.AgentSitesPage })),
);

export const Route = createFileRoute("/agent/_panel/sites")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <Page />
    </Suspense>
  ),
});
```

- [ ] **Step 2: 创建页面组件**

```tsx
import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { NS } from "@/src/i18n";
import { agentSitesApi } from "@/src/api/sdk";

interface SiteApp {
  id: string;
  name: string;
  remoteAppId: string;
  description: string | null;
  visibility: "private" | "org" | "authenticated" | "public";
  createdAt: number;
}

const VISIBILITY_LABELS: Record<string, string> = {
  private: "仅自己",
  org: "组织内",
  authenticated: "已登录用户",
  public: "公开",
};

const VISIBILITY_BADGE_CLASSES: Record<string, string> = {
  private: "bg-red-100 text-red-700",
  org: "bg-yellow-100 text-yellow-700",
  authenticated: "bg-blue-100 text-blue-700",
  public: "bg-green-100 text-green-700",
};

export function AgentSitesPage() {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [apps, setApps] = useState<SiteApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formVisibility, setFormVisibility] = useState<string>("private");
  const [submitting, setSubmitting] = useState(false);

  const fetchApps = useCallback(async () => {
    try {
      setLoading(true);
      const res = await agentSitesApi.list();
      setApps(res.data);
    } catch {
      toast.error("加载 app 列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchApps(); }, [fetchApps]);

  const handleCreate = async () => {
    try {
      setSubmitting(true);
      await agentSitesApi.create({ name: formName, description: formDesc || undefined, visibility: formVisibility });
      toast.success("App 创建成功");
      setFormOpen(false);
      setFormName("");
      setFormDesc("");
      setFormVisibility("private");
      fetchApps();
    } catch (err: any) {
      toast.error(err?.message ?? "创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确认删除此 app？此操作不可撤销。")) return;
    try {
      await agentSitesApi.delete(id);
      toast.success("App 已删除");
      fetchApps();
    } catch (err: any) {
      toast.error(err?.message ?? "删除失败");
    }
  };

  const handleRotateToken = async (id: string) => {
    if (!confirm("确认重签 token？旧 token 将立即失效。")) return;
    try {
      await agentSitesApi.rotateToken(id);
      toast.success("Token 已重签");
    } catch (err: any) {
      toast.error(err?.message ?? "重签失败");
    }
  };

  const handleOpenSite = (remoteAppId: string) => {
    window.open(`/${remoteAppId}/`, "_blank");
  };

  return (
    <div className="flex flex-col h-full p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Agent Sites</h1>
        <button
          className="px-4 py-2 bg-brand text-white rounded-md text-sm font-medium hover:bg-brand/90 transition-colors"
          onClick={() => setFormOpen(!formOpen)}
        >
          + 创建 App
        </button>
      </div>

      {formOpen && (
        <div className="mb-6 p-4 border rounded-lg bg-surface">
          <div className="grid gap-3">
            <input
              className="px-3 py-2 border rounded-md text-sm bg-background"
              placeholder="App 名称 (kebab-case)"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
            <input
              className="px-3 py-2 border rounded-md text-sm bg-background"
              placeholder="描述（可选）"
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
            />
            <select
              className="px-3 py-2 border rounded-md text-sm bg-background"
              value={formVisibility}
              onChange={(e) => setFormVisibility(e.target.value)}
            >
              {Object.entries(VISIBILITY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                className="px-4 py-2 bg-brand text-white rounded-md text-sm disabled:opacity-50"
                onClick={handleCreate}
                disabled={!formName || submitting}
              >
                {submitting ? "创建中..." : "创建"}
              </button>
              <button
                className="px-4 py-2 border rounded-md text-sm"
                onClick={() => setFormOpen(false)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-secondary border-b">
                <th className="py-2 font-medium">名称</th>
                <th className="py-2 font-medium">App ID</th>
                <th className="py-2 font-medium">可见性</th>
                <th className="py-2 font-medium">创建时间</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={app.id} className="border-b hover:bg-surface-hover">
                  <td className="py-2">
                    <div className="font-medium">{app.name}</div>
                    {app.description && <div className="text-text-tertiary text-xs">{app.description}</div>}
                  </td>
                  <td className="py-2 font-mono text-xs">{app.remoteAppId}</td>
                  <td className="py-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${VISIBILITY_BADGE_CLASSES[app.visibility] ?? ""}`}>
                      {VISIBILITY_LABELS[app.visibility] ?? app.visibility}
                    </span>
                  </td>
                  <td className="py-2 text-text-secondary">{new Date(app.createdAt * 1000).toLocaleDateString()}</td>
                  <td className="py-2">
                    <div className="flex gap-1">
                      <button
                        className="px-2 py-1 text-xs border rounded hover:bg-surface-hover"
                        onClick={() => handleOpenSite(app.remoteAppId)}
                      >
                        打开
                      </button>
                      <button
                        className="px-2 py-1 text-xs border rounded hover:bg-surface-hover text-orange-600"
                        onClick={() => handleRotateToken(app.id)}
                      >
                        重签 Token
                      </button>
                      <button
                        className="px-2 py-1 text-xs border rounded hover:bg-surface-hover text-red-600"
                        onClick={() => handleDelete(app.id)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {apps.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-text-tertiary">
                    暂无 app，点击"创建 App"开始
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 在 SDK 中加 agentSitesApi**

在 `web/src/api/sdk.ts` 中加：

```typescript
export const agentSitesApi = {
  list: () => fetch("/web/agent-sites/apps", { credentials: "include" }).then(r => r.json()),
  get: (id: string) => fetch(`/web/agent-sites/apps/${id}`, { credentials: "include" }).then(r => r.json()),
  create: (body: { name: string; description?: string; visibility?: string }) =>
    fetch("/web/agent-sites/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    }).then(r => r.json()),
  update: (id: string, body: { name?: string; description?: string; visibility?: string }) =>
    fetch(`/web/agent-sites/apps/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    }).then(r => r.json()),
  delete: (id: string) =>
    fetch(`/web/agent-sites/apps/${id}`, { method: "DELETE", credentials: "include" }).then(r => r.json()),
  rotateToken: (id: string) =>
    fetch(`/web/agent-sites/apps/${id}/rotate-token`, { method: "POST", credentials: "include" }).then(r => r.json()),
  uploadFile: (id: string, path: string, body: BodyInit) =>
    fetch(`/web/agent-sites/apps/${id}/files/${path}`, {
      method: "PUT",
      credentials: "include",
      body,
    }).then(r => r.json()),
  uploadBundle: (id: string, body: BodyInit) =>
    fetch(`/web/agent-sites/apps/${id}/files/bundle`, {
      method: "POST",
      credentials: "include",
      body,
    }).then(r => r.json()),
};
```

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/agent/_panel/sites.tsx web/src/pages/agent-panel/pages/AgentSitesPage.tsx web/src/api/sdk.ts
git commit -m "feat(agent-sites): add frontend sites management page

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 9: 前端 — 侧边栏导航 + i18n

**Files:**
- Modify: `web/src/pages/agent-panel/AgentSidebarConfig.tsx`
- Modify: `web/src/i18n/locales/zh/components.json`
- Modify: `web/src/i18n/locales/en/components.json`

- [ ] **Step 1: 在侧边栏导航加 Agent Sites 入口**

在 `AgentSidebarConfig.tsx` 的 `useNavGroups()` 中，第二个 group 末尾加：

```typescript
{ id: "sites", labelKey: "agentPanel:sites", icon: Globe },
```

`import` 加 `Globe`：

```typescript
import { BookOpen, Bot, Brain, Clock, Cpu, Globe, KeyRound, Plug, Plus, Settings, Users, Workflow } from "lucide-react";
```

- [ ] **Step 2: 加中文翻译**

在 `web/src/i18n/locales/zh/agent-panel.json` 加：

```json
"sites": "Agent Sites"
```

- [ ] **Step 3: 加英文翻译**

在 `web/src/i18n/locales/en/agent-panel.json` 加：

```json
"sites": "Agent Sites"
```

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/agent-panel/AgentSidebarConfig.tsx web/src/i18n/locales/zh/agent-panel.json web/src/i18n/locales/en/agent-panel.json
git commit -m "feat(agent-sites): add sidebar nav entry and i18n

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 10: 测试 — Service 层单元测试

**Files:**
- Create: `src/__tests__/agent-sites-service.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

// 测试 fetchWithTimeout 不依赖真实网络
describe("agent-sites service — URL 构造", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AGENT_SITES_BASE_URL = "http://localhost:9999";
    process.env.AGENT_SITES_MASTER_KEY = "test-master-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  test("isAgentSitesConfigured 配置完整返回 true", async () => {
    const { isAgentSitesConfigured } = await import("../services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(true);
  });

  test("isAgentSitesConfigured 缺失 BASE_URL 返回 false", async () => {
    delete process.env.AGENT_SITES_BASE_URL;
    const { isAgentSitesConfigured } = await import("../services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(false);
  });

  test("isAgentSitesConfigured 缺失 MASTER_KEY 返回 false", async () => {
    delete process.env.AGENT_SITES_MASTER_KEY;
    const { isAgentSitesConfigured } = await import("../services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(false);
  });
});

describe("agent-sites service — 错误类型", () => {
  test("AgentSitesError 正确构造", async () => {
    const { AgentSitesError } = await import("../services/agent-sites");
    const err = new AgentSitesError(401, "Unauthorized");
    expect(err.status).toBe(401);
    expect(err.message).toBe("Unauthorized");
    expect(err.name).toBe("AgentSitesError");
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
bun test src/__tests__/agent-sites-service.test.ts
```
Expected: PASS (2 describe blocks)

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/agent-sites-service.test.ts
git commit -m "test(agent-sites): add service layer unit tests

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 11: 测试 — Repository 层测试

**Files:**
- Create: `src/__tests__/agent-sites-repo.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

describe("agentSiteAppRepo", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  test("create 写入 DB 后返回 row", async () => {
    const recordId = "test-uuid";
    const insertResult = {
      id: recordId,
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-abc12345",
      name: "test-app",
      description: null,
      platformToken: "tok-xxx.yyy",
      platformTokenId: "tok-001",
      visibility: "private",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    stubDb({
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([insertResult]),
        }),
      }),
    });

    const { agentSiteAppRepo } = await import("../repositories/agent-site-app");
    const row = await agentSiteAppRepo.create({
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-abc12345",
      name: "test-app",
      platformToken: "tok-xxx.yyy",
      platformTokenId: "tok-001",
    });
    expect(row.id).toBe(recordId);
    expect(row.remoteAppId).toBe("app-abc12345");
    expect(row.visibility).toBe("private");
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
bun test src/__tests__/agent-sites-repo.test.ts
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/agent-sites-repo.test.ts
git commit -m "test(agent-sites): add repository unit test

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 12: 测试 — 路由 L1 集成测试

**Files:**
- Create: `src/__tests__/agent-sites-routes.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { clearOrgCache, setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubDb } from "../test-utils/helpers";
import webAgentSites from "../routes/web/agent-sites";

const TEST_APP_ID = "test-app-uuid";
const TEST_REMOTE_APP_ID = "app-abc12345";

function makeAppRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_APP_ID,
    organizationId: "test-org",
    userId: "test-user",
    remoteAppId: TEST_REMOTE_APP_ID,
    name: "my-app",
    description: null,
    platformToken: "tok-xxx.yyy",
    platformTokenId: "tok-001",
    visibility: "private",
    createdAt: new Date("2026-06-23"),
    updatedAt: new Date("2026-06-23"),
    ...overrides,
  };
}

describe("agent-sites L1 routes", () => {
  beforeEach(() => {
    resetAllStubs();
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-org", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-org", userId: "test-user", role: "owner" });
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    clearOrgCache();
  });

  test("GET /apps 返回空列表", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(new Request("http://localhost/agent-sites/apps"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  test("GET /apps/:id org 不匹配返回 404", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([makeAppRow({ organizationId: "other-org" })]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}`));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
bun test src/__tests__/agent-sites-routes.test.ts
```
Expected: PASS (2 describe blocks)

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/agent-sites-routes.test.ts
git commit -m "test(agent-sites): add L1 route integration tests

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

### Task 13: 最终检查 — precheck + 验证

**Files:** (无修改，仅验证)

- [ ] **Step 1: 运行 precheck**

```bash
bun run precheck
```
Expected: 格式、import 排序、tsc、biome check 全部通过

- [ ] **Step 2: 构建前端**

```bash
bun run build:web
```
Expected: 构建成功，无错误

- [ ] **Step 3: 运行全量测试**

```bash
bun test src/__tests__/
```
Expected: 所有测试通过（含新增的 agent-sites 测试）

- [ ] **Step 4: 修复任何 precheck 问题后最终 commit**

```bash
git add -A
git commit -m "chore(agent-sites): precheck fixes and final verification

Co-Authored-By: deepseek-v4-pro <zai-org@claude-code-best.win>"
```

---

