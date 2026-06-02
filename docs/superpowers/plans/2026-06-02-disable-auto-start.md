# Disable Auto Start — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除服务器启动时的批量 auto-spawn 循环，在 `ensureRunning` 中按需懒启动，尊重 `autoStart` 标记。

**Architecture:** 删除 `src/index.ts` 中的 auto-start IIFE 块。修改 `ensureRunning` 在 spawn 前检查 `env.autoStart`，为 false 时抛出明确错误。`ensureRunning` 已有 `env` 查询，无需额外 DB 调用。

**Tech Stack:** TypeScript, Bun test

---

### Task 1: 为 `ensureRunning` autoStart 门控写测试

**Files:**
- Create: `src/__tests__/instance-ensureRunning.test.ts`
- Read: `src/services/instance.ts`（理解 `ensureRunning` 签名和依赖）
- Read: `src/repositories/environment.ts`（理解 repo 接口）

- [ ] **Step 1: 创建测试文件，写 autoStart=false 的失败测试**

```typescript
import { describe, expect, test } from "bun:test";
import { AppError } from "../errors";

describe("ensureRunning autoStart gate", () => {
  // autoStart=false 时应抛出错误而不是 spawn
  test("throws when autoStart is false and no instance running", async () => {
    const { ensureRunning } = await import("../services/instance");
    const { environmentRepo } = await import("../repositories");

    // 用 stub 让 environmentRepo.getById 返回一个 autoStart=false 的环境
    const origGetById = environmentRepo.getById;
    (environmentRepo as any).getById = async () => ({
      id: "env-1",
      name: "test-env",
      autoStart: false,
      maxSessions: 5,
      userId: "user-1",
      organizationId: "org-1",
      agentConfigId: null,
    });

    try {
      const err = await ensureRunning("user-1", "env-1").catch((e: unknown) => e) as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(409);
      expect(err.message).toContain("autoStart");
    } finally {
      (environmentRepo as any).getById = origGetById;
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/__tests__/instance-ensureRunning.test.ts`
Expected: FAIL — 当前 `ensureRunning` 不会检查 autoStart，会直接 spawn（或因 mock 不完整而报其他错误）

- [ ] **Step 3: Commit 空测试骨架（标记为已知失败）**

```bash
git add src/__tests__/instance-ensureRunning.test.ts
git commit -m "test(instance): 添加 ensureRunning autoStart 门控测试骨架

Co-authored-by: GLM <glm@zhipuai.cn>"
```

---

### Task 2: 在 `ensureRunning` 中加入 autoStart 检查

**Files:**
- Modify: `src/services/instance.ts:304-322`（`ensureRunning` 函数体）

- [ ] **Step 1: 在 `ensureRunning` 的 spawn 调用前插入 autoStart 检查**

当前 `ensureRunning`（line 304-322）在确认没有运行中实例后直接 spawn。需要在 `env` 查询后、async gap 重新检查前加入 autoStart 门控：

```typescript
export async function ensureRunning(userId: string, environmentId: string): Promise<EnsureRunningResult> {
  const runningInstances = getRunningInstancesByEnvironment(environmentId);
  const existing = runningInstances[0];
  if (existing) return { instance: existing, status: "reused" };

  const env = await environmentRepo.getById(environmentId);
  if (!env) throw new NotFoundError("Environment not found");

  // autoStart=false 时拒绝自动 spawn
  if (!env.autoStart) {
    throw new AppError("Instance not running and autoStart is disabled", "AUTO_START_DISABLED", 409);
  }

  // async gap 后重新检查：await 期间可能有并发请求新启了实例
  const currentRunning = getRunningInstancesByEnvironment(environmentId);
  if (currentRunning.length >= env.maxSessions) {
    // 并发场景下另一个请求可能已启动实例，优先复用
    if (currentRunning[0]) return { instance: currentRunning[0], status: "reused" };
    throw new AppError(`已达到最大实例数 ${env.maxSessions}`, "MAX_SESSIONS_REACHED", 409);
  }

  const instance = await spawnInstanceFromEnvironment(userId, environmentId, env);
  return { instance, status: "spawned" };
}
```

只需在 line 310 (`if (!env) throw ...`) 之后、line 312 (`// async gap`) 之前插入 3 行。

- [ ] **Step 2: 运行测试确认通过**

Run: `bun test src/__tests__/instance-ensureRunning.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/instance.ts
git commit -m "feat(instance): ensureRunning 加入 autoStart 门控

autoStart=false 时拒绝自动 spawn，抛出 AUTO_START_DISABLED 错误

Co-authored-by: GLM <glm@zhipuai.cn>"
```

---

### Task 3: 移除服务器启动 auto-spawn 循环

**Files:**
- Modify: `src/index.ts:67-96`（删除 auto-start IIFE 块）
- Modify: `src/index.ts:1-2`（清理不再需要的 import）
- Modify: `src/index.ts:28`（清理 import 中不再使用的函数）

- [ ] **Step 1: 删除 auto-start IIFE 块**

删除 `src/index.ts` 第 67-96 行的完整 IIFE 块：

```
// Auto-start instances for all environments on server boot
(async () => {
  ...
})();
```

删除后，第 65 行 `} catch { ... }` 之后直接接第 98 行的定期巡检注释 `// 定期巡检...`。

- [ ] **Step 2: 清理不再使用的 import**

删除 auto-start 块后，以下 import 在 `index.ts` 中不再被使用：

- `import { existsSync } from "node:fs";`（line 2）— 仅在 auto-start 块中使用
- `import { resolveWorkspacePath } from "./services/workspace-resolver";`（line 30）— 仅在 auto-start 块中使用

从 line 28 的 import 中移除不再使用的函数名：
- 之前: `import { findRunningInstanceByEnvironment, spawnInstanceFromEnvironment, stopAllInstances } from "./services/instance";`
- 之后: `import { stopAllInstances } from "./services/instance";`

检查 `environmentRepo` 是否在其他地方使用：如果 graceful shutdown 等逻辑中没有使用 `environmentRepo.listAll()`，也可以移除 `import { environmentRepo } from "./repositories";`（line 15）。通过 grep 确认 `environmentRepo` 在文件中只出现在 line 15 和已删除的 line 69，确认可以安全移除。

- [ ] **Step 3: 验证项目编译通过**

Run: `bunx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 运行全量测试**

Run: `bun test src/__tests__/`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "refactor: 移除服务器启动时的 auto-spawn 循环

实例改为通过 ensureRunning 按需懒启动，autoStart=false 的环境不再自动 spawn

Co-authored-by: GLM <glm@zhipuai.cn>"
```

---

### Task 4: 运行 precheck 并最终验证

**Files:** 无新增/修改

- [ ] **Step 1: 执行 precheck**

Run: `bun run precheck`
Expected: 格式化 + import 排序 + tsc + biome check 全部通过

- [ ] **Step 2: 如有自动修复被应用，检查变更并提交**

precheck 可能自动修复 import 排序。如果 `src/index.ts` 或 `src/services/instance.ts` 有变更：

```bash
git add -u
git commit -m "style: precheck 自动修复格式和 import 排序

Co-authored-by: GLM <glm@zhipuai.cn>"
```
