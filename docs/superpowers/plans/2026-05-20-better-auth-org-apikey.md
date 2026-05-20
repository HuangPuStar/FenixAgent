# Better-Auth Organization + API Key 全面迁移

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除自建的 team/api-key 体系，全面切换到 `@better-auth/organization` + `@better-auth/api-key` 插件，实现 better-auth 标准优先的认证授权架构。

**Architecture:** 安装 better-auth 的 organization 和 api-key 插件，删除自建的 `team`/`team_member`/`api_key` 三张表及全部相关服务。所有 `teamId` 引用改为 `organizationId`，AuthContext 从 better-auth organization API 构建。API key 认证走 better-auth 内建的 verify 流程。前端 auth client 增加对应插件，TeamContext 改为 OrgContext。

**Tech Stack:** better-auth v1.6.8, @better-auth/organization, @better-auth/api-key, Drizzle ORM, Elysia, React

---

## 影响范围总览

### 删除的文件
- `src/auth/api-key-service.ts` — 自建 API key 服务
- `src/services/team.ts` — 自建 team 服务
- `src/routes/web/teams.ts` — team 路由
- `src/routes/web/api-keys.ts` — 自建 API key 路由
- `src/schemas/api-key.schema.ts` — API key schema 定义

### 删除的数据库表
- `team` — 自建团队表
- `team_member` — 自建成员表
- `api_key` — 自建 API key 表

### 需要修改的核心文件（teamId → organizationId）
**数据库层（1 文件）：**
- `src/db/schema.ts` — 移除 3 张表，16 个表中的 `team_id` 列改为 `organization_id`，索引名同步更新

**认证层（3 文件）：**
- `src/auth/better-auth.ts` — 增加 organization + apiKey 插件
- `src/plugins/auth.ts` — AuthContext.teamId → organizationId，apiKeyAuth macro 改用 better-auth verify
- `src/plugins/require-team-scope.ts` — 改为 requireOrgScope

**服务层（~12 文件）：**
- `src/services/team-context.ts` — 重写为 org-context.ts，从 better-auth organization API 加载
- `src/services/meta-agent.ts` — API key 创建改用 better-auth server API
- `src/services/config/provider.ts` — teamId → organizationId
- `src/services/config/model.ts` — teamId → organizationId
- `src/services/config/agent-config.ts` — teamId → organizationId
- `src/services/config/mcp-server.ts` — teamId → organizationId
- `src/services/config/skill.ts` — teamId → organizationId
- `src/services/config/user-config.ts` — teamId → organizationId
- `src/services/config/aggregate.ts` — teamId → organizationId
- `src/services/config/config-pg.ts` — re-export 更新
- `src/services/environment-web.ts` — teamId → organizationId
- `src/services/environment-core.ts` — teamId → organizationId
- `src/services/instance.ts` — teamId → organizationId
- `src/services/task.ts` — teamId → organizationId
- `src/services/knowledge-base.ts` — teamId → organizationId
- `src/services/skill.ts` — teamId → organizationId
- `src/services/knowledge-runtime.ts` — teamId → organizationId

**Repository 层（~3 文件）：**
- `src/repositories/environment.ts` — teamId → organizationId
- `src/repositories/session.ts` — teamId → organizationId
- `src/repositories/task.ts` — teamId → organizationId
- `src/repositories/knowledge-base.ts` — teamId → organizationId
- `src/repositories/index.ts` — re-export 更新

**路由层（~15 文件）：**
- `src/routes/web/config/providers.ts` — teamId → organizationId
- `src/routes/web/config/agents.ts` — teamId → organizationId
- `src/routes/web/config/skills-route.ts` — teamId → organizationId
- `src/routes/web/config/mcp.ts` — teamId → organizationId
- `src/routes/web/environments.ts` — teamId → organizationId
- `src/routes/web/sessions.ts` — teamId → organizationId
- `src/routes/web/tasks.ts` — teamId → organizationId
- `src/routes/web/knowledge-bases.ts` — teamId → organizationId
- `src/routes/web/workflow-defs.ts` — teamId → organizationId
- `src/routes/web/workflow-engine.ts` — teamId → organizationId
- `src/routes/web/meta-agent.ts` — teamId → organizationId
- `src/routes/web/share-links.ts` — teamId → organizationId
- `src/routes/v1/environments.ts` — teamId → organizationId
- `src/routes/v1/environments.work.ts` — teamId → organizationId
- `src/routes/v1/sessions.ts` — teamId → organizationId
- `src/routes/v2/worker.ts` — teamId → organizationId
- `src/routes/v2/code-sessions.ts` — teamId → organizationId
- `src/routes/acp/index.ts` — teamId → organizationId
- `src/index.ts` — 移除旧路由引用，增加新路由

**前端（~7 文件）：**
- `web/src/lib/auth-client.ts` — 增加 organization + apiKey client 插件
- `web/src/contexts/TeamContext.tsx` → 重写为 `OrgContext.tsx`
- `web/src/components/TeamSwitcher.tsx` → 改为 OrgSwitcher
- `web/src/pages/TeamsPage.tsx` → 改为 OrgsPage，使用 better-auth client
- `web/src/pages/ApiKeyManager.tsx` — 改用 better-auth apiKey client
- `web/src/components/shell/Sidebar.tsx` — 引用更新
- `web/src/api/client.ts` — activeTeamId → activeOrganizationId

**Schema/类型层：**
- `src/schemas/index.ts` — 移除 api-key.schema re-exports
- `src/plugins/auth.ts` — AuthContext 接口更新

---

## Task 1: 安装 better-auth 插件包

**Files:**
- Modify: `package.json`（新增依赖）

- [ ] **Step 1: 安装 @better-auth/api-key 和 @better-auth/organization**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
bun add @better-auth/api-key @better-auth/organization
```

- [ ] **Step 2: 验证安装成功**

```bash
bun --version
ls node_modules/@better-auth/api-key/package.json node_modules/@better-auth/organization/package.json
```

Expected: 两个 package.json 都存在

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: 安装 @better-auth/api-key 和 @better-auth/organization 插件"
```

---

## Task 2: 配置 better-auth 插件（server 端）

**Files:**
- Modify: `src/auth/better-auth.ts`

- [ ] **Step 1: 更新 better-auth 配置，增加 organization 和 apiKey 插件**

将 `src/auth/better-auth.ts` 改为：

