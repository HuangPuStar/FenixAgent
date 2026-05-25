# 消除 mock.module 测试重构计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除所有 `mock.module()` 调用，改用不污染全局的方式，使 `bun test src/__tests__/` 批量运行全绿。

**Architecture:** 按模块分层重构——底层 DB/ORM mock 改为真实数据库操作；中间层 services/config mock 改为依赖注入或真实调用；外层边界 mock（node-schedule、globalThis.fetch）保留但改为不使用 `mock.module()` 的方式。核心原则：**只 mock 进程边界**（fetch、时间、外部进程），不 mock 内部模块。

**Tech Stack:** Bun test, Drizzle ORM, PostgreSQL, Elysia

---

## 背景与现状

- 82 个测试文件使用 `mock.module()` mock 内部模块
- `mock.module()` 在 Bun test 中全局生效，不同文件的 mock 互相覆盖
- 单独运行时仅 ~12 个文件（~76 个测试）有真正 bug，批量运行多出 ~109 个因 mock 污染导致的失败
- 已完成：34 个文件的 `../logger` mock 已删除（logger 在 test env 自动静音）

## mock.module 使用分布

| 被 mock 的模块 | 文件数 | 用途 |
|---|---|---|
| `../logger` | 34 | ✅ 已删除 |
| `../repositories` | 42 | 替换 DB 层 |
| `../config` | 54 | 替换配置 |
| `../services/*` | 60 | 替换业务逻辑 |
| `../auth/better-auth` | 15 | 替换认证 |
| `node-schedule` | 9 | 替换 cron 库 |
| `../db` / `../db/schema` | 12 | 替换 ORM 层 |

## 替代策略总览

| 原 mock 用途 | 替代方案 | 适用文件数 |
|---|---|---|
| 让 import 不报错（不验证 mock 行为） | 用真实模块，必要时接受副作用 | ~56 |
| 验证函数调用行为（mock.calls） | 改为验证 DB/返回值（集成测试） | ~26 |
| mock 外部依赖（node-schedule） | 提取为可注入的 scheduler 接口 | ~9 |
| mock globalThis.fetch | ✅ 保留，不使用 mock.module | 已有 10 个文件这样做 |

---

## 文件结构

本次重构**不创建新文件**，只修改现有测试文件和少量源代码文件。

**源码修改**（为支持依赖注入）：
- `src/services/scheduler.ts` — 提取 `scheduleJob` 为可替换函数
- `src/services/config/jsonb.ts` — 无需修改（纯函数，直接用真实版）

**测试文件修改**：82 个 `src/__tests__/*.test.ts` 文件

---

## Task 1: 提取 scheduler 接口（消除 node-schedule mock）

9 个测试文件 mock 了 `node-schedule`，这是唯一合理的外部依赖 mock，但不应通过 `mock.module()` 实现。

**Files:**
- Modify: `src/services/scheduler.ts`

- [ ] **Step 1: 在 scheduler.ts 中提取 scheduleJob 为可替换导出**

在 `src/services/scheduler.ts` 中，将 `node-schedule` 的 `scheduleJob` 调用提取为一个模块级变量，允许测试时替换：

```typescript
// 文件顶部，import 之后
import schedule from "node-schedule";

// 可替换的 schedule 实现（测试时覆盖）
export let scheduleJobImpl = schedule.scheduleJob.bind(schedule);

export function setScheduleJobImpl(fn: typeof scheduleJobImpl) {
  scheduleJobImpl = fn;
}
```

然后将 `scheduleTask` 函数内部的 `schedule.scheduleJob(...)` 调用改为 `scheduleJobImpl(...)`。

- [ ] **Step 2: 验证 scheduler.test.ts 改用 setScheduleJobImpl**

```typescript
import { scheduleTask, unscheduleTask, setScheduleJobImpl, stopScheduler } from "../services/scheduler";

// 替代 mock.module("node-schedule", ...)
const mockScheduleJob = mock((_config: unknown, handler: () => void) => ({
  cancel: mockCancel,
  nextInvocation: mockNextInvocation,
  __handler: handler,
}));

beforeEach(() => {
  setScheduleJobImpl(mockScheduleJob);
  stopScheduler();
  // ...
});
```

