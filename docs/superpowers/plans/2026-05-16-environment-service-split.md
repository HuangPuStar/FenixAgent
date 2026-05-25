# Environment Service 重组：确认三文件拆分的合理性

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 评估 `environment-core.ts`、`environment-acp.ts`、`environment-web.ts` 三文件拆分是否合理。如果是浅层拆分（交叉调用多、共享状态多），则合并为深层模块。如果是按关注点有意义地隔离，则保持现状并记录决策。

**Architecture:** 分析三文件的依赖关系和调用图，做出保留/合并决策。本计划分两个阶段：Phase 1 是分析（只读），Phase 2 是执行（基于 Phase 1 结论）。

**Tech Stack:** TypeScript, Bun test

---

## Phase 1: 分析（只读）

### Task 1: 绘制三文件依赖和调用图

**Files:**
- Read: `src/services/environment-core.ts`
- Read: `src/services/environment-acp.ts`
- Read: `src/services/environment-web.ts`

- [ ] **Step 1: 分析 environment-core.ts 的导出和依赖**

已读取的内容分析：

**导出（被其他文件使用的）：**
- `validateWorkspacePath` — 被 environment-web.ts 使用
- `ensureWorkspaceDir` — 被 environment-web.ts 使用
- `KEBAB_CASE_RE` — 被 environment-web.ts 使用
- `generateEnvSecret` — 被 environment-web.ts 使用
- `sanitizeResponse` — 被 environment-web.ts 使用
- `getOwnedEnvironment` — 被 environment-web.ts 使用
- `deleteEnvironment` — 被 environment-acp.ts、environment-web.ts 使用
- `toResponse` — 被 environment-acp.ts 使用
- `CreateWebEnvironmentParams` 类型 — 被 environment-web.ts 使用
- `UpdateWebEnvironmentParams` 类型 — 被 environment-web.ts 使用

**依赖：**
- `environmentRepo` — 直接 import
- `NotFoundError` — 从 errors 导入

**自身函数间调用：**
- 无交叉调用（纯工具函数 + 纯 repo 封装）

**结论：** core 是纯工具 + repo 封装层，零业务逻辑。被 acp 和 web 双向依赖。

- [ ] **Step 2: 分析 environment-acp.ts 的导出和依赖**

**导出（被调用方）：**
- `getEnvironmentBySecret` — 被 auth 插件使用
- `registerEnvironment` — 被 transport/ws-handler 使用
- `deregisterEnvironment` — 被 transport/ws-handler 使用
- `getEnvironment` — 被 transport/acp-ws-handler 使用
- `updatePollTime` — 被 transport 层使用
- `listActiveEnvironments` / `listActiveEnvironmentsResponse` — 被 v1 路由使用
- `listActiveEnvironmentsByUsername` — 被 v1 路由使用
- `reconnectEnvironment` — 被 v1 路由使用
- `markEnvironmentActive` / `markEnvironmentIdle` / `touchEnvironmentPoll` — 被 transport 使用
- `updateEnvironmentCapabilities` — 被 transport 使用
- `createTemporaryEnvironment` — 被 ACP handler 使用
- `registerBridge` / `reconnectBridge` / `deregisterBridge` — 被 v1 路由使用
- `handleAcpConnect` / `handleAcpRegister` / `handleAcpIdentify` / `handleAcpDisconnect` — 被 transport 使用

**依赖：**
- `environmentRepo`, `sessionRepo` — 直接 import
- `toResponse`, `deleteEnvironment` — 从 environment-core 导入
- `findOrCreateForEnvironment` — 从 session service 导入
- `NotFoundError` — 从 errors 导入

**自身函数间调用：**
- `registerBridge` → `environmentRepo` + `sessionRepo` + `findOrCreateForEnvironment`
- `handleAcpRegister` → `markEnvironmentActive` + `updateEnvironmentCapabilities` + `createTemporaryEnvironment`
- `handleAcpIdentify` → `markEnvironmentActive` + `getEnvironment`
- `handleAcpDisconnect` → `markEnvironmentIdle` + `deleteEnvironment`

**调用者分布：** 主要是 transport 层和 v1 路由（ACP/bridge 协议相关）

- [ ] **Step 3: 分析 environment-web.ts 的导出和依赖**

**导出（被调用方）：**
- `createWebEnvironment` — 被 web/environments 路由使用
- `updateWebEnvironment` — 被 web/environments 路由使用
- `listEnvironmentsWithInstances` — 被 web/environments 路由使用

**依赖：**
- `environmentRepo` — 直接 import
- `configPg.getAgentConfigById` — 跨域依赖（config service）
- `listInstancesByEnvironment` — 从 instance service 导入
- 从 environment-core 导入 6 个函数/类型

**调用者分布：** 仅 web/environments 路由

- [ ] **Step 4: 绘制调用图并评估**

```
                    environment-core.ts
                   / (工具 + repo 封装)    \
                  /                         \
  environment-acp.ts                    environment-web.ts
  (ACP/bridge 协议)                     (Web 控制面板)
  调用者: transport, v1 routes            调用者: web routes
  依赖: sessionRepo, session service      依赖: configPg, instance service
```

**评估结论：**

| 维度 | 结果 |
|------|------|
| 关注点隔离 | ✅ ACP 协议 vs Web 控制面板 vs 核心工具，三个关注点清晰分离 |
| 交叉调用 | ⚠️ acp 和 web 都依赖 core，但互不依赖 |
| 共享状态 | ✅ 无共享可变状态 |
| 调用者重叠 | ✅ acp 的调用者（transport, v1）和 web 的调用者（web routes）完全不重叠 |
| 文件深度 | ⚠️ core.ts 只有 110 行，偏浅；但 acp.ts 325 行有足够深度 |
| 修改局部性 | ✅ ACP 协议变更只改 acp.ts，Web UI 变更只改 web.ts |

**结论：三文件拆分合理，保持现状。**

理由：
1. 两个消费群（transport/v1 vs web routes）完全不同
2. acp 和 web 互不依赖，core 是共享基础层
3. 合并成单文件会导致 500+ 行的单体，且修改局部性下降

---

## Phase 2: 执行（基于分析结论）

### Task 2: 记录决策到 ADR 和 CONTEXT.md

**Files:**
- Create: `docs/adr/0007-environment-service-tri-file-split.md`

- [ ] **Step 1: 创建 ADR 记录 Environment 三文件拆分决策**

创建 `docs/adr/0007-environment-service-tri-file-split.md`：

```markdown
# Environment Service 三文件拆分

Environment service 按关注点拆分为三个文件：`environment-core.ts`（共享工具和 repo 封装）、`environment-acp.ts`（ACP 协议和 bridge 注册生命周期）、`environment-web.ts`（Web 控制面板 CRUD）。三个文件互不直接调用（acp 和 web 只依赖 core），调用者群（transport/v1 vs web routes）完全不重叠。

拆分经过深度分析确认：ACP 协议变更只影响 acp.ts，Web UI 变更只影响 web.ts，共享逻辑（路径校验、响应格式化）集中在 core.ts。合并为单文件会导致 500+ 行且修改局部性下降。

Status: accepted
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0007-environment-service-tri-file-split.md
git commit -m "docs: 记录 Environment service 三文件拆分决策 (ADR-0007)

分析确认 environment-core/acp/web 按关注点隔离合理：
- acp 和 web 互不依赖，core 是共享基础层
- 调用者群完全不重叠（transport/v1 vs web routes）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```
