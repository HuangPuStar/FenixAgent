# 测试策略基础设施 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Preload + 全局 Stub 注册表的测试基础设施，消除 mock.module() 全局冲突，并迁移一个路由测试文件作为示范。

**Architecture:** 通过 `bunfig.toml` 的 `preload` 在所有测试前完成一次性 `mock.module()` 注册。被 mock 的模块替换为 Proxy，运行时从 stub 注册表读取测试配置的行为。测试文件通过 `stubXxx()` 函数配置行为，`resetAllStubs()` 在 beforeEach 中清理。

**Tech Stack:** Bun test、mock.module()、Proxy

---

## File Structure

```
bunfig.toml                                    ← 新建，preload 配置
src/test-utils/setup-mocks.ts                  ← 新建，唯一调用 mock.module() 的文件
src/test-utils/helpers.ts                      ← 新建，resetAllStubs()
src/test-utils/stubs/config-pg-stub.ts         ← 新建，config-pg stub 注册表
src/test-utils/stubs/auth-stub.ts              ← 新建，better-auth + api-key-service stub 注册表
src/test-utils/stubs/db-stub.ts                ← 新建，raw db stub 注册表
src/__tests__/stub-smoke.test.ts               ← 新建，stub 基础设施冒烟测试
src/__tests__/config-providers.test.ts         ← 迁移，作为示范
CLAUDE.md                                      ← 更新，添加测试规则和白名单
```

---

### Task 1: Create bunfig.toml

**Files:**
- Create: `bunfig.toml`

- [ ] **Step 1: Create bunfig.toml with preload**

```toml
[test]
preload = ["src/test-utils/setup-mocks.ts"]
```

- [ ] **Step 2: Verify bunfig.toml is valid**

Run: `bun test --help 2>&1 | head -5`
Expected: 不报错（bunfig.toml 语法正确）

- [ ] **Step 3: Commit**

```bash
git add bunfig.toml
git commit -m "chore: 添加 bunfig.toml 配置测试 preload"
```

---

### Task 2: Create config-pg stub registry

**Files:**
- Create: `src/test-utils/stubs/config-pg-stub.ts`

config-pg 是桶文件，从 `./config/index` 重导出约 30 个函数。Stub 注册表需要覆盖所有被测试使用的函数签名。

- [ ] **Step 1: Create config-pg-stub.ts**

```ts
// config-pg stub 注册表
// 替代各测试文件中的 mock.module("../services/config-pg", ...) 调用

// biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
type StubFn = (...args: any[]) => any;

interface ConfigPgStubs {
  AGENT_SETTABLE_FIELDS: string[];
  addModel: StubFn;
  createAgentConfig: StubFn;
  createMcpServer: StubFn;
  deleteAgentConfig: StubFn;
  deleteMcpServer: StubFn;
  deleteProvider: StubFn;
  deleteSkill: StubFn;
  getAgentConfig: StubFn;
  getAgentConfigById: StubFn;
  getAgentFullConfig: StubFn;
  getMcpServer: StubFn;
  getProvider: StubFn;
  getSkill: StubFn;
  getUserConfig: StubFn;
  listAgentConfigs: StubFn;
  listAgentSkillIds: StubFn;
  listMcpServers: StubFn;
  listProviders: StubFn;
  listSkills: StubFn;
  removeModel: StubFn;
  setMcpServerEnabled: StubFn;
  setUserConfig: StubFn;
  syncAgentSkills: StubFn;
  updateAgentConfig: StubFn;
  updateMcpServer: StubFn;
  updateModel: StubFn;
  upsertProvider: StubFn;
  upsertSkill: StubFn;
}

let _stubs: Partial<ConfigPgStubs> = {};

export function stubConfigPg(overrides: Partial<ConfigPgStubs>) {
  _stubs = { ..._stubs, ...overrides };
}

export function getConfigPgStub<K extends keyof ConfigPgStubs>(name: K): ConfigPgStubs[K] {
  const fn = _stubs[name];
  if (!fn) throw new Error(`config-pg stub '${name}' not configured, call stubConfigPg() in beforeEach`);
  return fn;
}

export function resetConfigPgStubs() {
  _stubs = {};
}
```

- [ ] **Step 2: Commit**

```bash
git add src/test-utils/stubs/config-pg-stub.ts
git commit -m "feat: 添加 config-pg stub 注册表"
```