注意：不需要 `mock.module()`，也不需要 `await import()`，直接顶层 `import` 即可。

- [ ] **Step 3: 批量更新其余 8 个 scheduler 测试文件**

以下文件全部改为使用 `setScheduleJobImpl()` 替代 `mock.module("node-schedule", ...)`，并删除相关的 `../repositories/task` 和 `./task` mock（这些 mock 只为让 import 不报错，改为使用真实模块）：

- `scheduler-return-value.test.ts`
- `scheduler-reschedule-return.test.ts`
- `scheduler-disabled-auto-unschedule.test.ts`
- `scheduler-prefetch.test.ts`
- `scheduler-skipped-parallel.test.ts`
- `scheduler-stale-job-cleanup.test.ts`
- `scheduler-start-failed-count.test.ts`
- `scheduler.test.ts`

每个文件的改动模式：
1. 删除 `mock.module("node-schedule", ...)`
2. 删除 `mock.module("../repositories/task", ...)` — 使用真实 repo
3. 删除 `mock.module("./task", ...)` — 使用真实 task service
4. 删除 `mock.module("../services/task", ...)` — 使用真实 task service
5. 改为 `import { scheduleTask, ... setScheduleJobImpl } from "../services/scheduler"`
6. 在 `beforeEach` 中调用 `setScheduleJobImpl(mockFn)` 和 `stopScheduler()`
7. 需要 `ensureTeam()` + `ensureUser()` + `insertTask()` 辅助函数（参考现有 scheduler.test.ts）
8. 清理测试数据（`afterAll` 删除测试数据）

对于测试中验证 mock 行为的（如 `scheduler-disabled-auto-unschedule` 检查 `unscheduleTask` 调用），改为验证 DB 状态或函数返回值。

- [ ] **Step 4: 运行 scheduler 相关测试验证**

Run: `bun test src/__tests__/scheduler*.test.ts`
Expected: 全部通过

---

## Task 2: 消除 task 系列测试的内部模块 mock

13 个 `task-*.test.ts` 文件 mock 了 `../repositories/task`、`../services/scheduler`、`../services/config/jsonb` 等内部模块。

**Files:**
- Modify: `src/__tests__/task-error-message-fallback.test.ts`
- Modify: `src/__tests__/task-timeout-detection.test.ts`
- Modify: `src/__tests__/task-timeout-status.test.ts`
- Modify: `src/__tests__/task-http-methods-constant.test.ts`
- Modify: `src/__tests__/task-prefetch-content-type.test.ts`
- Modify: `src/__tests__/task-list-logs-total-coercion.test.ts`
- Modify: `src/__tests__/task-clear-logs-ownership.test.ts`
- Modify: `src/__tests__/write-log-fire-forget.test.ts`
- Modify: `src/__tests__/write-log-no-duplicate.test.ts`

- [ ] **Step 1: 分析每个文件的 mock 用途，确定替代方案**

以 `task-error-message-fallback.test.ts` 为例，它 mock 了：
- `../repositories/task` — 只为让 `./task` 模块能导入，测试不检查 repo 调用
- `../services/scheduler` — 只为让 `./task` 能导入
- `../services/config/jsonb` — `parseJsonb` 是纯函数，直接用真实版

替代方案：
- 删除 `mock.module("../repositories/task", ...)` — 使用真实 repo（需要 ensureTeam + 插入测试数据）
- 删除 `mock.module("../services/scheduler", ...)` — 使用真实 scheduler（结合 Task 1 的 `setScheduleJobImpl`）
- 删除 `mock.module("../services/config/jsonb", ...)` — 使用真实 `parseJsonb`
- 保留 `globalThis.fetch = mockFetch` — 这是边界 mock，不污染全局模块缓存

- [ ] **Step 2: 为每个 task 测试添加真实 DB 初始化**