```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "@better-auth/organization";
import { apiKey } from "@better-auth/api-key";
import { db } from "../db";
import * as schema from "../db/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  trustedOrigins: ["http://localhost:5173"],
  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      membershipLimit: 100,
    }),
    apiKey({
      prefix: "rcs",
    }),
  ],
});
```

- [ ] **Step 2: Commit**

```bash
git add src/auth/better-auth.ts
git commit -m "feat: better-auth 增加 organization + apiKey 插件配置"
```

---

## Task 3: 生成 better-auth 新表并更新 Drizzle schema

**Files:**
- Modify: `src/db/schema.ts`

这是最大的数据库变更。需要：
1. 运行 better-auth generate 生成新表定义
2. 从 schema.ts 删除 `team`、`teamMember`、`apiKey` 三张表
3. 将所有 `teamId`（`team_id`）列改为 `organizationId`（`organization_id`）
4. 更新所有相关索引名（`idx_*_team_*` → `idx_*_org_*`）
5. 移除 session 表的 `activeTeamId` 列（better-auth organization 插件内建 active org 管理）

- [ ] **Step 1: 运行 better-auth generate 生成新表的 Drizzle schema**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
bunx auth generate
```

这会在 better-auth 管理的目录下生成 organization、member、api_key 等表的 Drizzle 定义。检查生成结果，将新表定义合并到 `src/db/schema.ts` 中。

> **注意：** better-auth 的 api_key 表名可能与我们的旧表名 `api_key` 冲突。由于我们删除旧表，better-auth 生成的新表可以直接使用。如果 better-auth 生成的表名不同（如 `apiKey`），需要确认适配。

- [ ] **Step 2: 删除 schema.ts 中的旧表定义**

删除 `team` 表定义（约第 30-40 行）：

```typescript
// 删除整段
export const team = pgTable("team", { ... });
```

删除 `teamMember` 表定义（约第 42-58 行）：

```typescript
// 删除整段
export const teamMember = pgTable("team_member", { ... });
```

删除 `apiKey` 表定义（约第 102-122 行）：

```typescript
// 删除整段
export const apiKey = pgTable("api_key", { ... });
```

- [ ] **Step 3: 移除 session 表的 activeTeamId 列**

在 session 表定义中删除这一行：

```typescript
// 删除这行
activeTeamId: uuid("active_team_id").references(() => team.id, { onDelete: "set null" }),
```

- [ ] **Step 4: 全局替换 teamId → organizationId**

在 schema.ts 中执行以下替换：

| 旧值 | 新值 |
|------|------|
| `teamId: uuid("team_id")` | `organizationId: uuid("organization_id")` |
| `table.teamId` | `table.organizationId` |
| 索引名 `idx_*_team_*` | `idx_*_org_*`（如 `idx_provider_team_name` → `idx_provider_org_name`） |
| `idx_api_key_team_id` | 删除（apiKey 表已移除） |
| `idx_share_link_team_id` | `idx_share_link_org_id` |
| `idx_environment_team_name` | `idx_environment_org_name` |
| `idx_knowledge_base_team_slug` | `idx_knowledge_base_org_slug` |
| `idx_knowledge_base_team_status` | `idx_knowledge_base_org_status` |
| `idx_scheduled_task_team_id` | `idx_scheduled_task_org_id` |
| `idx_im_channel_team_platform` | `idx_im_channel_org_platform` |
| `idx_provider_team_name` | `idx_provider_org_name` |
| `idx_agent_config_team_name` | `idx_agent_config_org_name` |
| `idx_mcp_server_team_name` | `idx_mcp_server_org_name` |
| `idx_skill_global` | 更新为 `.on(table.organizationId, table.name)` |
| `idx_skill_workspace` | 更新为 `.on(table.organizationId, table.environmentId, table.name)` |
| `idx_workflow_team_name` | `idx_workflow_org_name` |
| `idx_workflow_event_team` | `idx_workflow_event_org` |
| `idx_workflow_snapshot_team` | `idx_workflow_snapshot_org` |
| `idx_workflow_node_output_team` | `idx_workflow_node_output_org` |
| `teamId: uuid("team_id")` (userConfig 表) | `organizationId: uuid("organization_id")` |

每张表的 FK 引用也需要更新，确保 `references` 指向正确的表。由于 better-auth 会创建 `organization` 表，FK 应该指向 `() => organization.id`。但如果 better-auth 通过 adapter 自动管理这些表，我们的 schema 中可能不需要显式 FK 引用。根据 better-auth Drizzle adapter 的实际行为调整。

- [ ] **Step 5: 更新 schema barrel export**

确保删除的表（`team`, `teamMember`, `apiKey`）不再从 schema 中导出。新增的 better-auth 管理的表（`organization`, `member`, `api_key` 等）如果通过 generate 添加到了 schema.ts，确保正确导出。

- [ ] **Step 6: 推送 schema 变更到数据库**

```bash
# 先推送新的 better-auth 表
bunx drizzle-kit push

# 如果 push 不成功（旧表冲突），手动执行：
# DROP TABLE IF EXISTS api_key CASCADE;
# DROP TABLE IF EXISTS team_member CASCADE;
# DROP TABLE IF EXISTS team CASCADE;
# 然后重新 push
bunx drizzle-kit push
```

- [ ] **Step 7: 验证数据库表结构**

```bash
# 连接数据库检查新表是否存在
psql "$DATABASE_URL" -c "\dt" | grep -E "organization|member|api_key"
```

Expected: `organization`、`member`（或类似名）、`api_key` 表存在

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: 数据库 schema 全面迁移 teamId→organizationId，移除旧表，适配 better-auth 插件表"
```

---

## Task 4: 更新 AuthContext 和认证层

**Files:**
- Modify: `src/plugins/auth.ts`
- Modify: `src/plugins/require-team-scope.ts`

- [ ] **Step 1: 更新 AuthContext 接口**

在 `src/plugins/auth.ts` 中：

```typescript
// 旧
export interface AuthContext {
  teamId: string;
  userId: string;
  role: "owner" | "admin" | "member";
}

// 新
export interface AuthContext {
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member";
}
```

- [ ] **Step 2: 重写 sessionAuth macro 的 loadTeamContext 调用**

`sessionAuth` macro 中 `beforeHandle` 保持调用 `loadOrgContext`（在 Task 5 中重命名），但签名不变，只是内部实现改用 better-auth organization API：