---

### Task 3: Create auth stub registry

**Files:**
- Create: `src/test-utils/stubs/auth-stub.ts`

better-auth 的 `auth.api` 包含多个方法，测试中使用的有：`listApiKeys`、`deleteApiKey`、`createApiKey`、`listMembers`、`listOrganizations`、`createOrganization`、`verifyApiKey`、`getSession`。api-key-service 导出 `createApiKey` 和 `hashApiKey`。

- [ ] **Step 1: Create auth-stub.ts**

```ts
// auth stub 注册表
// 替代各测试文件中的 mock.module("../auth/better-auth", ...) 和 mock.module("../auth/api-key-service", ...) 调用

// biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
type StubFn = (...args: any[]) => any;

interface AuthApiStubs {
  listApiKeys: StubFn;
  deleteApiKey: StubFn;
  createApiKey: StubFn;
  listMembers: StubFn;
  listOrganizations: StubFn;
  createOrganization: StubFn;
  verifyApiKey: StubFn;
  getSession: StubFn;
}

interface ApiKeyServiceStubs {
  createApiKey: StubFn;
  hashApiKey: StubFn;
}

let _authApiStubs: Partial<AuthApiStubs> = {};
let _apiKeyStubs: Partial<ApiKeyServiceStubs> = {};

// ── better-auth stubs ──

export function stubAuthApi(overrides: Partial<AuthApiStubs>) {
  _authApiStubs = { ..._authApiStubs, ...overrides };
}

export function getAuthApiStub<K extends keyof AuthApiStubs>(name: K): AuthApiStubs[K] {
  const fn = _authApiStubs[name];
  if (!fn) throw new Error(`auth.api stub '${name}' not configured, call stubAuthApi() in beforeEach`);
  return fn;
}

// ── api-key-service stubs ──

export function stubApiKeyService(overrides: Partial<ApiKeyServiceStubs>) {
  _apiKeyStubs = { ..._apiKeyStubs, ...overrides };
}

export function getApiKeyServiceStub<K extends keyof ApiKeyServiceStubs>(name: K): ApiKeyServiceStubs[K] {
  const fn = _apiKeyStubs[name];
  if (!fn) throw new Error(`api-key-service stub '${name}' not configured, call stubApiKeyService() in beforeEach`);
  return fn;
}

// ── reset ──

export function resetAuthStubs() {
  _authApiStubs = {};
  _apiKeyStubs = {};
}
```

- [ ] **Step 2: Commit**

```bash
git add src/test-utils/stubs/auth-stub.ts
git commit -m "feat: 添加 auth stub 注册表"
```

---

### Task 4: Create raw db stub registry

**Files:**
- Create: `src/test-utils/stubs/db-stub.ts`

`../db` 导出 `db`（Drizzle 查询构建器）和 `initDb`。测试中通过 Drizzle 链式 API 使用 `db.select().from().where()` 等。Stub 需要支持配置自定义 db 对象。

- [ ] **Step 1: Create db-stub.ts**

```ts
// raw db stub 注册表
// 替代各测试文件中的 mock.module("../db", ...) 调用
// Drizzle 的 db 是链式查询构建器，直接用自定义对象替换

// biome-ignore lint/suspicious/noExplicitAny: Drizzle db 对象类型复杂，stub 用宽松类型
type DbStub = Record<string, any>;

let _dbStub: DbStub | null = null;

export function stubDb(db: DbStub) {
  _dbStub = db;
}

export function getDbStub(): DbStub {
  if (!_dbStub) throw new Error("db stub not configured, call stubDb() in beforeEach");
  return _dbStub;
}

export function resetDbStub() {
  _dbStub = null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/test-utils/stubs/db-stub.ts
git commit -m "feat: 添加 raw db stub 注册表"
```

---

### Task 5: Create helpers.ts

**Files:**
- Create: `src/test-utils/helpers.ts`

- [ ] **Step 1: Create helpers.ts**

