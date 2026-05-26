# 测试策略与规范设计

## 背景

Bun 的 `mock.module()` 全局生效，多文件 mock 同一模块导致两类冲突：
- 并行运行时 `SyntaxError: Export named 'xxx' not found`
- 单文件内 mock 覆盖另一个文件的 mock 导致断言失败

当前 23 个后端测试文件使用 `mock.module()`，`config-pg` 被 8+ 文件 mock，`better-auth` 被 6+ 文件 mock。

本规范的目标：消除 mock 冲突，定义清晰的测试分层和编写规则。

---

## 一、Mock 基础设施

### 方案：Preload + 全局 Stub 注册表

通过项目级 `bunfig.toml` 的 `preload` 字段在所有测试执行前完成 `mock.module()` 注册。被 mock 的模块内部是可配置的 stub 注册表，测试文件只操作注册表 API，永不调用 `mock.module()`。

### 文件结构

```
bunfig.toml
  preload = ["src/test-utils/setup-mocks.ts"]

src/test-utils/
  setup-mocks.ts              ← 唯一调用 mock.module() 的地方
  stubs/
    db-stub.ts                ← config-pg 相关函数的 stub 注册表
    auth-stub.ts              ← better-auth 相关函数的 stub 注册表
  helpers.ts                  ← resetAllStubs() 等公共工具
```

### Stub 注册表 API 设计

每个 stub 文件导出三个函数：`stubXxx(overrides)` 配置行为、`getXxxStub(name)` 供 mock 实现读取、`resetXxxStubs()` 重置状态。

```ts
// db-stub.ts
let _stubs: Record<string, Function> = {};

export function stubDb(overrides: Partial<DbStubs>) {
  _stubs = { ..._stubs, ...overrides };
}

export function getDbStub(name: keyof DbStubs): Function {
  const fn = _stubs[name];
  if (!fn) throw new Error(`db stub '${name}' not configured, call stubDb() in beforeEach`);
  return fn;
}

export function resetDbStubs() { _stubs = {}; }
```

`setup-mocks.ts` 中的 mock 实现：

```ts
mock.module("../services/config-pg", () => {
  const { getDbStub } = await import("../test-utils/stubs/db-stub");
  return new Proxy({}, {
    get(_, prop) { return getDbStub(prop); }
  });
});
```

未配置的 stub 抛出明确错误，测试作者能立刻定位遗漏。

### Mock 白名单

只有以下模块允许被 mock：

- `../db` — 数据库连接
- `../services/config-pg` — 数据库 CRUD 操作
- `../auth/better-auth` — 认证服务
- `../auth/api-key-service` — API Key 服务

不在白名单内的模块禁止 `mock.module()`。新增需要 mock 的模块时，须在 `setup-mocks.ts` 中集中添加并更新白名单。

### 清理机制

`helpers.ts` 导出 `resetAllStubs()`，调用所有 stub 模块的 `resetXxxStubs()`。在 `beforeEach` 中调用（不用 `afterEach`），避免前一个测试失败导致清理被跳过、污染后续测试。

---

## 二、后端测试分层策略

### 三层模型

| 层级 | 测试对象 | 依赖状态 | 示例 |
|------|----------|----------|------|
| **L1 纯函数单测** | 无副作用的纯函数、工具函数、数据转换 | 无 mock，直接 import | `jsonb-utils`、`workspace-resolver`、`structured-logger`、`error-class-semantics` |
| **L2 业务逻辑单测** | 需要外部依赖的业务函数 | 通过 stub 注册表注入 | `config-pg` CRUD、`scheduler` 调度逻辑、`skill` 导入流程 |
| **L3 路由集成测试** | 完整的请求-响应链路 | 通过 stub + 测试辅助函数 | providers CRUD 全流程、agent 配置保存、权限校验 |

### L1 纯函数单测

- 直接 import 被测函数，不需要任何 mock 或 stub
- 测试文件命名：`<功能描述>.test.ts`
- 不调用 `resetAllStubs()`，不引入 `test-utils`
- 适合：数据校验、格式化、计算逻辑、错误类定义