每个文件的改动模式：
1. 删除所有 `mock.module()` 调用
2. 改为顶层 `import { executeTaskById } from "../services/task"`
3. 添加 `ensureUser()` / `ensureTeam()` 辅助（参考已有模式）
4. 添加 `insertTask()` 辅助在 DB 中创建真实 task 行
5. 测试中的 `baseTask` 对象改为从 DB 读取的真实行
6. `afterAll` 清理测试数据
7. 保留 `globalThis.fetch = mockFn` + `globalThis.fetch = originalFetch` 还原模式

- [ ] **Step 3: 运行 task 测试验证**

Run: `bun test src/__tests__/task-*.test.ts src/__tests__/write-log-*.test.ts`
Expected: 全部通过

---

## Task 3: 消除 config 层 mock（DB 层 mock 替代方案）

12 个文件 mock 了 `../db` 或 `../db/schema`，这些是最直接的 DB 层 mock。另有 17 个文件 mock 了 `../services/config/jsonb`。

**Files:**
- Modify: `src/__tests__/agent-config-build-set.test.ts`
- Modify: `src/__tests__/agent-config-create-single-loop.test.ts`
- Modify: `src/__tests__/agent-config-update-return.test.ts`
- Modify: `src/__tests__/aggregate-parallel-queries.test.ts`
- Modify: `src/__tests__/config-mcp-network.test.ts`
- Modify: `src/__tests__/mcp-agent-config-upsert.test.ts`
- Modify: `src/__tests__/mcp-count-number-coercion.test.ts`
- Modify: `src/__tests__/mcp-set-enabled-return.test.ts`
- Modify: `src/__tests__/mcp-update-return.test.ts`
- Modify: `src/__tests__/model-build-values.test.ts`
- Modify: `src/__tests__/model-update-return.test.ts`
- Modify: `src/__tests__/model-upsert-conflict.test.ts`

- [ ] **Step 1: 改用真实 DB + cleanup**

这些测试 mock DB 层来测试 config CRUD 函数。替代方案是直接用真实 DB：

每个文件的改动模式：
1. 删除 `mock.module("../db", ...)` 和 `mock.module("../db/schema", ...)`
2. 顶层 `import { db } from "../db"` 和 `import { provider, model, ... } from "../db/schema"`
3. 添加 `TEST_TEAM_ID` + `ensureTeam()` 辅助
4. `beforeEach` 清理测试数据：`await db.delete(model).where(eq(model.teamId, TEST_TEAM_ID))`
5. 测试直接调用真实 config 函数（如 `addModel`、`updateModel`）并验证 DB 中的数据
6. `afterAll` 清理

对于 `model-build-values.test.ts`，它 mock DB 是为了验证 SQL 构建逻辑而非执行 SQL。可以改为：直接执行真实 SQL 然后验证 DB 返回值，或提取 SQL 构建逻辑为纯函数单独测试。

- [ ] **Step 2: 运行 config 测试验证**

Run: `bun test src/__tests__/agent-config-*.test.ts src/__tests__/mcp-*.test.ts src/__tests__/model-*.test.ts src/__tests__/aggregate-*.test.ts src/__tests__/config-mcp-network.test.ts`
Expected: 全部通过

---

## Task 4: 消除 instance 系列测试的内部模块 mock

11 个 `instance-*.test.ts` 文件 mock 了 `../repositories`、`../services/core-bootstrap`、`../services/session` 等。

**Files:**
- Modify: `src/__tests__/instance-service.test.ts`
- Modify: `src/__tests__/instance-prefetch-env.test.ts`
- Modify: `src/__tests__/instance-counter-cleanup.test.ts`
- Modify: `src/__tests__/instance-ensure-running-merged.test.ts`
- Modify: `src/__tests__/instance-getinstance-cleanup.test.ts`
- Modify: `src/__tests__/instance-supplement-cleanup.test.ts`
- Modify: `src/__tests__/instance-workspace-nullish.test.ts`
- Modify: `src/__tests__/ensure-running-recheck.test.ts`
- Modify: `src/__tests__/group-instances-batch.test.ts`
- Modify: `src/__tests__/env-create-duplicate-detect.test.ts`
- Modify: `src/__tests__/stop-all-instances-parallel.test.ts`
- Modify: `src/__tests__/stop-all-instances-stopping.test.ts`