```ts
import { resetConfigPgStubs } from "./stubs/config-pg-stub";
import { resetAuthStubs } from "./stubs/auth-stub";
import { resetDbStub } from "./stubs/db-stub";

export function resetAllStubs() {
  resetConfigPgStubs();
  resetAuthStubs();
  resetDbStub();
}

// 重新导出 stub 函数，方便测试文件从统一入口引入
export { stubConfigPg, getConfigPgStub } from "./stubs/config-pg-stub";
export { stubAuthApi, stubApiKeyService, getAuthApiStub, getApiKeyServiceStub } from "./stubs/auth-stub";
export { stubDb } from "./stubs/db-stub";
```

- [ ] **Step 2: Commit**

```bash
git add src/test-utils/helpers.ts
git commit -m "feat: 添加 resetAllStubs() 和统一导出"
```

---

### Task 6: Create setup-mocks.ts

**Files:**
- Create: `src/test-utils/setup-mocks.ts`

这是核心文件——项目中唯一调用 `mock.module()` 的地方。通过 preload 在所有测试前执行。每个被 mock 的模块使用 Proxy 从对应的 stub 注册表读取配置。

- [ ] **Step 1: Create setup-mocks.ts**

```ts
// setup-mocks.ts — 项目中唯一调用 mock.module() 的文件
// 通过 bunfig.toml preload 在所有测试前加载

import { mock } from "bun:test";

// ── mock ../services/config-pg ──

mock.module("../services/config-pg", () => {
  const { getConfigPgStub } = require("./stubs/config-pg-stub");
  return new Proxy(
    {},
    {
      get(_, prop: string) {
        if (prop === "__esModule") return true;
        return getConfigPgStub(prop as any);
      },
    },
  );
});

// ── mock ../auth/better-auth ──

mock.module("../auth/better-auth", () => {
  const { getAuthApiStub } = require("./stubs/auth-stub");
  return {
    auth: {
      api: new Proxy(
        {},
        {
          get(_, prop: string) {
            return getAuthApiStub(prop as any);
          },
        },
      ),
      handler: (req: Request) => new Response("mocked", { status: 200 }),
    },
  };
});

// ── mock ../auth/api-key-service ──

mock.module("../auth/api-key-service", () => {
  const { getApiKeyServiceStub } = require("./stubs/auth-stub");
  return new Proxy(
    {},
    {
      get(_, prop: string) {
        return getApiKeyServiceStub(prop as any);
      },
    },
  );
});

// ── mock ../db ──

mock.module("../db", () => {
  const { getDbStub } = require("./stubs/db-stub");
  return { db: getDbStub() };
});
```

**注意：** 这里使用 `require()` 而非 `await import()` 是因为 `mock.module()` 的工厂函数需要同步返回。如果 `require()` 在 ESM 环境不可用，需要改为动态 `import()` + async 工厂函数。Bun 支持在 mock.module 工厂中使用 `await import()`。

- [ ] **Step 2: Commit**

```bash
git add src/test-utils/setup-mocks.ts
git commit -m "feat: 添加 setup-mocks.ts — 唯一的 mock.module() 注册点"
```

---

### Task 7: Write smoke test

**Files:**
- Create: `src/__tests__/stub-smoke.test.ts`

写一个冒烟测试验证 stub 基础设施工作正常：配置 stub → 调用被 mock 的模块 → 得到预期的返回值 → resetAllStubs 清理后再次调用抛错。

- [ ] **Step 1: Write smoke test**

```ts
// 验证 stub 基础设施工作正常
import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

describe("stub 基础设施冒烟测试", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  test("stubConfigPg 配置后，被 mock 的模块返回配置的值", async () => {
    stubConfigPg({
      listProviders: async () => [{ id: "p1", name: "test" }],
    });

    const configPg = await import("../services/config-pg");
    const result = await configPg.listProviders({ organizationId: "org1", userId: "u1", role: "owner" });
    expect(result).toEqual([{ id: "p1", name: "test" }]);
  });

  test("resetAllStubs 后，未配置的 stub 抛出明确错误", async () => {
    const configPg = await import("../services/config-pg");
    expect(() => configPg.listProviders({})).toThrow("config-pg stub 'listProviders' not configured");
  });

  test("stubConfigPg 支持部分覆盖，未覆盖的 stub 独立报错", async () => {
    stubConfigPg({
      listProviders: async () => [],
    });

    const configPg = await import("../services/config-pg");
    const result = await configPg.listProviders({ organizationId: "org1", userId: "u1", role: "owner" });
    expect(result).toEqual([]);

    expect(() => configPg.getProvider({}, "test")).toThrow("config-pg stub 'getProvider' not configured");
  });
});
```