```typescript
sessionAuth(enabled: boolean) {
  if (!enabled) return {};
  return {
    beforeHandle: async ({ store, request, error }: any) => {
      if (_testAuth) {
        store.user = _testAuth.user;
        store.authSession = _testAuth.session;
        if (_testAuth.authContext) store.authContext = _testAuth.authContext;
        return;
      }
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) {
        return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
      }
      store.user = { id: session.user.id, email: session.user.email, name: session.user.name };
      store.authSession = {
        id: session.session.id,
        userId: session.session.userId,
        token: session.session.token,
      };
      const { loadOrgContext } = await import("../services/org-context");
      const ctx = await loadOrgContext(store.user, request);
      if (ctx) {
        store.authContext = ctx;
      }
    },
  };
},
```

- [ ] **Step 3: 重写 apiKeyAuth macro**

改为使用 better-auth 的 `auth.api.verifyApiKey()`：

```typescript
apiKeyAuth(enabled: boolean) {
  if (!enabled) return {};
  return {
    beforeHandle: async ({ store, request, error }: any) => {
      const token = extractToken(request);
      if (!token) {
        return error(401, { error: { type: "unauthorized", message: "Missing API key" } });
      }

      // 0. Environment secret match（保留）
      const { environmentRepo } = await import("../repositories");
      const envRecord = await environmentRepo.getBySecret(token);
      if (envRecord && envRecord.userId) {
        const user = await lookupUserById(envRecord.userId);
        if (user) {
          store.user = user;
          store.authEnvironmentId = envRecord.id;
          const organizationId = envRecord.organizationId ?? envRecord.userId;
          const role = envRecord.organizationId && envRecord.organizationId !== envRecord.userId ? "member" : "owner";
          store.authContext = { organizationId, userId: user.id, role: role as "owner" | "admin" | "member" };
          return;
        }
      }

      // 1. better-auth API Key 验证
      const result = await auth.api.verifyApiKey({ key: token });
      if (result.valid && result.key) {
        const apiKeyMeta = result.key as any;
        const userId = apiKeyMeta.userId;
        const user = await lookupUserById(userId);
        if (user) {
          store.user = user;
          // 从 API key 的 metadata 或 organizationId 获取组织上下文
          const orgId = apiKeyMeta.organizationId || apiKeyMeta.metadata?.organizationId;
          if (orgId) {
            store.authContext = {
              organizationId: orgId,
              userId: user.id,
              role: (apiKeyMeta.metadata?.role as "owner" | "admin" | "member") || "owner",
            };
            return;
          }
          // 无有效组织上下文
          return error(403, { error: { type: "forbidden", message: "API key has no valid organization context" } });
        }
      }

      return error(401, { error: { type: "unauthorized", message: "Invalid API key" } });
    },
  };
},
```

- [ ] **Step 4: 重写 require-team-scope.ts → require-org-scope.ts**

将 `src/plugins/require-team-scope.ts` 内容改为：

```typescript
import type { AuthContext } from "./auth";
import { errorResponse } from "./auth";

/**
 * 校验当前认证上下文是否有权访问指定组织的资源。
 * 返回 undefined 表示通过，否则返回 403 Response。
 */
export function requireOrgScope(
  authContext: AuthContext | null,
  resourceOrgId: string | null | undefined,
): Response | undefined {
  if (!authContext || !resourceOrgId) {
    return errorResponse(403, { error: { type: "forbidden", message: "Access denied" } });
  }
  if (authContext.organizationId !== resourceOrgId) {
    return errorResponse(403, { error: { type: "forbidden", message: "Resource does not belong to your organization" } });
  }
  return undefined;
}
```

可以保留旧文件名但导出 `requireOrgScope`，或者重命名为 `require-org-scope.ts` 并更新所有引用。

- [ ] **Step 5: Commit**

```bash
git add src/plugins/auth.ts src/plugins/require-team-scope.ts
git commit -m "feat: AuthContext.teamId→organizationId，apiKeyAuth 改用 better-auth verify，requireOrgScope"
```

---

## Task 5: 重写 team-context → org-context

**Files:**
- Create: `src/services/org-context.ts`
- Delete: `src/services/team-context.ts`

- [ ] **Step 1: 创建 `src/services/org-context.ts`**

```typescript
import type { AuthContext } from "../plugins/auth";

// ────────────────────────────────────────────
// 测试注入
// ────────────────────────────────────────────

let _testOrgContext: AuthContext | null = null;

export function setTestOrgContext(ctx: AuthContext | null) {
  _testOrgContext = ctx;
}

/** 从请求中解析 activeOrganizationId（header > query param） */
function extractActiveOrgId(request: Request): string | null {
  const header = request.headers.get("x-active-org-id");
  if (header) return header;
  const url = new URL(request.url);
  const query = url.searchParams.get("activeOrganizationId");
  if (query) return query;
  return null;
}

/**
 * 从 user + request 加载组织上下文。
 * 解析 activeOrganizationId，通过 better-auth organization API 查角色，构建 AuthContext。
 * 无组织时自动创建个人组织。
 */
export async function loadOrgContext(user: { id: string }, request: Request): Promise<AuthContext | null> {
  if (_testOrgContext) return _testOrgContext;
  try {
    const { auth } = await import("../auth/better-auth");

    const activeOrgId = extractActiveOrgId(request);
    if (activeOrgId) {
      // 通过 better-auth API 检查用户是否为该组织成员
      const member = await auth.api.getMember({
        query: { organizationId: activeOrgId, userId: user.id },
      });
      if (member) {
        return {
          organizationId: activeOrgId,
          userId: user.id,
          role: (member as any).role as "owner" | "admin" | "member",
        };
      }
    }

    // fallback: 列出用户的组织，取第一个
    const orgs = await auth.api.listOrganizations({
      headers: new Headers({ authorization: `Bearer ${user.id}` }),
    });
    const orgList = Array.isArray(orgs) ? orgs : [];
    if (orgList.length > 0) {
      const org = orgList[0];
      const member = await auth.api.getMember({
        query: { organizationId: org.id, userId: user.id },
      });
      if (member) {
        return {
          organizationId: org.id,
          userId: user.id,
          role: (member as any).role as "owner" | "admin" | "member",
        };
      }
    }

    // 无组织 → 自动创建个人组织
    const personalOrg = await auth.api.createOrganization({
      name: `${user.id} 的组织`,
      slug: `personal-${user.id}`,
    }, {
      headers: new Headers({ authorization: `Bearer ${user.id}` }),
    });
    if (personalOrg) {
      return {
        organizationId: (personalOrg as any).id,
        userId: user.id,
        role: "owner",
      };
    }
  } catch (e: any) {
    console.error("[org-context] Failed to load:", e.message);
  }
  return null;
}
```