这些测试的核心挑战是 mock 了 `../services/core-bootstrap`（`getCoreRuntime`），这是一个运行时实例。替代方案：

- [ ] **Step 1: 提取 coreRuntime 为可替换的模块级变量**

在 `src/services/core-bootstrap.ts`（或 `src/services/instance.ts` 中导入 core 的位置）提取 `getCoreRuntime` 为可替换函数：

```typescript
export let getCoreRuntimeFn = getCoreRuntime;

export function setCoreRuntimeFn(fn: typeof getCoreRuntime) {
  getCoreRuntimeFn = fn;
}
```

- [ ] **Step 2: 更新 instance 测试文件**

每个文件的改动模式：
1. 删除 `mock.module("../repositories", ...)` — 使用真实 repo（ensureUser + ensureTeam + 创建真实 environment）
2. 删除 `mock.module("../services/core-bootstrap", ...)` — 改为 `setCoreRuntimeFn(mockRuntime)`
3. 删除 `mock.module("../services/session", ...)` — 使用真实 session service 或 `setSessionFactory`
4. 删除 `mock.module("../errors", ...)` — 使用真实 errors 模块
5. 添加 DB 初始化和清理辅助函数

- [ ] **Step 3: 运行 instance 测试验证**

Run: `bun test src/__tests__/instance-*.test.ts src/__tests__/ensure-running-*.test.ts src/__tests__/group-*.test.ts src/__tests__/stop-all-*.test.ts src/__tests__/env-create-*.test.ts`
Expected: 全部通过

---

## Task 5: 消除 skill 系列测试的内部模块 mock

5 个 `skill-import-*.test.ts` 和相关文件 mock 了 `../repositories`、`../services/skill-fs` 等。

**Files:**
- Modify: `src/__tests__/skill-import-finally-cleanup.test.ts`
- Modify: `src/__tests__/skill-import-shared-validation.test.ts`
- Modify: `src/__tests__/skill-import-upsert-parallel.test.ts`
- Modify: `src/__tests__/skill-import-parallel-deletes.test.ts`
- Modify: `src/__tests__/skill-source-workspace-guard.test.ts`
- Modify: `src/__tests__/set-skill-rollback.test.ts`

这些文件 mock 了 `skill-fs`（文件系统操作）。替代方案：

- [ ] **Step 1: 提取 skill-fs 操作为可注入接口**

在 `src/services/skill-fs.ts` 中将关键函数（`groupUploadFiles`、`writeSkillMd`、`deleteSkillDir` 等）提取为模块级可替换变量，类似于 Task 1 的 `setScheduleJobImpl` 模式。

- [ ] **Step 2: 更新 skill 测试文件**

1. 删除 `mock.module("../repositories", ...)`
2. 删除 `mock.module("../services/skill-fs", ...)`
3. 删除 `mock.module("./skill-fs", ...)`
4. 删除 `mock.module("./config-pg", ...)`
5. 使用真实 DB + 可注入的 skill-fs 操作
6. 添加 `ensureUser` + `ensureTeam` + cleanup 辅助

- [ ] **Step 3: 运行 skill 测试验证**

Run: `bun test src/__tests__/skill-*.test.ts src/__tests__/set-skill-*.test.ts`
Expected: 全部通过

---

## Task 6: 消除 session 相关测试的 mock

**Files:**
- Modify: `src/__tests__/session-async-cleanup.test.ts`
- Modify: `src/__tests__/session-sync-functions.test.ts`

- [ ] **Step 1: 更新 session 测试**

这两个文件 mock 了 `../repositories`（sessionRepo）和 `uuid`。

替代方案：
1. 删除 `mock.module("../repositories", ...)` — 使用真实 sessionRepo（确保 DB 有测试用 environment）
2. `mock.module("uuid", ...)` — 如果只是为固定 ID，可以不 mock，测试中用返回的真实 UUID
3. 顶层 `import` 替代 `await import()`

- [ ] **Step 2: 运行 session 测试验证**

Run: `bun test src/__tests__/session-*.test.ts`
Expected: 全部通过

