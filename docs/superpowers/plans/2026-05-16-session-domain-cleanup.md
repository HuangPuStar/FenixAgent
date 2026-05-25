# Session 域残余清理 — 删除废弃代码和双写冗余

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清理 Session 域的废弃代码：删除 `session.ts` 中的死函数、简化 `session.ts` Repository 的双写模式、审计并移除 `token.ts` 和 `session-worker.ts` 中不再被使用的 Repository。

**Architecture:** Session 管理已下沉到 Agent 进程（acp-link）。`session.ts` 服务有 20+ 个导出函数，大部分返回空值/null/no-op。Session Repository 维护内存 Map + PostgreSQL 双写但内存 Map 已无消费者。逐步淘汰内存部分，只保留真正活跃的查询接口。

**Tech Stack:** Bun test、Drizzle ORM

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/services/session.ts` | 删除废弃函数 |
| Modify | `src/repositories/session.ts` | 移除内存 Map，改为纯 PG 查询 |
| Modify | `src/repositories/session-worker.ts` | 审计调用者，决定保留或删除 |
| Modify | `src/repositories/token.ts` | 审计调用者，决定保留或删除 |
| Modify | `src/repositories/index.ts` | 更新导出 |
| Modify | 所有引用废弃函数的文件 | 改为直接调用或删除引用 |

---

### Task 1: 审计 Session 域所有调用者

**Files:**
- Read-only audit

- [ ] **Step 1: 搜索所有 session.ts service 函数的引用**

Run:
```bash
grep -rn "from.*services/session" src/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts"
grep -rn "updateSessionTitle\|incrementEpoch\|touchSession\|isSessionClosedStatus\|toWebSessionId\|toWebSessionResponse\|listWebSessionsByOwnerUuid\|listSessions\b\|listSessionSummaries\|listSessionsByEnvironment\|resolveExistingWebSessionId\|resolveOwnedWebSessionId\|createCodeSession" src/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts"
```

将输出记录下来，分为：
- **活跃引用**：调用了函数且函数有实际行为
- **废弃引用**：调用了 no-op/空返回函数

- [ ] **Step 2: 搜索 tokenRepo 和 sessionWorkerRepo 的引用**

Run:
```bash
grep -rn "tokenRepo\|sessionWorkerRepo" src/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts" | grep -v "repositories/index.ts" | grep -v "repositories/session-worker.ts" | grep -v "repositories/token.ts"
```

- [ ] **Step 3: 记录审计结果，形成删除清单**

在 plan 文件中记录哪些函数和 repo 方法可以安全删除。不 commit 这一步，只是收集信息指导后续 Task。

---

### Task 2: 删除 session.ts service 中的废弃函数

**Files:**
- Modify: `src/services/session.ts`
- Modify: 所有引用被删函数的文件

- [ ] **Step 1: 逐个删除废弃函数，按依赖顺序**

从审计结果中确认以下函数可以安全删除（基于代码审查，它们都是 no-op 或返回空值）：

```typescript
// 以下函数从 session.ts 中删除：
export async function updateSessionTitle() {}       // no-op
export async function incrementEpoch() { return 0; } // no-op
export async function touchSession() {}              // no-op
export function isSessionClosedStatus() { return false; } // always false
export function toWebSessionId(id) { return id; }    // passthrough
export async function toWebSessionResponse(s) { return s; } // passthrough
export async function listWebSessionsByOwnerUuid() { return []; } // always empty
export async function listSessions() { return []; }  // always empty
export async function listSessionSummaries() { return []; } // always empty
export async function listSessionSummariesByOwnerUuid() { return []; } // always empty
export async function listSessionSummariesByUsername() { return []; } // always empty
export async function listSessionsByEnvironment() { return []; } // always empty
export async function resolveExistingWebSessionId(id) { ... } // delegates to resolveExisting
export async function resolveOwnedWebSessionId(id, _) { ... } // delegates to resolveExisting
export async function createCodeSession(req) { ... }  // delegates to createSession
```

每删一个函数，同步修改所有调用该函数的文件：
- `src/routes/v1/sessions.ts` — 移除 `updateSessionTitle` 调用，改为 no-op inline
- `src/routes/v2/worker.ts` — 移除 `touchSession`、`incrementEpoch` 调用
- `src/routes/v2/worker-events.ts` — 移除 `touchSession` 调用
- `src/routes/v2/code-sessions.ts` — 移除 `createCodeSession`、`incrementEpoch` 调用

具体替换策略：
- `touchSession(id)` → 删除调用（no-op 无效果）
- `incrementEpoch(id)` → 替换为 `0`（始终返回 0）
- `updateSessionTitle(id, title)` → 删除调用（no-op 无效果）
- `createCodeSession(req)` → 替换为 `createSession(req)` 后再 `{ ...session, source: "code" }`
- `resolveExistingWebSessionId` → 替换为 `resolveExistingSessionId`
- `resolveOwnedWebSessionId` → 替换为 `resolveExistingSessionId`

- [ ] **Step 2: 保留的核心函数**

保留以下函数（有实际行为）：
- `updateSessionStatus(sessionId, status)` — 发布 EventBus 事件
- `archiveSession(sessionId)` — 更新状态 + 清理 EventBus
- `getSession(sessionId)` — 检查 EventBus 是否活跃
- `resolveExistingSessionId(sessionId)` — 检查 EventBus 是否活跃
- `createSession(req)` — 创建轻量存根

精简后的 `session.ts` 约为 50 行。

- [ ] **Step 3: 运行类型检查**

Run: `bun run typecheck`
Expected: 编译通过（所有调用者已更新）

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: 删除 Session 域 14 个废弃函数，更新所有调用者"
```