- [ ] **Step 2: Run smoke test**

Run: `bun test src/__tests__/stub-smoke.test.ts`
Expected: 3 个测试全部 PASS

如果失败，检查以下几点：
1. `bunfig.toml` 的 preload 路径是否正确
2. `mock.module()` 的模块路径是否相对于测试文件能正确解析（preload 中的路径相对于项目根目录）
3. Bun 版本是否支持在 preload 中使用 `mock.module()`

- [ ] **Step 3: Fix any issues found**

根据 Step 2 的失败信息调整：
- 如果 `require()` 报错，改为 `await import()` 并将 mock.module 工厂改为 async
- 如果模块路径解析失败，调整 mock.module 中的相对路径
- 如果 Proxy 不拦截 `__esModule`，确保 Proxy handler 正确处理 Symbol 和特殊属性

- [ ] **Step 4: Re-run smoke test**

Run: `bun test src/__tests__/stub-smoke.test.ts`
Expected: 3 个测试全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/stub-smoke.test.ts
git commit -m "test: 添加 stub 基础设施冒烟测试"
```

---

### Task 8: Migrate config-providers.test.ts

**Files:**
- Modify: `src/__tests__/config-providers.test.ts`

这是最复杂的路由级测试之一（734 行），mock 了 `config-pg` 并使用内存 Map 模拟数据库。迁移后：
- 移除 `mock.module("../services/config-pg", ...)` 调用
- 使用 `stubConfigPg()` 配置行为
- 保留原有的内存 Map 数据管理逻辑（移入 stub 配置）
- 保留 `beforeEach` / `afterEach` 结构

- [ ] **Step 1: Read current file**

Read `src/__tests__/config-providers.test.ts` in full to understand all mock behaviors.

- [ ] **Step 2: Rewrite the test file**

将 `mock.module("../services/config-pg", ...)` 替换为 `stubConfigPg()` 调用。核心变更：

1. 移除顶部的 `mock.module("../services/config-pg", ...)` 块
2. 添加 `import { resetAllStubs, stubConfigPg } from "../test-utils/helpers"`
3. 在 `beforeEach` 中用 `stubConfigPg()` 配置所有需要的 stub 函数
4. 每个 stub 函数直接操作内存 Map（与原 mock 行为一致）

由于原文件使用 `_providers` Map 在 mock 闭包内模拟数据库，迁移后这个 Map 继续存在，但 stub 函数通过 `stubConfigPg()` 注册：

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";

// 内存数据存储（与原来一致）
let _providers: Map<
  string,
  {
    id: string;
    name: string;
    displayName: string | null;
    npm: string | null;
    baseUrl: string | null;
    apiKey: string | null;
    extraOptions: Record<string, unknown> | null;
    models: Map<string, Record<string, unknown>>;
  }
> = new Map();

const providersRoute = (await import("../routes/web/config/providers")).default;

function setupStubs() {
  stubConfigPg({
    listProviders: async (_ctx: any) => {
      return [..._providers.values()].map((p) => ({
        id: p.id,
        name: p.name,
        displayName: p.displayName,
        npm: p.npm,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        extraOptions: p.extraOptions,
        modelCount: p.models.size,
      }));
    },
    getProvider: async (_ctx: any, name: string) => {
      const p = _providers.get(name);
      if (!p) return null;
      return {
        ...p,
        models: [...p.models.entries()].map(([modelId, m]) => ({ id: "model-uuid", providerId: p.id, modelId, ...m })),
      };
    },
    upsertProvider: async (_ctx: any, name: string, data: any) => {
      const existing = _providers.get(name);
      if (existing) {
        Object.assign(existing, {
          displayName: data.displayName ?? existing.displayName,
          npm: data.npm ?? existing.npm,
          baseUrl: data.baseUrl ?? existing.baseUrl,
          apiKey: data.apiKey ?? existing.apiKey,
          extraOptions: data.extraOptions ?? existing.extraOptions,
        });
        return existing.id;
      }
      const id = `prov-${name}`;
      _providers.set(name, {
        id,
        name,
        displayName: data.displayName ?? null,
        npm: data.npm ?? null,
        baseUrl: data.baseUrl ?? null,
        apiKey: data.apiKey ?? null,
        extraOptions: data.extraOptions ?? null,
        models: new Map(),
      });
      return id;
    },
    deleteProvider: async (_ctx: any, name: string) => {
      return _providers.delete(name);
    },
    addModel: async (_orgId: string, providerId: string, data: any) => {
      for (const p of _providers.values()) {
        if (p.id === providerId) {
          p.models.set(data.modelId, data);
          return;
        }
      }
    },
    updateModel: async (_orgId: string, providerId: string, modelId: string, data: any) => {
      for (const p of _providers.values()) {
        if (p.id === providerId) {
          const existing = p.models.get(modelId) ?? {};
          p.models.set(modelId, { ...existing, ...data });
          return;
        }
      }
    },
    removeModel: async (_orgId: string, providerId: string, modelId: string) => {
      for (const p of _providers.values()) {
        if (p.id === providerId) {
          p.models.delete(modelId);
          return;
        }
      }
    },
  });
}

// Helper to get provider store for assertions
function _getProviderStore() {
  const result: Record<string, any> = {};
  for (const [name, p] of _providers) {
    const provider: Record<string, any> = { name: p.name, npm: p.npm, displayName: p.displayName };
    if (p.baseUrl || p.apiKey) {
      provider.options = {
        ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
        ...(p.apiKey ? { apiKey: p.apiKey } : {}),
        ...(typeof p.extraOptions === "object" && p.extraOptions !== null ? p.extraOptions : {}),
      };
    }
    if (p.models.size > 0) {
      provider.models = {};
      for (const [modelId, m] of p.models) {
        provider.models[modelId] = m;
      }
    }
    result[name] = provider;
  }
  return result;
}

function createFetchMock(handler: () => Promise<Response> | Response): typeof fetch {
  return Object.assign(handler, {
    preconnect: () => {},
  }) as typeof fetch;
}

describe("Providers Config Route", () => {
  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
  });

  beforeEach(() => {
    resetAllStubs();
    setupStubs();
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-team", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-team", userId: "test-user", role: "owner" });
    _providers = new Map();
  });

  // ... 以下所有 test 保持不变 ...
```