> **注意：** `auth.api` 的 server-side 调用方式需要根据 better-auth v1.6.8 的实际 API 确认。better-auth server API 通常需要传入 session headers 或直接传 userId。上面的代码是示意性的，实际实现时需要查阅 better-auth 文档确认正确的 server-side API 调用方式。

- [ ] **Step 2: 更新所有 loadTeamContext 引用为 loadOrgContext**

所有 `import { loadTeamContext }` 改为 `import { loadOrgContext }`，所有 `loadTeamContext(...)` 调用改为 `loadOrgContext(...)`。这涉及以下文件：

- `src/plugins/auth.ts`（已在 Task 4 处理）
- `src/routes/acp/index.ts`
- `src/routes/web/` 下所有路由文件

- [ ] **Step 3: 删除 `src/services/team-context.ts`**

```bash
rm src/services/team-context.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/services/org-context.ts src/services/team-context.ts
git commit -m "feat: 新建 org-context.ts（better-auth organization 加载），删除 team-context.ts"
```

---

## Task 6: 删除自建 team 和 api-key 服务

**Files:**
- Delete: `src/services/team.ts`
- Delete: `src/auth/api-key-service.ts`
- Delete: `src/routes/web/teams.ts`
- Delete: `src/routes/web/api-keys.ts`
- Delete: `src/schemas/api-key.schema.ts`
- Modify: `src/schemas/index.ts`（移除 api-key re-exports）
- Modify: `src/index.ts`（移除旧路由 import）

- [ ] **Step 1: 删除文件**

```bash
rm src/services/team.ts
rm src/auth/api-key-service.ts
rm src/routes/web/teams.ts
rm src/routes/web/api-keys.ts
rm src/schemas/api-key.schema.ts
```

- [ ] **Step 2: 更新 `src/schemas/index.ts`**

删除 API Keys 的 re-export 块：

```typescript
// 删除以下行
export {
  type ApiKeyInfo,
  ApiKeyInfoSchema,
  type CreateApiKeyRequest,
  CreateApiKeyRequestSchema,
  type CreateApiKeyResponse,
  CreateApiKeyResponseSchema,
  OkResponseSchema,
  type UpdateApiKeyLabelRequest,
  UpdateApiKeyLabelRequestSchema,
} from "./api-key.schema";
```

- [ ] **Step 3: 更新 `src/index.ts`**

移除以下 import：

```typescript
// 删除
import webApiKeys from "./routes/web/api-keys";
import webTeams from "./routes/web/teams";
```

移除 `.use(webApiKeys)` 和 `.use(webTeams)` 挂载。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: 删除自建 team/api-key 服务、路由、schema，由 better-auth 插件接管"
```

---

## Task 7: 新建 organization 和 api-key 路由

**Files:**
- Create: `src/routes/web/organizations.ts`
- Create: `src/routes/web/api-keys-v2.ts`（或复用原路径）

- [ ] **Step 1: 创建 organization 路由 `src/routes/web/organizations.ts`**

这个路由包装 better-auth organization 的 server API，为前端提供统一的 `/web/organizations` 端点：

```typescript
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { auth } from "../../auth/better-auth";
import { loadOrgContext } from "../../services/org-context";

const app = new Elysia({ name: "web-organizations", prefix: "/web" }).use(authGuardPlugin);

app.post("/organizations", async ({ store, body, error, request }: any) => {
  const b = (body as any) ?? {};
  const user = store.user!;

  switch (b.action) {
    case "list": {
      const orgs = await auth.api.listOrganizations({ headers: request.headers });
      return { success: true, data: Array.isArray(orgs) ? orgs : [] };
    }
    case "get": {
      const authCtx = await loadOrgContext(user, request);
      if (!authCtx) return error(500, { success: false, error: { code: "NO_ORG_CONTEXT" } });
      const org = await auth.api.getOrganization({ query: { organizationId: b.organizationId ?? authCtx.organizationId } });
      const members = await auth.api.listMembers({ query: { organizationId: b.organizationId ?? authCtx.organizationId } });
      return { success: true, data: { ...org, members: Array.isArray(members) ? members : [] } };
    }
    case "create": {
      if (!b.name || !b.slug)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name and slug required" } });
      try {
        const org = await auth.api.createOrganization({ name: b.name, slug: b.slug, metadata: b.description ?? null }, { headers: request.headers });
        return { success: true, data: org };
      } catch (err: any) {
        const msg = err.message || "";
        if (msg.includes("unique") || msg.includes("duplicate")) {
          return error(409, { success: false, error: { code: "ALREADY_EXISTS", message: "slug 已被使用" } });
        }
        throw err;
      }
    }
    case "update": {
      const authCtx = await loadOrgContext(user, request);
      if (!authCtx) return error(500, { success: false, error: { code: "NO_ORG_CONTEXT" } });
      if (!["owner", "admin"].includes(authCtx.role))
        return error(403, { success: false, error: { code: "FORBIDDEN", message: "owner or admin only" } });
      const org = await auth.api.updateOrganization({ data: b.data, organizationId: b.organizationId ?? authCtx.organizationId }, { headers: request.headers });
      return { success: true, data: org };
    }
    case "delete": {
      const authCtx = await loadOrgContext(user, request);
      if (!authCtx) return error(500, { success: false, error: { code: "NO_ORG_CONTEXT" } });
      if (authCtx.role !== "owner")
        return error(403, { success: false, error: { code: "FORBIDDEN", message: "owner only" } });
      await auth.api.deleteOrganization({ organizationId: authCtx.organizationId }, { headers: request.headers });
      return { success: true, data: { deleted: true } };
    }
    case "switch": {
      if (!b.organizationId)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "organizationId required" } });
      await auth.api.setActiveOrganization({ organizationId: b.organizationId }, { headers: request.headers });
      const authCtx = await loadOrgContext(user, request);
      return { success: true, data: authCtx };
    }
    case "list-members": {
      const authCtx = await loadOrgContext(user, request);
      if (!authCtx) return error(500, { success: false, error: { code: "NO_ORG_CONTEXT" } });
      const members = await auth.api.listMembers({ query: { organizationId: b.organizationId ?? authCtx.organizationId } });
      return { success: true, data: Array.isArray(members) ? members : [] };
    }
    case "add-member": {
      const authCtx = await loadOrgContext(user, request);
      if (!authCtx) return error(500, { success: false, error: { code: "NO_ORG_CONTEXT" } });
      if (!["owner", "admin"].includes(authCtx.role))
        return error(403, { success: false, error: { code: "FORBIDDEN", message: "owner or admin only" } });
      const member = await auth.api.addMember({ organizationId: authCtx.organizationId, userId: b.userId, role: b.role || "member" }, { headers: request.headers });
      return { success: true, data: member };
    }
    case "remove-member": {
      const authCtx = await loadOrgContext(user, request);
      if (!authCtx) return error(500, { success: false, error: { code: "NO_ORG_CONTEXT" } });
      if (!["owner", "admin"].includes(authCtx.role))
        return error(403, { success: false, error: { code: "FORBIDDEN", message: "owner or admin only" } });
      await auth.api.removeMember({ organizationId: authCtx.organizationId, userId: b.userId }, { headers: request.headers });
      return { success: true, data: { removed: true } };
    }
    case "update-role": {
      const authCtx = await loadOrgContext(user, request);
      if (!authCtx) return error(500, { success: false, error: { code: "NO_ORG_CONTEXT" } });
      if (authCtx.role !== "owner")
        return error(403, { success: false, error: { code: "FORBIDDEN", message: "owner only" } });
      await auth.api.updateMemberRole({ organizationId: authCtx.organizationId, userId: b.userId, role: b.role }, { headers: request.headers });
      return { success: true, data: { updated: true } };
    }
    case "get-current": {
      const authCtx = await loadOrgContext(user, request);
      let org = null;
      if (authCtx) {
        org = await auth.api.getOrganization({ query: { organizationId: authCtx.organizationId } });
      }
      return { success: true, data: { organizationId: authCtx?.organizationId, role: authCtx?.role, organization: org } };
    }
    default:
      return error(400, { success: false, error: { code: "UNKNOWN_ACTION", message: `Unknown action: ${b.action}` } });
  }
}, { sessionAuth: true });

