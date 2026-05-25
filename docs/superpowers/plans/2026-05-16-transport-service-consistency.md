# Transport 层 Service 一致性 — 消除直访 Repository

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `acp-ws-handler.ts` 和 `acp-relay-handler.ts` 中直接调用 `environmentRepo` 的代码改为通过 `environmentService` 间接访问，使 Transport 层不再依赖 Repository 层。

**Architecture:** 依赖 Plan 1（Environment Service 深化）完成后执行。Transport 层的所有 Environment 数据操作改为调用 Service 函数。Service 层提供 Transport 所需的专用函数（如 `markEnvironmentActive`、`markEnvironmentIdle`、`createTemporaryEnvironment`）。CONTEXT.md 规则："Transport 层通过 Service 访问 Repository，不直接导入 store 函数。"

**Tech Stack:** Elysia、WebSocket、Eden

**Prerequisite:** Plan 1（Environment Service 深化）已完成。

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/services/environment.ts` | 新增 Transport 层所需的专用函数 |
| Modify | `src/transport/acp-ws-handler.ts` | 替换 `environmentRepo` 为 Service 调用 |
| Modify | `src/transport/acp-relay-handler.ts` | 替换 `environmentRepo` 为 Service 调用 |
| Create | `src/__tests__/transport-service-consistency.test.ts` | 验证 Transport 不直接 import repo |

---

### Task 1: 在 Environment Service 中新增 Transport 专用函数

**Files:**
- Modify: `src/services/environment.ts`

- [ ] **Step 1: 添加 Transport 层需要的 Service 函数**

在 `src/services/environment.ts` 底部添加以下函数，每个封装一个 `environmentRepo` 调用：

```typescript
// ────────────────────────────────────────────
// Transport 层专用接口
// ────────────────────────────────────────────

/** 标记 Environment 为 active 并更新 poll 时间（fire-and-forget 安全） */
export async function markEnvironmentActive(envId: string): Promise<void> {
  await environmentRepo.update(envId, { status: "active", lastPollAt: new Date() });
}

/** 标记 Environment 为 idle */
export async function markEnvironmentIdle(envId: string): Promise<void> {
  await environmentRepo.update(envId, { status: "idle" });
}

/** 更新 Environment 的 lastPollAt */
export async function touchEnvironmentPoll(envId: string): Promise<void> {
  await environmentRepo.update(envId, { lastPollAt: new Date() });
}

/** 更新 Environment capabilities 和 maxSessions */
export async function updateEnvironmentCapabilities(
  envId: string,
  patch: { capabilities?: Record<string, unknown> | null; maxSessions?: number },
): Promise<void> {
  await environmentRepo.update(envId, {
    capabilities: patch.capabilities ?? undefined,
    maxSessions: patch.maxSessions,
  });
}

/** 创建临时 Environment（非持久化，WS 注册用） */
export async function createTemporaryEnvironment(params: {
  secret: string;
  userId: string;
  machineName: string;
  directory?: string;
  maxSessions?: number;
  capabilities?: Record<string, unknown>;
}): Promise<EnvironmentRecord> {
  return environmentRepo.create({
    secret: params.secret,
    userId: params.userId,
    machineName: params.machineName,
    workerType: "acp",
    directory: params.directory,
    maxSessions: params.maxSessions,
    capabilities: params.capabilities,
  });
}

/** 按 secret 查找 Environment */
export async function getEnvironmentBySecret(secret: string) {
  return environmentRepo.getBySecret(secret);
}
```

- [ ] **Step 2: 运行类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add src/services/environment.ts
git commit -m "feat: Environment Service 添加 Transport 层专用接口"
```

---

### Task 2: 重构 acp-ws-handler.ts — 消除 environmentRepo 直访

**Files:**
- Modify: `src/transport/acp-ws-handler.ts`

- [ ] **Step 1: 替换 import**

将：
```typescript
import { environmentRepo } from "../repositories";
import { deleteEnvironment } from "../services/environment";
```

替换为：
```typescript
import {
  markEnvironmentActive,
  markEnvironmentIdle,
  touchEnvironmentPoll,
  updateEnvironmentCapabilities,
  createTemporaryEnvironment,
  getEnvironment,
  deleteEnvironment,
} from "../services/environment";
```

- [ ] **Step 2: 替换 handleAcpWsOpen 中的 repo 调用**

将：
```typescript
environmentRepo.update(boundEnvId, { status: "active", lastPollAt: new Date() }).catch(() => {});
```

替换为：
```typescript
markEnvironmentActive(boundEnvId).catch(() => {});
```

- [ ] **Step 3: 替换 handleRegister 中的 repo 调用**

在 `handleRegister` 中有三处 `environmentRepo` 调用：