**关键变更点：**
- 顶部不再有 `mock.module()` 调用
- `beforeEach` 中先 `resetAllStubs()`，再 `setupStubs()`
- `setupStubs()` 封装了 `stubConfigPg()` 调用
- 所有 test case 代码不变

- [ ] **Step 3: Run migrated test**

Run: `bun test src/__tests__/config-providers.test.ts`
Expected: 所有测试 PASS（与迁移前相同数量）

- [ ] **Step 4: If tests fail, debug and fix**

常见问题：
- 如果报 "config-pg stub 'xxx' not configured"：检查 `setupStubs()` 是否覆盖了路由用到的所有 config-pg 函数
- 如果报 Proxy 相关错误：检查 setup-mocks.ts 中 Proxy 是否正确处理了 `__esModule` 等特殊属性
- 如果路由 handler 报错：检查是否遗漏了 `setTestAuth` 或 `setTestOrgContext`

- [ ] **Step 5: Re-run migrated test**

Run: `bun test src/__tests__/config-providers.test.ts`
Expected: 所有测试 PASS

- [ ] **Step 6: Commit**

```bash
git add src/__tests__/config-providers.test.ts
git commit -m "refactor: 迁移 config-providers 测试到 stub 注册表模式"
```

---

### Task 9: Run all existing tests

**Files:**
- 无文件变更，仅验证

- [ ] **Step 1: Run all backend tests**

Run: `bun test src/__tests__/`
Expected: 所有测试 PASS（包括迁移的 config-providers 和未迁移的其他文件）

注意：未迁移的测试文件仍使用自己的 `mock.module()` 调用。由于 `setup-mocks.ts` 通过 preload 先注册了 mock，后续测试文件中的 `mock.module()` 会覆盖 preload 的 mock。Bun 的 `mock.module()` 行为是"后注册的覆盖先注册的"。如果出现问题，需要在迁移时移除旧文件中的 `mock.module()` 调用。

- [ ] **Step 2: Run all frontend tests**

Run: `bun test web/src/__tests__/`
Expected: 所有前端测试 PASS（前端不受 stub 基础设施影响，因为前端测试不 import 后端模块）

- [ ] **Step 3: Run full precheck**