---

## Task 7: 消除 acp/transport 系列测试的 mock

**Files:**
- Modify: `src/__tests__/acp-identify-parallel.test.ts`
- Modify: `src/__tests__/acp-register-combined-update.test.ts`
- Modify: `src/__tests__/acp-token-match.test.ts`
- Modify: `src/__tests__/nullish-coalescing-acp.test.ts`
- Modify: `src/__tests__/register-bridge-ownership.test.ts`
- Modify: `src/__tests__/register-bridge-parallel.test.ts`
- Modify: `src/__tests__/ws-handler.test.ts`
- Modify: `src/__tests__/sse-writer.test.ts`

- [ ] **Step 1: 分析每个文件并更新**

- `ws-handler.test.ts`：mock 了 `../config`（配置对象）。替代：使用真实 config（测试环境 config 就是默认值）
- `sse-writer.test.ts`：mock 了 `../config`。替代：使用真实 config
- `acp-token-match.test.ts`：mock 了 `../config`。替代：使用真实 config + 真实 DB
- `acp-identify-parallel.test.ts` / `acp-register-combined-update.test.ts`：mock 了 `../repositories` 和 `../services/session`。替代：真实 DB
- `nullish-coalescing-acp.test.ts`：mock 了 `../repositories` 和 `../services/session`。替代：真实 DB
- `register-bridge-*.test.ts`：mock 了 `../repositories`、`../services/session`、`../services/environment-core`、`../errors`。替代：真实 DB + 真实 errors 模块

- [ ] **Step 2: 运行 acp/transport 测试验证**

Run: `bun test src/__tests__/acp-*.test.ts src/__tests__/register-*.test.ts src/__tests__/nullish-*.test.ts src/__tests__/ws-handler.test.ts src/__tests__/sse-writer.test.ts`
Expected: 全部通过

---

## Task 8: 消除路由级测试的 mock（config-routes、channel-routes 等）

这些文件通过 Elysia 的 `.handle()` 测试路由，mock 了 `../auth/better-auth` 和 `../services/team`。

**Files:**
- Modify: `src/__tests__/config-providers.test.ts`
- Modify: `src/__tests__/config-models.test.ts`
- Modify: `src/__tests__/config-skills.test.ts`
- Modify: `src/__tests__/config-agents.test.ts`
- Modify: `src/__tests__/config-mcp.test.ts`
- Modify: `src/__tests__/config-mcp-network.test.ts`
- Modify: `src/__tests__/config-integration.test.ts`
- Modify: `src/__tests__/channel-routes.test.ts`
- Modify: `src/__tests__/channel-provider.test.ts`
- Modify: `src/__tests__/web-environments.test.ts`
- Modify: `src/__tests__/web-knowledge-bases.test.ts`
- Modify: `src/__tests__/web-knowledge-resources.test.ts`
- Modify: `src/__tests__/files-route.test.ts`
- Modify: `src/__tests__/middleware.test.ts`
- Modify: `src/__tests__/routes.test.ts`
- Modify: `src/__tests__/permission-flow.test.ts`
- Modify: `src/__tests__/task-routes.test.ts`
- Modify: `src/__tests__/workflow-proxy.test.ts`
- Modify: `src/__tests__/auth.test.ts`

- [ ] **Step 1: 提取 auth mock 为 Elysia 插件替换**

这些路由测试的核心问题是 `authGuardPlugin` 依赖 `../auth/better-auth` 的 `auth.api.getSession()`。替代方案：

在 `src/plugins/auth.ts` 中导出一个 `setAuthSessionMock` 函数，允许测试注入预设的 session：

```typescript
let authSessionMock: ((request: Request) => Promise<{ user: any; session: any } | null>) | null = null;

export function setAuthSessionMock(fn: typeof authSessionMock | null) {
  authSessionMock = fn;
}

// 在 sessionAuth macro 内部：
const sessionResult = authSessionMock
  ? await authSessionMock(request)
  : await auth.api.getSession({ ... });
```