export default app;
```

> **注意：** better-auth organization 的 server API 方法名和参数需要根据 v1.6.8 文档确认。上面的方法名（`listOrganizations`、`createOrganization`、`getMember` 等）是参考 better-auth 文档的合理推测，实际实现时需要查阅 API reference。

- [ ] **Step 2: 创建 API key 路由 `src/routes/web/api-keys-v2.ts`**

包装 better-auth api-key 的 server API：

```typescript
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { auth } from "../../auth/better-auth";
import { loadOrgContext } from "../../services/org-context";

const app = new Elysia({ name: "web-api-keys-v2", prefix: "/web" }).use(authGuardPlugin);

/** GET /web/apiKeys — 列出当前组织的 API keys */
app.get("/apiKeys", async ({ store, request }: any) => {
  const authCtx = await loadOrgContext(store.user!, request);
  if (!authCtx) return [];

  const result = await auth.api.listApiKeys({ headers: request.headers });
  return Array.isArray(result) ? result : [];
}, { sessionAuth: true });

/** POST /web/apiKeys — 创建 API key */
app.post("/apiKeys", async ({ store, body, request }: any) => {
  const authCtx = await loadOrgContext(store.user!, request);
  if (!authCtx) return { error: { type: "forbidden", message: "No organization context" } };

  const b = body as { name?: string; expiresIn?: number };
  const result = await auth.api.createApiKey({
    name: b.name || "Default",
    prefix: "rcs",
    expiresIn: b.expiresIn || 60 * 60 * 24 * 365, // 默认 1 年
    metadata: { organizationId: authCtx.organizationId, role: authCtx.role },
  }, { headers: request.headers });

  return result;
}, { sessionAuth: true });

/** DELETE /web/apiKeys/:id — 删除 API key */
app.delete("/apiKeys/:id", async ({ store, params, error, request }: any) => {
  const keyId = params.id;
  await auth.api.deleteApiKey({ keyId }, { headers: request.headers });
  return { ok: true };
}, { sessionAuth: true });

export default app;
```

- [ ] **Step 3: 在 `src/index.ts` 注册新路由**

```typescript
import webOrganizations from "./routes/web/organizations";
import webApiKeysV2 from "./routes/web/api-keys-v2";

