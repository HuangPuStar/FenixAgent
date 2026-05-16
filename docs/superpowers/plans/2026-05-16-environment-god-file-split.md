# Environment 上帝文件拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `environment.ts`（530 行，28 个导出函数）按职责拆分为 3 个聚焦的子模块。

**Architecture:** 当前 `environment.ts` 承载了 7 类接口。按调用方角色拆分为：(1) Web 控制面板 CRUD、(2) Bridge/ACP 注册编排、(3) Transport 状态操作。共享类型和工具函数提取到 environment-core。

**Tech Stack:** TypeScript, Elysia

---

### Task 1: 提取共享类型和工具函数到 environment-core

**Files:**
- Create: `src/services/environment-core.ts`
- Modify: `src/services/environment.ts`

- [ ] **Step 1: 创建 `environment-core.ts`，提取以下内容**

从 `environment.ts` 提取：
- `EnvironmentRecord` 类型（已从 repositories 导入，此处仅 re-export 需要的类型）
- `validateWorkspacePath()` (line 19)
- `ensureWorkspaceDir()` (line 33)
- `generateEnvSecret()` (line 41) — 从 `createWebEnvironment` 中提取为独立函数
- `BLOCKED_PATHS` 常量 (line 13-16)
- `KEBAB_CASE_RE` 常量 (line 38)
- `toResponse()` (line 114) — v1 格式响应
- `sanitizeResponse()` (line 180) — web 格式响应
- `getOwnedEnvironment()` (line 201) — 两个子模块都用的所有权校验
- `deleteEnvironment()` (line 171) — 两个子模块都用的删除
- `CreateWebEnvironmentParams` 接口 (line 44)
- `UpdateWebEnvironmentParams` 接口 (line 217)

- [ ] **Step 2: 在 `environment.ts` 中改为从 core 导入**

```typescript
export { validateWorkspacePath, ensureWorkspaceDir, sanitizeResponse, getOwnedEnvironment, deleteEnvironment } from "./environment-core";
export type { CreateWebEnvironmentParams, UpdateWebEnvironmentParams } from "./environment-core";
```

保持所有现有 export 路径不变，避免调用方修改。

- [ ] **Step 3: 运行 typecheck**

Run: `bunx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/services/environment-core.ts src/services/environment.ts
git commit -m "refactor: 提取 environment-core 共享类型和工具函数"
```

### Task 2: 提取 Web 控制面板 CRUD 到 environment-web

**Files:**
- Create: `src/services/environment-web.ts`
- Modify: `src/services/environment.ts`
- Modify: `src/routes/web/environments.ts`

- [ ] **Step 1: 创建 `environment-web.ts`，提取 Web 专用函数**

提取：
- `createWebEnvironment()` (line 54)
- `updateWebEnvironment()` (line 218)
- `listEnvironmentsWithInstances()` (line 424)

这些函数只被 `src/routes/web/environments.ts` 调用。

- [ ] **Step 2: 在 `environment.ts` 中 re-export**

```typescript
export { createWebEnvironment, updateWebEnvironment, listEnvironmentsWithInstances } from "./environment-web";
```

- [ ] **Step 3: 更新 `routes/web/environments.ts` 的 import 路径**

改为从 `../../services/environment-web` 直接导入，不再经过 `environment.ts` 中转。

- [ ] **Step 4: 运行 typecheck**

- [ ] **Step 5: Commit**

```bash
git add src/services/environment-web.ts src/services/environment.ts src/routes/web/environments.ts
git commit -m "refactor: 提取 Web 控制面板 CRUD 到 environment-web"
```

### Task 3: 提取 ACP/Bridge 注册编排到 environment-acp

**Files:**
- Create: `src/services/environment-acp.ts`
- Modify: `src/services/environment.ts`
- Modify: `src/transport/acp-ws-handler.ts`
- Modify: `src/routes/v1/environments.ts`

- [ ] **Step 1: 创建 `environment-acp.ts`，提取 ACP/Bridge 专用函数**

提取：
- `registerEnvironment()` (line 120) — v1 REST 注册
- `registerBridge()` (line 332) — Bridge 编排
- `reconnectBridge()` (line 402)
- `deregisterBridge()` (line 411)
- `handleAcpConnect()` (line 456)
- `handleAcpRegister()` (line 465)
- `handleAcpIdentify()` (line 498)
- `handleAcpDisconnect()` (line 524)
- `createTemporaryEnvironment()` (line 286)
- `markEnvironmentActive()` (line 260)
- `markEnvironmentIdle()` (line 265)
- `touchEnvironmentPoll()` (line 270)
- `updateEnvironmentCapabilities()` (line 275)
- 相关类型：`BridgeRegistrationInput`、`BridgeRegistrationResult`

- [ ] **Step 2: 在 `environment.ts` 中 re-export 保持兼容**

- [ ] **Step 3: 更新调用方的 import 路径**

`acp-ws-handler.ts` 和 `v1/environments.ts` 改为直接从 `environment-acp` 导入。

- [ ] **Step 4: 清理 `environment.ts` 为 re-export barrel**

此时 `environment.ts` 应该只剩下 re-export 和少量遗留函数（`deregisterEnvironment`、`getEnvironment`、`updatePollTime`、`listActiveEnvironments*`、`reconnectEnvironment`）。将这些归入 core 或保留为简短的 barrel 文件。

- [ ] **Step 5: 运行 typecheck + 测试**

Run: `bunx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/services/environment-acp.ts src/services/environment-web.ts src/services/environment-core.ts src/services/environment.ts src/transport/acp-ws-handler.ts src/routes/v1/environments.ts
git commit -m "refactor: 拆分 environment.ts 为 core/web/acp 三个子模块"
```