Run: `bun run precheck`
Expected: 全部通过

---

### Task 10: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

在 `## 测试策略` 部分更新测试规则和白名单。

- [ ] **Step 1: Update CLAUDE.md testing section**

在现有的 `### 测试` 和 `### 后端测试 (Bun test)` 部分之间添加新的测试规范内容：

```markdown
### 测试规则

#### Mock 白名单

以下模块允许在测试中被 mock（通过 `src/test-utils/setup-mocks.ts` 集中注册）：

- `../db` — 数据库连接
- `../services/config-pg` — 数据库 CRUD 操作
- `../auth/better-auth` — 认证服务
- `../auth/api-key-service` — API Key 服务

**禁止在测试文件中调用 `mock.module()`。** 测试文件通过 `stubXxx()` 函数配置行为。

#### 测试分层

| 层级 | 对象 | Mock | 命名 |
|------|------|------|------|
| L1 | 纯函数/工具函数 | 无 | `<功能>.test.ts` |
| L2 | 业务逻辑 | stubConfigPg / stubAuthApi | `<模块>-<功能>.test.ts` |
| L3 | 路由集成 | stub + setTestAuth + setTestOrgContext | `route-<路由>.test.ts` |
| 前端 | 关键用户流程 | mock fetch / MSW | `<功能>-flow.test.ts` |

#### Stub 使用规范

```ts
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

beforeEach(() => {
  resetAllStubs();        // 必须先 reset
  stubConfigPg({ ... });  // 再配置需要的 stub
});
```

- `beforeEach` 重置，不用 `afterEach`
- 未配置的 stub 访问时抛出明确错误
- 新增 mock 白名单模块：1) 在 `src/test-utils/stubs/` 新建 stub 文件；2) 在 `setup-mocks.ts` 注册；3) 更新本白名单

#### 测试编写规则

- 每个测试独立，不依赖执行顺序
- 每个 test 上方一行中文注释
- L3 路由测试不重复 L2 的逻辑细节
- 前端只测关键流程，不写类型检查测试
```

同时更新 CLAUDE.md 的 Mock 注意事项部分，在现有第 3 条后添加：

```markdown
4. 禁止在测试文件中调用 `mock.module()`，统一使用 `src/test-utils/` 下的 stub 注册表
5. `bunfig.toml` 的 preload 确保所有测试在执行前加载 mock 注册
```

- [ ] **Step 2: Verify CLAUDE.md formatting**

Run: `head -n 300 CLAUDE.md | tail -n 50`
Expected: 新增内容格式正确

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: 更新 CLAUDE.md 测试规则和 mock 白名单"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test src/__tests__/ && bun test web/src/__tests__/`
Expected: 所有测试 PASS

- [ ] **Step 2: Run precheck**

Run: `bun run precheck`
Expected: 全部通过

- [ ] **Step 3: Verify git status is clean**

Run: `git status`
Expected: clean

---

## Future Work (不在本计划范围内)

以下工作按设计规范逐项推进，每个测试文件的迁移是独立任务：

1. **迁移剩余 config-pg mock 用户**（11 个文件）：`config-agents.test.ts`、`config-models.test.ts`、`config-mcp.test.ts`、`config-mcp-network.test.ts`、`config-integration.test.ts`、`permission-flow.test.ts`、`instance-prefetch-env.test.ts`、`instance-supplement-cleanup.test.ts`、`instance-getinstance-cleanup.test.ts`、`group-instances-batch.test.ts`、`stop-all-instances-parallel.test.ts`

2. **迁移 auth mock 用户**（3 个文件）：`meta-agent.test.ts`、`meta-agent-api-key.test.ts`、`org-context.test.ts`

3. **迁移 db mock 用户**（4 个文件）：`skill-download-route.test.ts`、`config-mcp-network.test.ts`、`meta-agent-api-key.test.ts`、`workflow-trigger-repo.test.ts`

4. **处理非白名单 mock**（内部服务 mock）：`../repositories`（6 个文件）、`../services/session`（3 个文件）、`../services/core-bootstrap`（3 个文件）等。这些需要重构测试结构或考虑加入白名单。

5. **清理前端类型检查测试**：移除 `config-types.test.ts` 等纯类型断言测试。

6. **添加前端关键流程测试**：按设计规范新增 `<功能>-flow.test.ts` 测试。