1. 更新持久 Environment 状态：
```typescript
// 旧:
await environmentRepo.update(entry.boundEnvId, { status: "active", lastPollAt: new Date(), capabilities: capabilities || null, maxSessions });
// 新:
await markEnvironmentActive(entry.boundEnvId);
await updateEnvironmentCapabilities(entry.boundEnvId, { capabilities: capabilities || null, maxSessions });
```

2. 创建临时 Environment：
```typescript
// 旧:
const record = await environmentRepo.create({ secret: `ws_${wsId}`, userId: entry.userId, ... });
// 新:
const record = await createTemporaryEnvironment({ secret: `ws_${wsId}`, userId: entry.userId, machineName: agentName, directory, maxSessions, capabilities: capabilities || undefined });
```

- [ ] **Step 4: 替换 handleIdentify 中的 repo 调用**

1. 更新持久 Environment 状态（boundEnvId 分支）：
```typescript
// 旧:
await environmentRepo.update(entry.boundEnvId, { status: "active", lastPollAt: new Date() });
// 新:
await markEnvironmentActive(entry.boundEnvId);
```

2. 查找 Environment：
```typescript
// 旧:
const record = await environmentRepo.getById(agentId);
// 新:
const record = await getEnvironment(agentId);
```
注意：`getEnvironment` 返回 `EnvironmentRecord | undefined`，和 `environmentRepo.getById` 一致，需要适配 `if (!record || record.workerType !== "acp")` 检查。

3. 更新 active 状态：
```typescript
// 旧:
await environmentRepo.update(agentId, { status: "active", lastPollAt: new Date() });
// 新:
await markEnvironmentActive(agentId);
```

- [ ] **Step 5: 替换 handleAcpWsMessage 中的 fire-and-forget 调用**

两处 `lastPollAt` 更新：
```typescript
// 旧:
environmentRepo.update(entry.agentId, { lastPollAt: new Date() }).catch(() => {});
// 新:
touchEnvironmentPoll(entry.agentId).catch(() => {});
```

- [ ] **Step 6: 替换 handleAcpWsClose 中的 repo 调用**

```typescript
// 旧:
environmentRepo.update(entry.agentId, { status: "idle" }).catch(() => {});
// 新:
markEnvironmentIdle(entry.agentId).catch(() => {});
```

- [ ] **Step 7: 替换 closeAllAcpConnections 中的 repo 调用**

```typescript
// 旧:
environmentRepo.update(entry.agentId, { status: "idle" }).catch(() => {});
// 新:
markEnvironmentIdle(entry.agentId).catch(() => {});
```

- [ ] **Step 8: 运行类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 9: Commit**

```bash
git add src/transport/acp-ws-handler.ts
git commit -m "refactor: acp-ws-handler 通过 Service 层访问 Environment 数据"
```

---

### Task 3: 重构 acp-relay-handler.ts — 消除 environmentRepo 直访

**Files:**
- Modify: `src/transport/acp-relay-handler.ts`

- [ ] **Step 1: 替换 import**

将：
```typescript
import { environmentRepo } from "../repositories";
```

替换为：
```typescript
import { getEnvironment } from "../services/environment";
```

- [ ] **Step 2: 替换 handleRelayMessage 中的 repo 调用**

在 EventBus 模式的 `connect` 消息处理中：
```typescript
// 旧:
const env = await environmentRepo.getById(entry.agentId);
// 新:
const env = await getEnvironment(entry.agentId);
```

- [ ] **Step 3: 运行类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/transport/acp-relay-handler.ts
git commit -m "refactor: acp-relay-handler 通过 Service 层访问 Environment 数据"
```

---

### Task 4: 验证 Transport 层不再直接 import Repository

**Files:**
- Create: `src/__tests__/transport-service-consistency.test.ts`

- [ ] **Step 1: 写断言测试**

```typescript
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const TRANSPORT_FILES = [
  "src/transport/acp-ws-handler.ts",
  "src/transport/acp-relay-handler.ts",
];

describe("Transport 层不直接访问 Repository", () => {
  for (const file of TRANSPORT_FILES) {
    test(`${file} 不包含 environmentRepo 直访`, () => {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain("from \"../repositories\"");
      expect(content).not.toContain("environmentRepo.");
    });
  }
});
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/__tests__/transport-service-consistency.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/transport-service-consistency.test.ts
git commit -m "test: 添加 Transport 层 Repository 隔离断言"
```

---

## Self-Review

**Spec coverage:** acp-ws-handler 和 acp-relay-handler 中的所有 `environmentRepo` 调用点都已覆盖。

**Placeholder scan:** 无 TBD/TODO，所有代码步骤包含完整实现。

**Type consistency:** `createTemporaryEnvironment` 参数类型与 `environmentRepo.create` 兼容。`getEnvironment` 返回类型与 `environmentRepo.getById` 一致（`EnvironmentRecord | undefined`），调用处的 `if (!record)` 检查无需修改。
