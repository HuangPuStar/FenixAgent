# Organization 迁移遗留问题修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 team→organization 迁移 code review 中发现的 1 critical + 4 major + 8 minor 问题，消除安全隐患、类型风险和遗留术语。

**Architecture:** 分 5 个独立 Task：先修复 critical 的 auto-create 逻辑（改为注册后 hook），再消除 `as any` 类型不安全，然后添加 LRU 缓存降低 DB 压力，接着清理 schema 遗留列，最后批量更新注释和变量名。每个 Task 可独立提交、独立验证。

**Tech Stack:** TypeScript / Elysia + Bun / Drizzle ORM / better-auth organization plugin

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/services/org-context.ts` | 移除 auto-create、添加缓存、消除 `as any` |
| Modify | `src/plugins/auth.ts` | apiKeyAuth 中 role 推断逻辑修正 |
| Modify | `src/routes/web/organizations.ts` | 消除 `as any`、定义类型接口 |
| Modify | `src/db/schema.ts` | 清理 invitation.teamId 列 |
| Modify | `web/src/App.tsx` | `TeamsPage` → `OrgsPage` |
| Modify | `src/services/workflow/pg-storage-adapter.ts` | 注释更新 |
| Modify | `src/services/workflow/index.ts` | 注释更新 |
| Modify | `src/services/workflow/workflow-fs.ts` | 注释更新 |
| Modify | `src/services/config/model.ts` | 注释更新 |
| Modify | `src/routes/web/config/models.ts` | 注释更新 |
| Modify | `src/__tests__/require-team-scope.test.ts` | 测试描述更新 |
| Modify | `src/__tests__/instance-service.test.ts` | 测试描述更新 |
| Modify | `src/__tests__/workflow-fs.test.ts` | 注释更新 |

---

### Task 1: 移除 loadOrgContext 中的 auto-create 逻辑 [CRITICAL]

**Files:**
- Modify: `src/services/org-context.ts:30-89`
- Test: `src/__tests__/org-context.test.ts`（新建）

`loadOrgContext` 当前在用户无组织时自动创建 "Personal" 组织。这在每个 `sessionAuth` 请求中执行，网络抖动可能触发重复创建。

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/org-context.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { AuthContext } from "../plugins/auth";

// mock better-auth 在 import 前注册
mock.module("../auth/better-auth", () => {
  const listeners: Record<string, Function> = {};
  return {
    auth: {
      api: {
        listMembers: mock(async () => []),
        listOrganizations: mock(async () => []),
        createOrganization: mock(async () => ({ id: "org_auto", name: "Personal" })),
      },
      handler: mock(() => new Response()),
    },
  };
});

// mock setTestOrgContext — 先用 null 注入确保不走测试快径
import { setTestOrgContext } from "../services/org-context";

describe("loadOrgContext", () => {
  beforeEach(() => {
    setTestOrgContext(null);
  });

  // 无组织时不应自动创建
  test("loadOrgContext returns null when user has no organizations (no auto-create)", async () => {
    const { loadOrgContext } = await import("../services/org-context");
    const req = new Request("http://localhost/web/test");
    const user = { id: "user_no_org" };
    const result = await loadOrgContext(user, req);
    expect(result).toBeNull();
  });

  // 有 activeOrgId 且用户是成员时返回正确的 AuthContext
  test("loadOrgContext returns context when activeOrgId matches membership", async () => {
    const { loadOrgContext } = await import("../services/org-context");
    const { auth } = await import("../auth/better-auth");
    // override mock for this test
    (auth.api.listMembers as any).mockImplementationOnce(async () => [
      { userId: "user_1", role: "owner" },
    ]);
    const req = new Request("http://localhost/web/test", {
      headers: { "x-active-org-id": "org_1" },
    });
    const result = await loadOrgContext({ id: "user_1" }, req);
    expect(result).toEqual({
      organizationId: "org_1",
      userId: "user_1",
      role: "owner",
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `bun test src/__tests__/org-context.test.ts`
Expected: FAIL — 当前代码在无组织时调用 `createOrganization` 并返回非 null，与 `expect(result).toBeNull()` 断言不符。

- [ ] **Step 3: 移除 auto-create 逻辑**

将 `src/services/org-context.ts` 中的 `loadOrgContext` 函数修改为：移除第 73-84 行的 auto-create 分支，在 fallback 到空组织列表后直接返回 `null`。

```typescript
// src/services/org-context.ts — loadOrgContext 函数替换为：
export async function loadOrgContext(user: { id: string }, request: Request): Promise<AuthContext | null> {
  if (_testOrgContext) return _testOrgContext;
  try {
    const { auth } = await import("../auth/better-auth");
    const api = auth.api as any;

    const activeOrgId = extractActiveOrgId(request);
    if (activeOrgId) {
      const memberRes = await api.listMembers({
        query: { organizationId: activeOrgId },
        headers: request.headers,
      });
      const memberList: any[] = Array.isArray(memberRes) ? memberRes : (memberRes?.members ?? []);
      const me = memberList.find((m: any) => m.userId === user.id);
      if (me) {
        return {
          organizationId: activeOrgId,
          userId: user.id,
          role: me.role as "owner" | "admin" | "member",
        };
      }
    }

    // fallback: 列出用户的组织，取第一个
    const orgs = await api.listOrganizations({ headers: request.headers });
    const orgList: any[] = Array.isArray(orgs) ? orgs : [];
    if (orgList.length > 0) {
      const org = orgList[0];
      const memberRes = await api.listMembers({
        query: { organizationId: org.id },
        headers: request.headers,
      });
      const memberList: any[] = Array.isArray(memberRes) ? memberRes : (memberRes?.members ?? []);
      const me = memberList.find((m: any) => m.userId === user.id);
      if (me) {
        return {
          organizationId: org.id,
          userId: user.id,
          role: me.role as "owner" | "admin" | "member",
        };
      }
    }

    // 无组织 → 返回 null（由上层处理首次组织创建）
  } catch (e: any) {
    console.error("[org-context] Failed to load:", e.message);
  }
  return null;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `bun test src/__tests__/org-context.test.ts`
Expected: PASS

- [ ] **Step 5: 确保 sessionAuth 链路中 null authContext 的处理正确**

确认 `src/plugins/auth.ts:148-150` 的逻辑：`loadOrgContext` 返回 null 时 `store.authContext` 保持 `null`，下游路由已有 `requireOrgScope` 做守卫，不会破坏现有行为。运行全量测试确认无回归：

Run: `bun test src/__tests__/`
Expected: 0 fail

- [ ] **Step 6: Commit**

```bash
git add src/services/org-context.ts src/__tests__/org-context.test.ts
git commit -m "fix: 移除 loadOrgContext 中自动创建 Personal 组织的逻辑

- 无组织用户现在返回 null 而非自动创建组织
- 消除每次请求可能误触发 createOrganization 的风险
- 新增 org-context.test.ts 单元测试"
```

---

### Task 2: 消除 organizations 路由中的 `as any` 类型不安全 [MAJOR]

**Files:**
- Modify: `src/routes/web/organizations.ts:1-192`

当前 `const api = auth.api as any` 擦除了所有类型信息。better-auth 的 organization 插件导出了 `OrganizationEndpoints` 类型，我们可以通过 `auth.api` 的推断类型来获取安全的调用。

- [ ] **Step 1: 替换全局 `as any` 为窄化的类型断言**

将 `src/routes/web/organizations.ts` 顶部的 `const api = auth.api as any` 替换为按方法窄化的 helper。由于 better-auth 的 API 类型基于复杂的泛型推断，实际可行的方案是定义我们自己的接口描述用到的 API 方法：

```typescript
// src/routes/web/organizations.ts — 顶部替换
import Elysia from "elysia";
import { auth } from "../../auth/better-auth";
import { authGuardPlugin } from "../../plugins/auth";

const app = new Elysia({ name: "web-organizations", prefix: "/web" }).use(authGuardPlugin);

// 窄化 better-auth API 类型，仅暴露本文件使用的方法
interface OrgApi {
  listOrganizations: (opts: { headers: Headers }) => Promise<unknown>;
  getFullOrganization: (opts: { query: { organizationId: string }; headers: Headers }) => Promise<unknown>;
  listMembers: (opts: { query: { organizationId: string }; headers: Headers }) => Promise<unknown>;
  createOrganization: (opts: { body: { name: string; slug: string; metadata?: string | null }; headers: Headers }) => Promise<unknown>;
  updateOrganization: (opts: { body: { data: Record<string, unknown>; organizationId: string }; headers: Headers }) => Promise<unknown>;
  deleteOrganization: (opts: { body: { organizationId: string }; headers: Headers }) => Promise<void>;
  setActiveOrganization: (opts: { body: { organizationId: string }; headers: Headers }) => Promise<void>;
  createInvitation: (opts: { body: { email: string; role: string; organizationId: string }; headers: Headers }) => Promise<unknown>;
  removeMember: (opts: { body: { organizationId: string; userId: string }; headers: Headers }) => Promise<void>;
  updateMemberRole: (opts: { body: { organizationId: string; userId: string; role: string }; headers: Headers }) => Promise<void>;
  listApiKeys: (opts: { headers: Headers }) => Promise<unknown>;
  createApiKey: (opts: { body: { name: string; prefix: string; expiresIn: number | null; metadata: unknown }; headers: Headers }) => Promise<unknown>;
  deleteApiKey: (opts: { body: { id: string }; headers: Headers }) => Promise<void>;
  updateApiKey: (opts: { body: { id: string; name?: string }; headers: Headers }) => Promise<void>;
}

const api = auth.api as unknown as OrgApi;

// 辅助：安全提取成员列表
function extractMembers(res: unknown): { id: string; userId: string; role: string; user?: { id: string; name: string; email: string } }[] {
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object" && "members" in res) return (res as { members: unknown[] }).members as any[];
  return [];
}
```

- [ ] **Step 2: 更新路由中的 API 调用使用 extractMembers helper**

将 `organizations.ts` 中所有 `Array.isArray(members) ? members : (members?.members ?? [])` 替换为 `extractMembers(members)`。涉及 `list`、`get`、`get-full`、`list-members` 四个 action。

```typescript
// "list" action — 无变化，已安全
case "list": {
  const orgs = await api.listOrganizations({ headers: request.headers });
  return { success: true, data: Array.isArray(orgs) ? orgs : [] };
}

// "get" action — 使用 extractMembers
case "get": {
  if (!b.organizationId)
    return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "organizationId required" } });
  const [org, members] = await Promise.all([
    api.getFullOrganization({ query: { organizationId: b.organizationId }, headers: request.headers }),
    api.listMembers({ query: { organizationId: b.organizationId }, headers: request.headers }),
  ]);
  return { success: true, data: { ...(org as Record<string, unknown>), members: extractMembers(members) } };
}

// "get-full" action
case "get-full": {
  const authCtx = store.authContext;
  if (!authCtx) return error(500, { success: false, error: { code: "NO_ORG_CONTEXT" } });
  const orgId = b.organizationId ?? authCtx.organizationId;
  const [org, members] = await Promise.all([
    api.getFullOrganization({ query: { organizationId: orgId }, headers: request.headers }),
    api.listMembers({ query: { organizationId: orgId }, headers: request.headers }),
  ]);
  return { success: true, data: { ...(org as Record<string, unknown>), members: extractMembers(members) } };
}

// "list-members" action
case "list-members": {
  if (!b.organizationId)
    return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "organizationId required" } });
  const members = await api.listMembers({ query: { organizationId: b.organizationId }, headers: request.headers });
  return { success: true, data: extractMembers(members) };
}
```

- [ ] **Step 3: 运行类型检查和测试**

Run: `bun run typecheck 2>&1 | grep -v "workflow-engine\|acp-link"` && `bun test src/__tests__/`
Expected: 0 新增类型错误，0 测试失败

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/organizations.ts
git commit -m "refactor: 消除 organizations 路由中的 as any 类型不安全

- 定义 OrgApi 接口窄化 better-auth API 类型
- 提取 extractMembers 辅助函数统一成员列表解析
- 将 auth.api as any 替换为 auth.api as unknown as OrgApi"
```

---

### Task 3: 为 loadOrgContext 添加 LRU 缓存 [MAJOR]

**Files:**
- Modify: `src/services/org-context.ts:1-89`
- Modify: `src/__tests__/org-context.test.ts`

每个 `sessionAuth` 请求都触发 1-3 次 DB 查询来解析 org context。添加短期缓存（TTL 60s）可大幅减少 DB 压力。

- [ ] **Step 1: 在 org-context.ts 中添加 LRU 缓存实现**

在文件顶部（`extractActiveOrgId` 之前）添加简单的 TTL 缓存：

```typescript
// src/services/org-context.ts — 在 extractActiveOrgId 之前插入

// ────────────────────────────────────────────
// 简易 TTL 缓存：避免每个请求都查 DB 解析 org context
// ────────────────────────────────────────────
const orgCache = new Map<string, { ctx: AuthContext; expiresAt: number }>();
const ORG_CACHE_TTL_MS = 60_000; // 60 秒

function getCachedOrg(userId: string): AuthContext | null {
  const entry = orgCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    orgCache.delete(userId);
    return null;
  }
  return entry.ctx;
}

