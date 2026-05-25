# Session 空壳清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收窄 sessionRepo 和 session.ts 的接口到实际使用的子集，移除 Agent 进程已接管的废弃方法。

**Architecture:** Session 管理已下沉到 acp-link（ADR 在 `docs/arch/plans/plan-03-session-delegate-to-agent.md`）。RCS 侧仅保留：EventBus 事件推送、Bridge 注册时的 `findOrCreateForEnvironment`、owner 绑定。`sessionRepo` 从 15 个方法收窄到 ~6 个。

**Tech Stack:** TypeScript, Drizzle ORM (已移除), 纯内存 Map

---

### Task 1: 收窄 sessionRepo 接口

**Files:**
- Modify: `src/repositories/session.ts`

- [ ] **Step 1: 从 ISessionRepo 接口和 SessionRecord 类型中移除废弃方法**

移除以下字段和方法：
- `SessionRecord.permissionMode` — Agent 管理
- `SessionRecord.workerEpoch` — Agent 管理
- `SessionRecord.shareMode` — Agent 管理
- `SessionRecord.cwd` — Agent 管理
- `ISessionRepo.update` 中的 `permissionMode`、`workerEpoch`、`shareMode` patch 字段
- `ISessionRepo.listForAgentByCwd` — 无调用方（grep 确认只有定义，无调用）
- `ISessionRepo.listByOwnerUuid` — grep 确认无调用方
- `ISessionRepo.listByUsername` — grep 确认无调用方
- `ISessionRepo.dissociateFromEnvironment` — grep 确认无调用方
- `ISessionRepo.isOwner` — grep 确认无调用方
- `ISessionRepo.getOwners` — grep 确认无调用方
- `ISessionRepo.setShareMode` — grep 确认无调用方

保留：
- `create`, `getById`, `update`（仅 title/status）, `delete`
- `listAll`, `listByEnvironment`, `listByUserId`
- `bindOwner`
- `reset`

- [ ] **Step 2: 从 SessionRepo 实现中移除对应方法**

删除已移除接口方法的实现代码。`update` 方法仅保留 `title`、`status` 字段。`create` 方法移除 `permissionMode`、`workerEpoch`、`cwd`、`shareMode` 字段赋值。

- [ ] **Step 3: 运行 typecheck 确认无引用断裂**

Run: `bunx tsc --noEmit`
Expected: 可能有调用方编译错误，在 Task 2 中修复

- [ ] **Step 4: Commit**

```bash
git add src/repositories/session.ts
git commit -m "refactor: 收窄 sessionRepo 接口，移除 Agent 侧管理的废弃方法"
```

### Task 2: 清理 session.ts 空壳函数

**Files:**
- Modify: `src/services/session.ts`

- [ ] **Step 1: 简化 `getSession` 和 `resolveExistingSessionId`**

`getSession()` 当前返回硬编码的 `LightweightSession`，仅用于检查 EventBus 是否活跃。简化为返回 `boolean` 或 `{ active: boolean }`，移除虚假字段。

同时简化 `resolveExistingSessionId()` — 它只是检查 bus 是否存在然后返回 sessionId，可以内联为 `eventService.getAllBuses().has(sessionId)`。

但要注意调用方：grep `getSession` 和 `resolveExistingSessionId` 确认下游使用方式。

- [ ] **Step 2: 移除 `createSession` 函数**

`createSession()` 返回一个不写入 repo 的轻量存根，仅被 `session-ingress.ts` 等使用。grep 确认调用方后决定是否移除或简化。

- [ ] **Step 3: 简化 `LightweightSession` 类型**

如果 `getSession` 仍有调用方需要返回值，将 `LightweightSession` 收窄到仅保留实际使用的字段（`id`、`status`）。

- [ ] **Step 4: 运行 typecheck**

Run: `bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/services/session.ts
git commit -m "refactor: 清理 session.ts 空壳函数，收窄到 EventBus 活跃检查"
```

### Task 3: 更新 sessionRepo 调用方适配接口变更

**Files:**
- Modify: 所有 import sessionRepo 的文件

- [ ] **Step 1: grep 所有 sessionRepo 调用方并逐一修复**

```bash
grep -rn "sessionRepo\." src/ --include="*.ts" | grep -v __tests__ | grep -v "session.ts"
```

对每个调用方：
- 如果调用了已移除的方法，改为内联逻辑或移除调用
- `session-ingress.ts` 如果调用 `getSession`，改为直接检查 eventBus

- [ ] **Step 2: 更新测试文件**

```bash
grep -rn "sessionRepo\." src/__tests__/ 
```

移除或更新引用已删除方法的测试。

- [ ] **Step 3: 运行 typecheck + 测试**

Run: `bunx tsc --noEmit && bun test src/__tests__/`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: 适配 sessionRepo 接口收窄的调用方变更"
```