### L2 业务逻辑单测

- Import 被测函数，通过 `stubDb()` / `stubAuth()` 配置外部依赖的行为
- `beforeEach` 中调用 `resetAllStubs()` 再配置所需的 stub
- 测试业务逻辑本身（如"创建 provider 时如果已存在应该更新而非报错"），不涉及 HTTP 层
- 命名：`<模块名>-<功能>.test.ts`，如 `config-providers-crud.test.ts`

### L3 路由集成测试

- Import 路由的 `.default`（Elysia 实例），调用 `.handle(new Request(...))`
- 验证完整业务流程：请求参数校验 → 业务逻辑执行 → 响应格式正确
- 不重复 L2 已覆盖的逻辑细节，只验证"给定输入，流程走通、响应结构正确、关键错误码正确"
- 每个 L3 测试文件对应一个路由模块，命名 `route-<路由名>.test.ts`
- 错误路径只测关键分支（404、422、权限拒绝），不穷举

### 层间关系

- L2 和 L3 之间允许少量重叠（L3 覆盖 L2 的 happy path），但 L3 不重复 L2 的边界测试
- 新功能先写 L2 测试保证核心逻辑正确，再补 L3 测试验证流程闭环
- 纯路由转发（无业务逻辑）不需要 L3 测试

---

## 三、前端测试策略

### 原则

只测关键流程，保证用户核心操作的正确性。

### 不写的测试

- 类型检查 — 这是 `tsc` 的事，不属于测试
- 纯 UI 结构断言（"组件渲染了某个 className"）— 无行为价值
- 组件库（shadcn/ui、Radix）的内部行为 — 由库自身保证

### 要写的测试

| 场景类型 | 示例 | 验证目标 |
|----------|------|----------|
| **表单提交流程** | Provider 创建/编辑表单、API Key 创建 | 用户填写 → 提交 → API 被正确调用 → 成功反馈 |
| **关键数据操作** | Agent 配置保存、MCP Server 连接测试 | 操作后数据正确更新，失败时显示错误提示 |
| **导航与路由** | 配置页侧边栏导航、v2 Agent 面板路由 | 用户操作后到达正确页面，关键参数不丢失 |
| **状态联动** | 环境上线/下线后的 UI 状态变化 | 操作触发正确的 API 调用，UI 反映最新状态 |

### 前端测试写法规范

- 使用 React Testing Library，以用户视角编写（`screen.getByText`、`fireEvent.click`、`waitFor`）
- Mock API 调用使用 MSW（Mock Service Worker）或直接 mock `fetch`，不用 `mock.module()`
- 每个 test 文件上方加一行中文注释说明测试意图
- 测试文件放在 `web/src/__tests__/`，命名 `<页面或功能>-flow.test.ts`

### 清理与隔离

- 每个测试内部自行设置所需状态，不依赖其他测试的副作用
- DOM 清理由 React Testing Library 的 `cleanup()` 自动处理
- 全局状态（如 localStorage）在 `beforeEach` 中重置

---

## 四、测试文件组织与命名规范

### 目录结构

```
src/
  __tests__/
    <功能描述>.test.ts                    ← L1 纯函数测试
    <模块名>-<功能>.test.ts               ← L2 业务逻辑测试
    route-<路由名>.test.ts                ← L3 路由集成测试
  test-utils/
    setup-mocks.ts                        ← mock.module() 唯一注册点
    stubs/
      db-stub.ts
      auth-stub.ts
    helpers.ts                            ← resetAllStubs() 等

web/src/
  __tests__/
    <页面或功能>-flow.test.ts             ← 前端关键流程测试
```

### 命名规则

| 类型 | 模式 | 示例 |
|------|------|------|
| L1 纯函数 | `<功能>.test.ts` | `jsonb-utils.test.ts`、`error-class-semantics.test.ts` |
| L2 业务逻辑 | `<模块>-<功能>.test.ts` | `config-providers-crud.test.ts`、`scheduler-invocation.test.ts` |
| L3 路由集成 | `route-<路由>.test.ts` | `route-config-providers.test.ts`、`route-web-sessions.test.ts` |
| 前端流程 | `<功能>-flow.test.ts` | `provider-form-flow.test.ts`、`agent-config-flow.test.ts` |