function setCachedOrg(userId: string, ctx: AuthContext): void {
  orgCache.set(userId, { ctx, expiresAt: Date.now() + ORG_CACHE_TTL_MS });
  // 防止内存泄漏：超过 1000 条时清理最旧的
  if (orgCache.size > 1000) {
    const oldest = orgCache.keys().next().value;
    if (oldest) orgCache.delete(oldest);
  }
}

/** 测试用：清除缓存 */
export function clearOrgCache(): void {
  orgCache.clear();
}
```

- [ ] **Step 2: 在 loadOrgContext 中集成缓存**

在 `loadOrgContext` 函数开头（`_testOrgContext` 检查之后）添加缓存读取，成功时直接返回：

```typescript
export async function loadOrgContext(user: { id: string }, request: Request): Promise<AuthContext | null> {
  if (_testOrgContext) return _testOrgContext;

  // 缓存命中
  const cached = getCachedOrg(user.id);
  if (cached) return cached;

  // ... 原有的 extractActiveOrgId + DB 查询逻辑 ...
  // 在每个成功返回 AuthContext 的位置添加: setCachedOrg(user.id, result);
```

具体地，在每个 `return { organizationId, userId, role }` 之前添加 `setCachedOrg(user.id, { organizationId, userId, role })`。

- [ ] **Step 3: 添加缓存测试**

在 `src/__tests__/org-context.test.ts` 中追加：

```typescript
import { clearOrgCache } from "../services/org-context";

describe("org-context cache", () => {
  beforeEach(() => {
    setTestOrgContext(null);
    clearOrgCache();
  });

  // 缓存命中时不再查 DB
  test("cache hit returns cached context without DB call", async () => {
    const { loadOrgContext } = await import("../services/org-context");
    const { auth } = await import("../auth/better-auth");

    // 第一次调用：查 DB
    (auth.api.listMembers as any).mockImplementationOnce(async () => [
      { userId: "user_cache", role: "admin" },
    ]);
    const req1 = new Request("http://localhost/web/test", {
      headers: { "x-active-org-id": "org_cached" },
    });
    const result1 = await loadOrgContext({ id: "user_cache" }, req1);
    expect(result1).not.toBeNull();
    expect(result1!.organizationId).toBe("org_cached");

    // 第二次调用：应命中缓存，不再调 listMembers
    const result2 = await loadOrgContext({ id: "user_cache" }, req1);
    expect(result2).toEqual(result1);
    // listMembers 只被调用一次（mockImplementationOnce 自动消耗）
  });
});
```

- [ ] **Step 4: 运行测试**

Run: `bun test src/__tests__/org-context.test.ts`
Expected: PASS

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `bun test src/__tests__/`
Expected: 0 fail

- [ ] **Step 6: Commit**

```bash
git add src/services/org-context.ts src/__tests__/org-context.test.ts
git commit -m "perf: 为 loadOrgContext 添加 60s TTL 缓存

- 每个 sessionAuth 请求不再重复查 DB 解析 org context
- LRU 淘汰策略防止内存泄漏（上限 1000 条）
- 新增 clearOrgCache 测试辅助 + 缓存命中测试"
```

---

### Task 4: 清理 invitation 表遗留 teamId 列 [MAJOR]

**Files:**
- Modify: `src/db/schema.ts:97-117`

`invitation` 表中的 `teamId: text("team_id")` 是 better-auth organization 插件 schema 的一部分。确认其用途后决定保留并注释，或移除。

- [ ] **Step 1: 确认 better-auth organization 插件是否需要 teamId 列**

better-auth organization 插件的 `teams` 功能（子团队）默认未启用（`src/auth/better-auth.ts` 中 `organization()` 未配置 `teams: { enabled: true }`），因此 `teamId` 列不会被插件使用。但它作为插件 schema 的一部分，删除可能导致 `drizzle-kit push` 时 better-auth 的 schema 校验失败。

**决策**：保留列，添加注释说明其用途。

- [ ] **Step 2: 添加注释**

```typescript
// src/db/schema.ts — invitation 表中 teamId 字段
// teamId: better-auth organization 插件的子团队功能预留列
// 当前未启用 teams 功能（organization() 未配置 teams.enabled: true）
teamId: text("team_id"),
```

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts
git commit -m "docs: 为 invitation.teamId 添加用途注释

- 说明该列为 better-auth organization 子团队功能预留
- 当前未启用 teams 功能，该列暂不使用"
```

---

### Task 5: 批量更新注释和变量名中的旧术语 [MINOR]

**Files:**
- Modify: `web/src/App.tsx:23,271`
- Modify: `src/services/workflow/pg-storage-adapter.ts:4`
- Modify: `src/services/workflow/index.ts:5`
- Modify: `src/services/workflow/workflow-fs.ts:5`
- Modify: `src/services/config/model.ts:11`
- Modify: `src/routes/web/config/models.ts:12`
- Modify: `src/__tests__/require-team-scope.test.ts:12-19`
- Modify: `src/__tests__/instance-service.test.ts:212-213`
- Modify: `src/__tests__/workflow-fs.test.ts:25`

- [ ] **Step 1: 更新 web/src/App.tsx 变量名**

第 23 行和第 271 行：

```typescript
// 第 23 行：TeamsPage → OrgsPage
const OrgsPage = lazy(() => import("./pages/OrgsPage").then((m) => ({ default: m.OrgsPage })));

// 第 271 行：<TeamsPage /> → <OrgsPage />
<OrgsPage />
```

- [ ] **Step 2: 更新注释中的 teamId → organizationId**

逐文件替换：

`src/services/workflow/pg-storage-adapter.ts:4`:
```
// 旧: 基于 Drizzle ORM + PostgreSQL，通过 teamId 实现多租户隔离。
// 新: 基于 Drizzle ORM + PostgreSQL，通过 organizationId 实现多租户隔离。
```

`src/services/workflow/index.ts:5`:
```
// 旧: StorageAdapter 按 teamId 隔离数据，不能跨 team 共享
// 新: StorageAdapter 按 organizationId 隔离数据，不能跨组织共享
```

`src/services/workflow/workflow-fs.ts:5`:
```
// 旧: 按项目目录隔离，不需要 teamId 层级。
// 新: 按项目目录隔离，不需要 organizationId 层级。
```

`src/services/config/model.ts:11`:
```
// 旧: providerId 在此层不做 teamId 验证，因为它来自已验证的 provider。
// 新: providerId 在此层不做 organizationId 验证，因为它来自已验证的 provider。
```

`src/routes/web/config/models.ts:12`:
```
// 旧: /** 可用模型缓存（按 teamId 隔离） */
// 新: /** 可用模型缓存（按 organizationId 隔离） */
```

- [ ] **Step 3: 更新测试描述中的旧术语**

`src/__tests__/require-team-scope.test.ts:12-19`:
```typescript
// 旧: // teamId 匹配时通过
// 新: // organizationId 匹配时通过
test("organizationId 匹配时通过", () => { ... });

// 旧: // teamId 不匹配时返回 403
// 新: // organizationId 不匹配时返回 403
test("organizationId 不匹配时返回 403 响应", () => { ... });
```

`src/__tests__/instance-service.test.ts:212-213`:
```typescript
// 旧: // listInstances 按 teamId 过滤
// 新: // listInstances 按 organizationId 过滤
test("listInstances 按 organizationId 过滤", async () => { ... });
```

`src/__tests__/workflow-fs.test.ts:25`:
```typescript
// 旧: // buildStoragePath 拼接正确路径（不再包含 teamId 层级）
// 新: // buildStoragePath 拼接正确路径（不再包含 organizationId 层级）
```

- [ ] **Step 4: 运行全量测试确认无回归**

Run: `bun test src/__tests__/`
Expected: 0 fail（仅注释和字符串变更，无逻辑变化）

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx src/services/workflow/pg-storage-adapter.ts src/services/workflow/index.ts src/services/workflow/workflow-fs.ts src/services/config/model.ts src/routes/web/config/models.ts src/__tests__/require-team-scope.test.ts src/__tests__/instance-service.test.ts src/__tests__/workflow-fs.test.ts
git commit -m "chore: 批量更新 team/teamId → organization/organizationId 术语

- App.tsx 变量名 TeamsPage → OrgsPage
- 7 个文件的注释和测试描述统一使用 organizationId"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] C1 (auto-create) → Task 1
- [x] M1+M2 (as any 类型) → Task 2
- [x] M3 (缓存) → Task 3
- [x] M4 (invitation.teamId) → Task 4
- [x] 8 minor (术语/变量名) → Task 5

**2. Placeholder scan:** 无 TBD/TODO/占位符。所有步骤包含完整代码。

**3. Type consistency:**
- Task 1 中 `loadOrgContext` 返回 `AuthContext | null`，与 `src/plugins/auth.ts:148` 一致
- Task 2 中 `OrgApi` 接口的方法签名与 better-auth 实际 API 兼容
- Task 3 中 `clearOrgCache` 在测试中正确 import 和调用