---

### Task 3: 简化 Session Repository — 移除内存 Map

**Files:**
- Modify: `src/repositories/session.ts`

- [ ] **Step 1: 审计 SessionRepo 内存 Map 的活跃消费者**

Run:
```bash
grep -rn "sessionRepo\." src/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts" | grep -v "repositories/session.ts" | grep -v "repositories/index.ts"
```

重点关注哪些方法被外部调用。如果审计发现只有以下方法仍被调用：
- `create()` — 被 `v1/environments.ts` 的 bridge 端点使用
- `listByEnvironment()` — 被 `v1/environments.ts` 使用
- `getById()` — 可能被部分路由使用

- [ ] **Step 2: 将 SessionRepo 改为纯 PG 查询**

将双写模式（内存 Map + PG insert）改为纯 PG 查询。核心改动：

```typescript
// 修改前: 内存 Map + PG 双写
async getById(id: string): Promise<SessionRecord | undefined> {
  return this.sessions.get(id);
}

// 修改后: 纯 PG 查询
async getById(id: string): Promise<SessionRecord | undefined> {
  const rows = await db.select().from(agentSession).where(eq(agentSession.id, id)).limit(1);
  return rows[0] ? this.rowToRecord(rows[0]) : undefined;
}
```

对所有方法做类似转换：
- `create()` — 只做 PG insert，删除 `this.sessions.set()`
- `update()` — 只做 PG update，删除 `Object.assign(rec, ...)`
- `delete()` — 只做 PG delete，删除 `this.sessions.delete()`
- `listAll/listByEnvironment/listByUserId` — 改为 PG WHERE 查询
- `loadFromDB()` — 删除（不再需要从 PG 加载到内存）
- `reset()` — 删除或改为 no-op

对于 `sessionOwners` Map（用于 `bindOwner`/`isOwner`），如果审计发现只有 `web/auth.ts` 的 bind 端点使用且功能可被 better-auth 替代，也一并清理。

- [ ] **Step 3: 运行类型检查和测试**

Run: `bun run typecheck && bun test src/__tests__/`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/repositories/session.ts
git commit -m "refactor: Session Repository 移除内存 Map，改为纯 PG 查询"
```

---

### Task 4: 清理 tokenRepo 和 sessionWorkerRepo

**Files:**
- Modify: `src/repositories/token.ts`
- Modify: `src/repositories/session-worker.ts`
- Modify: `src/repositories/index.ts`

- [ ] **Step 1: 根据 Task 1 审计结果决定行动**

**如果 tokenRepo 无活跃调用者：**
- 从 `src/repositories/index.ts` 中删除 `tokenRepo` 导出和 import
- 从 `resetAllRepos()` 中删除 `tokenRepo.reset()`
- 删除 `src/repositories/token.ts` 文件

**如果 sessionWorkerRepo 仍有活跃调用者（v2/worker.ts 等）：**
- 保留但添加注释说明这是 v2 legacy 兼容
- 考虑后续 v2 路由废弃时一并删除

- [ ] **Step 2: 执行清理**

```bash
# 如果 tokenRepo 无调用者
rm src/repositories/token.ts
```

更新 `src/repositories/index.ts`：
```typescript
// 删除以下行:
// export { tokenRepo } from "./token";
// export type { TokenRecord, ITokenRepo } from "./token";
// import { tokenRepo } from "./token";
// resetAllRepos 中的 tokenRepo.reset();
```

- [ ] **Step 3: 运行类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: 清理 tokenRepo 和废弃 Repository 导出"
```

---

### Task 5: 清理 config.ts 空壳

**Files:**
- Delete: `src/services/config.ts`

- [ ] **Step 1: 确认 config.ts 无活跃调用者**

Run:
```bash
grep -rn "from.*services/config\"" src/ --include="*.ts" | grep -v node_modules
```

如果结果为空（或只有 `config.ts` 本身），安全删除。

- [ ] **Step 2: 删除文件**

```bash
rm src/services/config.ts
```

- [ ] **Step 3: 运行类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: 删除已废弃的 config.ts 空壳"
```

---

## Self-Review

**Spec coverage:** 覆盖了 Session 域的 4 个文件（session service、session repo、token repo、session-worker repo）和 1 个空壳文件（config.ts）。

**Placeholder scan:** Task 1 的审计步骤需要实际运行 grep 命令获取结果后才能确定 Task 3-4 的具体操作，但每个 Task 都给出了明确的决策分支和操作步骤。

**Type consistency:** Session repo 的 `ISessionRepo` 接口签名不变（只是实现从内存改为 PG），调用者无需修改。