### 测试文件内结构模板

**L1 — 无 setup：**

```ts
import { describe, expect, test } from "bun:test";
import { myFunction } from "../path/to/module";

describe("模块描述", () => {
  test("行为描述", () => { ... });
});
```

**L2 — 需要 stub：**

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "../test-utils/helpers";
import { stubDb } from "../test-utils/stubs/db-stub";
import { myService } from "../services/my-service";

describe("模块描述", () => {
  beforeEach(() => {
    resetAllStubs();
    stubDb({ getList: async () => [] });
  });

  test("行为描述", () => { ... });
});
```

**L3 — 路由测试：**

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "../test-utils/helpers";
import { stubDb } from "../test-utils/stubs/db-stub";
import { stubAuth } from "../test-utils/stubs/auth-stub";
import { setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";

const route = (await import("../routes/web/config/xxx")).default;

describe("路由描述", () => {
  beforeEach(() => {
    resetAllStubs();
    stubDb({ ... });
    setTestAuth({ ... });
    setTestOrgContext({ ... });
  });

  test("POST /web/config/xxx action=list 返回空列表", async () => {
    const res = await route.handle(new Request(...));
    const json = await res.json();
    expect(json.success).toBe(true);
  });
});
```

### 现有文件迁移

现有测试文件保持现有命名不变，后续新测试按新规范命名。需要重构 mock 的文件逐步迁移到 stub 注册表模式，不要求一次性全量迁移。

---

## 五、测试编写规则

### 必须遵守

1. **禁止在测试文件中调用 `mock.module()`** — 所有 mock 注册在 `setup-mocks.ts` 中完成，测试文件只通过 stub API 配置行为

2. **`beforeEach` 重置，不用 `afterEach` 清理** — stub 和全局状态在 `beforeEach` 中 `resetAllStubs()` + 配置，避免前一个测试失败导致清理被跳过、污染后续测试

3. **每个测试独立** — 不依赖其他测试的执行顺序或副作用，任何单个 `test(...)` 都能单独通过

4. **每个 test 上方一行中文注释说明意图** — 已有项目约定，保持

5. **不要为了覆盖率写测试** — 只测有行为价值的场景：核心逻辑正确性、边界条件、错误路径中的关键分支

6. **L3 路由测试不重复 L2 的逻辑** — L3 只验证"流程走通、响应格式正确、关键错误码正确"，不重复断言 L2 已覆盖的业务细节

### 禁止的写法

```ts
// ❌ 测试文件内调用 mock.module
mock.module("../services/config-pg", () => ({ ... }));

// ❌ 用 afterEach 清理
afterEach(() => resetAllStubs());

// ❌ 类型断言测试
test("ApiResponse type", () => {
  const r: ApiResponse = { success: true, data: {} };
  expect(r.success).toBe(true);
});

// ❌ 穷举所有错误路径
test("action=create name='' returns error", ...);
test("action=create name=null returns error", ...);
test("action=create name=undefined returns error", ...);
```

### 推荐的写法

```ts
// ✅ beforeEach 重置 + 配置
beforeEach(() => {
  resetAllStubs();
  stubDb({ listProviders: async () => [_provider] });
});

// ✅ 测试关键行为
test("重复创建 provider 时更新而非报错", async () => { ... });

// ✅ L3 只验证流程闭环
test("POST /web/config/providers action=list 返回 providers 列表", async () => {
  stubDb({ listProviders: async () => [provider] });
  const res = await route.handle(new Request(...));
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(json.data.providers).toHaveLength(1);
});
```

### Mock 白名单维护

新增外部依赖需要 mock 时，三步操作：

1. 在 `src/test-utils/stubs/` 下新建对应的 stub 文件
2. 在 `src/test-utils/setup-mocks.ts` 中添加 `mock.module()` 注册
3. 更新 CLAUDE.md 中的白名单