// 在路由挂载区域添加
.use(webOrganizations)
.use(webApiKeysV2)
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/organizations.ts src/routes/web/api-keys-v2.ts src/index.ts
git commit -m "feat: 新建 organization + api-key 路由，包装 better-auth server API"
```

---

## Task 8: 更新所有 config 服务（teamId → organizationId）

**Files:**
- Modify: `src/services/config/provider.ts`
- Modify: `src/services/config/model.ts`
- Modify: `src/services/config/agent-config.ts`
- Modify: `src/services/config/mcp-server.ts`
- Modify: `src/services/config/skill.ts`
- Modify: `src/services/config/user-config.ts`
- Modify: `src/services/config/aggregate.ts`

- [ ] **Step 1: 全局搜索替换 config 服务中的 teamId**

在 `src/services/config/` 目录下执行以下替换：

| 旧模式 | 新模式 |
|--------|--------|
| `ctx.teamId` | `ctx.organizationId` |
| `.where(eq(table.teamId,` | `.where(eq(table.organizationId,` |
| `teamId: ctx.teamId` | `organizationId: ctx.organizationId` |

每个文件的具体替换：

**provider.ts:**
- `eq(provider.teamId, ctx.teamId)` → `eq(provider.organizationId, ctx.organizationId)`
- `teamId: ctx.teamId` → `organizationId: ctx.organizationId`

**model.ts:**
- 同上模式

**agent-config.ts:**
- 同上模式

**mcp-server.ts:**
- 同上模式

**skill.ts:**
- 同上模式，注意 `environmentId` 相关的查询不受影响

**user-config.ts:**
- 同上模式

**aggregate.ts:**
- 同上模式

- [ ] **Step 2: Commit**

```bash
git add src/services/config/
git commit -m "feat: config 服务 teamId→organizationId 全面替换"
```

---

## Task 9: 更新其他服务层文件

**Files:**
- Modify: `src/services/environment-web.ts`
- Modify: `src/services/environment-core.ts`
- Modify: `src/services/instance.ts`
- Modify: `src/services/task.ts`
- Modify: `src/services/knowledge-base.ts`
- Modify: `src/services/skill.ts`
- Modify: `src/services/knowledge-runtime.ts`
- Modify: `src/services/meta-agent.ts`

- [ ] **Step 1: 在所有服务文件中执行 teamId → organizationId 替换**

在每个文件中：
- `ctx.teamId` → `ctx.organizationId`
- `authCtx.teamId` → `authCtx.organizationId`
- `table.teamId` → `table.organizationId`
- `teamId:` → `organizationId:`（对象字面量中）
- `teamId` 参数名 → `organizationId`（如果作为参数）

**meta-agent.ts 特殊处理：**

`createMetaApiKey` 函数需要改用 better-auth server API：

```typescript
// 旧实现
async function createMetaApiKey(ctx: AuthContext): Promise<string> {
  const expiresAt = new Date(Date.now() + META_KEY_EXPIRY_MS);
  const { fullKey } = await createApiKey(ctx.userId, META_KEY_LABEL, ctx.teamId, { expiresAt });
  return fullKey;
}

// 新实现 — 使用 better-auth server API
async function createMetaApiKey(ctx: AuthContext): Promise<string> {
  const { auth } = await import("../auth/better-auth");
  const result = await auth.api.createApiKey({
    name: META_KEY_LABEL,
    prefix: "rcs",
    expiresIn: META_KEY_EXPIRY_MS / 1000, // 秒
    userId: ctx.userId,
    metadata: { organizationId: ctx.organizationId, role: ctx.role, type: "meta-temp" },
  });
  return (result as any).key;
}
```

同时 `ensureMetaEnvironment` 中的 `extraEnv` 不变（`USER_META_API_KEY` 仍然是环境变量注入）。

- [ ] **Step 2: Commit**

```bash
git add src/services/
git commit -m "feat: 服务层 teamId→organizationId 全面替换，meta-agent 改用 better-auth API key"
```

---

## Task 10: 更新 Repository 层

**Files:**
- Modify: `src/repositories/environment.ts`
- Modify: `src/repositories/session.ts`
- Modify: `src/repositories/task.ts`
- Modify: `src/repositories/knowledge-base.ts`
- Modify: `src/repositories/index.ts`

- [ ] **Step 1: 在所有 repo 文件中执行 teamId → organizationId 替换**

同样的模式：
- `teamId` 参数/属性 → `organizationId`
- `.teamId` Drizzle 列引用 → `.organizationId`
- SQL 条件中的 `team_id` → `organization_id`

- [ ] **Step 2: 更新接口定义**

检查 repository 接口（如 `IEnvironmentRepo`、`IScheduledTaskRepo` 等）中的 `teamId` 参数，统一改为 `organizationId`。

- [ ] **Step 3: Commit**

```bash
git add src/repositories/
git commit -m "feat: repository 层 teamId→organizationId 全面替换"
```

---

## Task 11: 更新所有路由文件

**Files:**
- Modify: `src/routes/web/config/providers.ts`
- Modify: `src/routes/web/config/agents.ts`
- Modify: `src/routes/web/config/skills-route.ts`
- Modify: `src/routes/web/config/mcp.ts`
- Modify: `src/routes/web/environments.ts`
- Modify: `src/routes/web/sessions.ts`
- Modify: `src/routes/web/tasks.ts`
- Modify: `src/routes/web/knowledge-bases.ts`
- Modify: `src/routes/web/workflow-defs.ts`
- Modify: `src/routes/web/workflow-engine.ts`
- Modify: `src/routes/web/meta-agent.ts`
- Modify: `src/routes/web/share-links.ts`
- Modify: `src/routes/v1/environments.ts`
- Modify: `src/routes/v1/environments.work.ts`
- Modify: `src/routes/v1/sessions.ts`
- Modify: `src/routes/v2/worker.ts`
- Modify: `src/routes/v2/code-sessions.ts`
- Modify: `src/routes/acp/index.ts`

- [ ] **Step 1: 在所有路由文件中执行以下替换**

| 旧模式 | 新模式 |
|--------|--------|
| `import { loadTeamContext }` | `import { loadOrgContext }` |
| `loadTeamContext(` | `loadOrgContext(` |
| `authCtx.teamId` | `authCtx.organizationId` |
| `ctx.teamId` | `ctx.organizationId` |
| `requireTeamScope` | `requireOrgScope` |
| `import ... requireTeamScope` | `import ... requireOrgScope` |
| `import ... teamService` | 删除（不再需要） |
| `setTestTeamContext` | `setTestOrgContext` |

- [ ] **Step 2: 更新 v1/v2 路由中的 requireTeamScope 调用**

所有 `requireTeamScope(store.authContext, resource.teamId)` 改为 `requireOrgScope(store.authContext, resource.organizationId)`。

- [ ] **Step 3: Commit**

```bash
git add src/routes/
git commit -m "feat: 路由层 teamId→organizationId 全面替换，loadTeamContext→loadOrgContext"
```

---

## Task 12: 更新 store.ts 和 transport 层

**Files:**
- Modify: `src/store.ts`
- Modify: `src/transport/acp-ws-handler.ts`
- Modify: `src/transport/acp-relay-handler.ts`

- [ ] **Step 1: 检查 store.ts 中的 teamId 引用**

`src/store.ts` 中的 `EnvironmentRecord` 等类型如果有 `teamId` 字段，需要改为 `organizationId`。

- [ ] **Step 2: 检查 transport 层的 teamId 引用**

ACP WebSocket handler 和 relay handler 中如果有 `teamId` 引用，同步更新。

- [ ] **Step 3: Commit**

```bash
git add src/store.ts src/transport/
git commit -m "feat: store + transport 层 teamId→organizationId"
```

---

## Task 13: 前端 auth-client 更新

**Files:**
- Modify: `web/src/lib/auth-client.ts`

- [ ] **Step 1: 增加 organization + apiKey client 插件**

```typescript
import { createAuthClient } from "better-auth/react";
import { organizationClient } from "@better-auth/organization/client";
import { apiKeyClient } from "@better-auth/api-key/client";

export const authClient = createAuthClient({
  baseURL: "",
  plugins: [
    organizationClient(),
    apiKeyClient(),
  ],
});

export const { useSession, signIn, signUp, signOut } = authClient;
```

- [ ] **Step 2: Commit**

```bash
git add web/src/lib/auth-client.ts
git commit -m "feat: 前端 auth client 增加 organization + apiKey 插件"
```

---

## Task 14: 前端 TeamContext → OrgContext 重写

**Files:**
- Create: `web/src/contexts/OrgContext.tsx`
- Delete: `web/src/contexts/TeamContext.tsx`
- Modify: `web/src/components/TeamSwitcher.tsx` → 重写为 `OrgSwitcher.tsx`

- [ ] **Step 1: 创建 `web/src/contexts/OrgContext.tsx`**

```typescript
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { authClient } from "../lib/auth-client";

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  metadata?: unknown;
}

interface OrgWithRole extends OrgInfo {
  role: string;
}

interface OrgContextValue {
  org: OrgInfo | null;
  role: string | null;
  orgs: OrgWithRole[];
  loading: boolean;
  switchOrg: (orgId: string) => Promise<void>;
  refreshOrgs: () => Promise<void>;
}

const STORAGE_KEY = "active_org_id";

const OrgContext = createContext<OrgContextValue | null>(null);

/** 给全局 fetch 注入 X-Active-Org-Id header */
let fetchInterceptorInstalled = false;
function installFetchInterceptor() {
  if (fetchInterceptorInstalled) return;
  fetchInterceptorInstalled = true;
  const origFetch = window.fetch;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const activeOrgId = localStorage.getItem(STORAGE_KEY);
    if (activeOrgId) {
      const headers = new Headers(init?.headers);
      if (!headers.has("X-Active-Org-Id")) headers.set("X-Active-Org-Id", activeOrgId);
      init = { ...init, headers };
    }
    return origFetch(input, init);
  };
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgWithRole[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshOrgs = useCallback(async () => {
    try {
      // 使用 better-auth organization client
      const { data: orgList } = await authClient.organization.list();
      if (orgList) {
        setOrgs(orgList as OrgWithRole[]);
        const activeOrgId = localStorage.getItem(STORAGE_KEY);
        const active = activeOrgId
          ? (orgList as OrgWithRole[]).find((o) => o.id === activeOrgId)
          : orgList[0];
        if (active) {
          setOrg(active);
          setRole((active as any).role || "owner");
          localStorage.setItem(STORAGE_KEY, active.id);
        }
      }
    } catch (err) {
      console.error("Failed to load org context:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    installFetchInterceptor();
    refreshOrgs();
  }, [refreshOrgs]);

  const switchOrg = useCallback(async (orgId: string) => {
    localStorage.setItem(STORAGE_KEY, orgId);
    await authClient.organization.setActive({ organizationId: orgId });
    window.location.reload();
  }, []);

  return (
    <OrgContext.Provider value={{ org, role, orgs, loading, switchOrg, refreshOrgs }}>
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg() {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used within OrgProvider");
  return ctx;
}
```

- [ ] **Step 2: 重写 TeamSwitcher → OrgSwitcher**

将 `web/src/components/TeamSwitcher.tsx` 重命名为 `OrgSwitcher.tsx`，内部 `useTeam()` 改为 `useOrg()`，变量名从 `team` 改为 `org`：

```typescript
import { Check, ChevronDown, Building2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useOrg } from "../contexts/OrgContext";

export function OrgSwitcher() {
  const { org, orgs, switchOrg } = useOrg();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (!org) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={[
          "flex items-center gap-1.5 px-2 py-1 rounded-md text-sm font-medium",
          "text-text-primary hover:bg-surface-hover",
          "transition-colors duration-150",
        ].join(" ")}
      >
        <Building2 className="w-4 h-4 text-text-dim" />
        <span className="max-w-[120px] truncate">{org.name}</span>
        <ChevronDown className="w-3.5 h-3.5 text-text-dim" />
      </button>

      {open && (
        <div
          className={[
            "absolute bottom-full left-0 mb-1 min-w-[200px]",
            "bg-surface-1 border border-border-subtle rounded-lg shadow-lg",
            "py-1 z-50",
          ].join(" ")}
        >
          {orgs.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => {
                switchOrg(o.id);
                setOpen(false);
              }}
              className={[
                "flex items-center gap-2 w-full px-3 py-2 text-sm text-left",
                "hover:bg-surface-hover transition-colors",
                o.id === org.id ? "text-brand font-medium" : "text-text-secondary",
              ].join(" ")}
            >
              {o.id === org.id && <Check className="w-3.5 h-3.5" />}
              <span className={o.id !== org.id ? "ml-[20px]" : ""}>{o.name}</span>
              <span className="ml-auto text-[11px] text-text-dim">{o.role}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 更新所有引用 TeamContext 的文件**

全局搜索 `useTeam`、`TeamProvider`、`TeamSwitcher` 并替换：
- `TeamProvider` → `OrgProvider`
- `useTeam` → `useOrg`
- `TeamSwitcher` → `OrgSwitcher`
- `web/src/contexts/TeamContext` → `web/src/contexts/OrgContext`

涉及文件：
- `web/src/App.tsx`（如果挂载了 TeamProvider）
- `web/src/components/shell/Sidebar.tsx`
- `web/src/pages/TeamsPage.tsx`
- 其他引用

- [ ] **Step 4: 删除旧文件**

```bash
rm web/src/contexts/TeamContext.tsx
rm web/src/components/TeamSwitcher.tsx
```

- [ ] **Step 5: Commit**

```bash
git add web/src/contexts/ web/src/components/OrgSwitcher.tsx web/src/components/TeamSwitcher.tsx web/src/App.tsx web/src/components/shell/Sidebar.tsx
git commit -m "feat: 前端 TeamContext→OrgContext 重写，使用 better-auth organization client"
```

---

## Task 15: 前端 TeamsPage → OrgsPage 重写

**Files:**
- Create: `web/src/pages/OrgsPage.tsx`
- Delete: `web/src/pages/TeamsPage.tsx`

- [ ] **Step 1: 创建 OrgsPage**

基于 TeamsPage 的 UI 结构，将所有 `teamApi` 调用改为 `/web/organizations` 端点，或者直接使用 better-auth client：

- `teamApi({ action: "list" })` → `authClient.organization.list()`
- `teamApi({ action: "create" })` → `authClient.organization.create()`
- `teamApi({ action: "list-members" })` → `authClient.organization.listMembers()`
- 其他操作类推

或保持使用 `/web/organizations` 路由（与后端 Task 7 对应）。

- [ ] **Step 2: 更新路由引用**

在 `web/src/App.tsx` 中将 `TeamsPage` 路由改为 `OrgsPage`。

- [ ] **Step 3: 删除旧文件**

```bash
rm web/src/pages/TeamsPage.tsx
```

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/OrgsPage.tsx web/src/pages/TeamsPage.tsx web/src/App.tsx
git commit -m "feat: TeamsPage→OrgsPage 重写，使用 better-auth organization API"
```

---

## Task 16: 前端 ApiKeyManager 重写

**Files:**
- Modify: `web/src/pages/ApiKeyManager.tsx`

- [ ] **Step 1: 改用 better-auth apiKey client**

将所有 `/web/apiKeys` 调用改为 `authClient.apiKey.*`：

```typescript
// 加载 key 列表
const { data } = await authClient.apiKey.list();

// 创建 key
const { data } = await authClient.apiKey.create({ name: label });

// 删除 key
await authClient.apiKey.delete({ keyId: id });
```

或保持使用 `/web/apiKeys` 路由（与后端 Task 7 的 api-keys-v2 对应）。

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/ApiKeyManager.tsx
git commit -m "feat: ApiKeyManager 改用 better-auth apiKey client"
```

---

## Task 17: 前端 API client 更新

**Files:**
- Modify: `web/src/api/client.ts`

- [ ] **Step 1: 更新 SSE 辅助函数**

```typescript
// 旧
export function createSessionEventSource(sessionId: string): EventSource {
  const uuid = getUuid();
  const activeTeamId = localStorage.getItem("active_team_id");
  const params = new URLSearchParams();
  if (uuid) params.set("uuid", uuid);
  if (activeTeamId) params.set("activeTeamId", activeTeamId);
  // ...
}

// 新
export function createSessionEventSource(sessionId: string): EventSource {
  const uuid = getUuid();
  const activeOrgId = localStorage.getItem("active_org_id");
  const params = new URLSearchParams();
  if (uuid) params.set("uuid", uuid);
  if (activeOrgId) params.set("activeOrganizationId", activeOrgId);
  const query = params.toString();
  const url = query ? `/web/sessions/${sessionId}/events?${query}` : `/web/sessions/${sessionId}/events`;
  return new EventSource(url, { withCredentials: true });
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/api/client.ts
git commit -m "feat: 前端 API client activeTeamId→activeOrganizationId"
```

---

## Task 18: 更新 env.ts（RCS_API_KEYS 保留但注释更新）

**Files:**
- Modify: `src/env.ts`

- [ ] **Step 1: 更新 RCS_API_KEYS 的注释**

```typescript
// 旧
RCS_API_KEYS: z.string().min(1, "RCS_API_KEYS is required — used for acp-link / worker JWT signing"),

// 新（保留但说明用途变更）
RCS_API_KEYS: z.string().min(1, "RCS_API_KEYS is required — used for worker JWT signing only"),
```

API key 认证不再使用 RCS_API_KEYS，仅保留用于 JWT 签名。

- [ ] **Step 2: Commit**

```bash
git add src/env.ts
git commit -m "docs: RCS_API_KEYS 注释更新为仅用于 JWT 签名"
```

---

## Task 19: 更新测试文件

**Files:**
- Modify: 所有 `src/__tests__/*.test.ts` 中引用 `AuthContext.teamId`、`loadTeamContext`、`teamService`、`createApiKey` 等的测试
- Modify: 所有 `web/src/__tests__/*.test.ts` 中引用 team 相关的测试

- [ ] **Step 1: 搜索所有测试中的 teamId/apiKey 引用**

```bash
grep -rn "teamId\|loadTeamContext\|teamService\|createApiKey\|validateApiKeyAndGetUser\|requireTeamScope\|setTestTeamContext\|api-key-service" src/__tests__/ --include="*.ts" | head -50
```

- [ ] **Step 2: 逐一更新测试文件**

每个测试文件需要：
- `setTestTeamContext(...)` → `setTestOrgContext(...)`
- `{ teamId: "xxx", userId: "xxx", role: "owner" }` → `{ organizationId: "xxx", userId: "xxx", role: "owner" }`
- mock `../auth/api-key-service` → mock better-auth 相关模块
- mock `../services/team` → mock better-auth organization 相关模块

- [ ] **Step 3: 运行测试确认**

```bash
bun test src/__tests__/ 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/ web/src/__tests__/
git commit -m "test: 更新所有测试 teamId→organizationId，适配 better-auth 插件"
```

---

## Task 20: 类型检查 + Lint + 构建验证

**Files:**
- 可能需要修复的类型错误

- [ ] **Step 1: 运行类型检查**

```bash
bun run typecheck 2>&1 | head -50
```

修复所有 `teamId` 相关的类型错误。重点关注：
- `AuthContext` 接口变更引起的类型不匹配
- Drizzle schema 变更引起的列名不匹配
- better-auth 插件类型导入

- [ ] **Step 2: 运行 Lint**

```bash
bun run lint 2>&1 | head -30
```

- [ ] **Step 3: 运行 Format**

```bash
bun run format
```

- [ ] **Step 4: 构建前端**

```bash
bun run build:web
```

- [ ] **Step 5: 最终 Commit**

```bash
git add -A
git commit -m "chore: 类型检查 + lint 修复 + 前端构建验证"
```

---

## Task 21: 更新 CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 CLAUDE.md 中的所有 teamId/team 引用**

主要更新区域：
1. **认证层**：移除 `api-key-service.ts` 引用，改为 better-auth 插件
2. **多租户**：team → organization，`AuthContext.teamId` → `AuthContext.organizationId`
3. **配置服务**：`ctx.teamId` → `ctx.organizationId`
4. **API Key 安全策略**：改为 better-auth apiKey 插件说明
5. **常见陷阱**：更新相关条目
6. **数据库表列表**：移除 `team`/`team_member`/`api_key`，增加 `organization`/`member`（better-auth 管理）

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 更新为 better-auth organization + apiKey 架构"
```

---

## 风险与注意事项

1. **better-auth server API 确认**：Task 5 和 Task 7 中使用的 `auth.api.*` 方法需要根据 better-auth v1.6.8 的实际文档确认。better-auth 的 server-side API 可能需要不同的调用方式（如需要传入 headers 或 session）。

2. **organization 表 FK 引用**：better-auth 通过 Drizzle adapter 管理的表，我们在 schema.ts 中的 FK 引用需要确认是否兼容。如果 better-auth 不暴露表定义供我们做 FK，可以不做 FK 约束，只在应用层保证一致性。

3. **前端 Eden Treaty 类型**：`web/src/api/client.ts` 使用 Eden Treaty 推断后端路由类型。新增的 `/web/organizations` 和 `/web/apiKeys` 路由会自动反映到类型中。但删除的路由（`/web/teams`）会破坏旧的类型推断，需要同步更新前端。

4. **测试文件数量多**：测试文件中大量 mock 了 `../auth/api-key-service` 和 `../services/team`，需要逐一替换为 better-auth 的 mock。这是最耗时的部分之一。

5. **Session 表的 activeTeamId 列**：删除该列后，better-auth organization 插件通过自己的机制管理 active org。前端从 localStorage + header 传递改为 better-auth 的 `setActiveOrganization` API。