测试中使用：
```typescript
import { setAuthSessionMock } from "../plugins/auth";

beforeEach(() => {
  setAuthSessionMock(async () => ({
    user: { id: "test-user", email: "test@test.com" },
    session: { id: "sess_test", userId: "test-user" },
  }));
});

afterAll(() => {
  setAuthSessionMock(null);
});
```

- [ ] **Step 2: 提取 team context mock**

类似地，在 `src/services/team.ts` 或 `src/services/team-context.ts` 中导出 `setTeamContextMock`：

```typescript
let teamContextMock: ((userId: string, request: Request) => Promise<AuthContext | null>) | null = null;

export function setTeamContextMock(fn: typeof teamContextMock | null) {
  teamContextMock = fn;
}
```

- [ ] **Step 3: 批量更新路由测试文件**

每个文件的改动模式：
1. 删除 `mock.module("../auth/better-auth", ...)` — 改为 `setAuthSessionMock(...)`
2. 删除 `mock.module("../services/team", ...)` — 改为 `setTeamContextMock(...)`
3. 删除其他内部模块 mock（`../repositories`、`../config` 等）
4. 使用真实 DB 初始化数据
5. 顶层 `import` 替代 `await import()`

- [ ] **Step 4: 运行路由测试验证**

Run: `bun test src/__tests__/config-*.test.ts src/__tests__/channel-*.test.ts src/__tests__/web-*.test.ts src/__tests__/files-route.test.ts src/__tests__/middleware.test.ts src/__tests__/routes.test.ts src/__tests__/permission-flow.test.ts src/__tests__/task-routes.test.ts src/__tests__/workflow-proxy.test.ts src/__tests__/auth.test.ts`
Expected: 全部通过

---

## Task 9: 消除剩余文件的 mock

**Files:**
- Modify: `src/__tests__/work-dispatch.test.ts`
- Modify: `src/__tests__/disconnect-monitor.test.ts`
- Modify: `src/__tests__/services.test.ts`
- Modify: `src/__tests__/knowledge-provider-openviking.test.ts`
- Modify: `src/__tests__/api-key-service.test.ts`（已无 mock.module，需修复签名问题）

- [ ] **Step 1: 更新 work-dispatch.test.ts**

该文件 mock 了 `../config`（JWT 签名）。替代：使用真实 config（测试环境已有 `RCS_API_KEYS`）。

- [ ] **Step 2: 更新 disconnect-monitor.test.ts**

该文件 mock 了 `../config`。替代：使用真实 config（测试环境的 disconnectTimeout 值不影响正确性）。

- [ ] **Step 3: 更新 services.test.ts**

该文件 mock 了 `../services/skill-fs`。替代：结合 Task 5 的 skill-fs 注入。

- [ ] **Step 4: 更新 knowledge-provider-openviking.test.ts**

该文件 mock 了 `../config` 和 `../services/hermes-client`。替代：使用真实 config + 提取 hermes-client 为可注入。

- [ ] **Step 5: 运行全部测试验证**

Run: `bun test src/__tests__/`
Expected: 0 fail, 0 errors

---

## Task 10: 全面验证与清理

- [ ] **Step 1: 确认没有残留的 mock.module**

Run: `grep -r 'mock\.module' src/__tests__/*.test.ts`
Expected: 无输出

- [ ] **Step 2: 运行完整测试套件 3 次，确认稳定性**

Run: `for i in 1 2 3; do echo "=== Run $i ===" && bun test src/__tests__/ 2>&1 | tail -3; done`
Expected: 每次都是 0 fail

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "refactor: 消除所有 mock.module 调用，改用依赖注入和集成测试

- 提取 scheduler/node-schedule 为可注入接口 (setScheduleJobImpl)
- 提取 core-runtime 为可注入接口 (setCoreRuntimeFn)
- 提取 auth session 为可注入接口 (setAuthSessionMock)
- 提取 team context 为可注入接口 (setTeamContextMock)
- 删除 82 个测试文件的 mock.module 调用
- 改用真实 DB + 真实模块做集成测试
- 保留 globalThis.fetch 作为唯一的边界 mock
- 修复所有因 mock 污染导致的批量运行失败"
```
