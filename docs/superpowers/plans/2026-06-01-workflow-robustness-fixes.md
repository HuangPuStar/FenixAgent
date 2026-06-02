# Workflow 面板健壮性修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 workflow 面板前端状态管理和后端数据一致性问题，消除竞态条件、状态泄漏和异常交互。

**Architecture:** 分三个阶段：第一阶段修复前端轮询/状态竞态（最影响用户体验）；第二阶段修复后端并发安全（最影响数据一致性）；第三阶段补充安全防护（防止被攻破）。

**Tech Stack:** React 19 hooks, Bun test, workflow-engine (TypeScript), PostgreSQL + Drizzle ORM

---

## 审计发现摘要

三个 agent 并行审计发现共 30+ 个问题，按优先级筛选出以下需要立即修复的问题：

| 优先级 | 来源 | 问题 | 影响 |
|--------|------|------|------|
| P0 | 前端 | RerunFrom 后旧轮询未清理 | 状态闪烁、双重更新 |
| P0 | 前端 | workflowId 切换时旧运行状态未清理 | 跨工作流状态混淆 |
| P0 | 后端 | recoverFromApproval 先写事件再抛错 | 数据不一致 |
| P1 | 前端 | 运行按钮缺少防重复点击 | 可能启动多个实例 |
| P1 | 前端 | handleBackToEdit 未清理 dryRunResult | UI 残留 |
| P1 | 后端 | approveNode 并发无保护 | 同一节点被多次审批 |
| P1 | 后端 | spawnedEnvIds 失败时泄漏 | 资源泄漏 |
| P2 | 后端 | runAsync result.then 无错误处理 | workflowId 丢失 |

---

## Task 1: 修复 RerunFrom 后轮询竞态

**问题**：`handleRerunFrom` 更新 `activeRunId` 后，旧 useEffect 轮询的 cleanup 和新 useEffect 轮询的启动之间可能存在间隙，导致两个轮询同时运行。

**Files:**
- Modify: `web/src/pages/workflow/hooks/useWorkflowRun.ts:193-214, 376-441`

- [ ] **Step 1: 在 handleRerunFrom 开头先清理旧轮询**

在 `handleRerunFrom` 的 `if (!activeRunId) return;` 之后，立即清理旧轮询：

```typescript
const handleRerunFrom = useCallback(
  async (fromNodeId: string) => {
    if (!activeRunId) return;
    // 清理旧轮询，避免 setActiveRunId 触发 useEffect 重叠期间双重轮询
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    const y = syncYaml();
    setRunning(true);
    // ... 后续不变
```

- [ ] **Step 2: 验证类型检查通过**

Run: `bunx tsc --noEmit 2>&1 | grep -i "useWorkflowRun" | head -5`
Expected: 无输出（无错误）

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/workflow/hooks/useWorkflowRun.ts
git commit -m "fix(workflow): rerunFrom 前清理旧轮询避免双重轮询竞态"
```

---

## Task 2: 修复 workflowId 切换时状态未清理

**问题**：用户从一个工作流切到另一个时，旧工作流的 `activeRunId`/`runSnapshot`/`runEvents` 等运行状态没有被清理，可能导致新工作流显示旧运行状态。

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx` (找到 workflowId 变化的 useEffect)

- [ ] **Step 1: 找到 WorkflowEditor 中 workflowId 变化的 useEffect**

搜索 `WorkflowEditor.tsx` 中监听 `workflowId` 变化的 useEffect，确认其位置。

Run: `grep -n "workflowId" web/src/pages/workflow/WorkflowEditor.tsx | head -20`

- [ ] **Step 2: 在 workflowId 变化时调用状态清理**

在 workflowId 变化的 useEffect 中，在加载新数据之前先清理旧运行状态。通过调用已有的清理逻辑（参考 `handleBackToEdit` 的模式）：

```typescript
// 在 workflowId 变化的 useEffect 开头添加状态清理
useEffect(() => {
  // 清理上一个工作流的运行状态
  setActiveRunId(null);
  setRunSnapshot(null);
  setRunEvents([]);
  setRunApprovals([]);
  setSelectedRunNodeId(null);
  setSelectedNodeOutput(null);
  setRunning(false);
  setDryRunResult(null);

  // 然后加载新的工作流数据
  if (workflowId) {
    // ... 已有的加载逻辑
  }
}, [workflowId]);
```

注意：具体变量名和依赖数组需根据 WorkflowEditor.tsx 实际代码调整。清理逻辑应复用 `handleBackToEdit` 中已有的模式，但不直接调用它（避免闭包依赖问题）。

- [ ] **Step 3: 验证类型检查通过**

Run: `bunx tsc --noEmit 2>&1 | grep -i "WorkflowEditor" | head -5`
Expected: 无输出

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "fix(workflow): workflowId 切换时清理旧运行状态避免跨工作流状态混淆"
```

---

## Task 3: 修复运行按钮防重复点击

**问题**：`handleRun` 是异步的，`setRunning(true)` 到 API 返回之间有间隙。虽然有 `running` 状态控制按钮 disabled，但 React 状态更新是异步的，快速连点可能穿透。

**Files:**
- Modify: `web/src/pages/workflow/hooks/useWorkflowRun.ts:252-307`

- [ ] **Step 1: 添加 ref 级别的防重复守卫**

在 `useWorkflowRun` hook 中添加 `isSubmittingRef` 防止 async gap 期间的重复提交：

```typescript
// 在 hook 顶部，pollRef 附近添加
const isSubmittingRef = useRef(false);
```

在 `handleRun` 开头加入守卫：

```typescript
const handleRun = useCallback(
  async (params?: Record<string, unknown>) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    // ... 已有逻辑不变 ...
    try {
      // ... 已有的 try 块不变
    } catch (err) {
      // ... 已有的 catch 块不变
    } finally {
      setRunning(false);
      isSubmittingRef.current = false;
    }
  },
  [/* deps 不变 */],
);
```

- [ ] **Step 2: 对 handleRerunFrom 也添加相同守卫**

在 `handleRerunFrom` 开头同样添加 `isSubmittingRef` 守卫：

```typescript
const handleRerunFrom = useCallback(
  async (fromNodeId: string) => {
    if (!activeRunId || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    // 清理旧轮询
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    // ... 已有逻辑不变 ...
    try {
      // ... 不变
    } catch (err) {
      // ... 不变
    } finally {
      setRunning(false);
      isSubmittingRef.current = false;
    }
  },
  [/* deps 不变 */],
);
```

- [ ] **Step 3: 验证类型检查通过**

Run: `bunx tsc --noEmit 2>&1 | grep -i "useWorkflowRun" | head -5`
Expected: 无输出

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/workflow/hooks/useWorkflowRun.ts
git commit -m "fix(workflow): 添加 isSubmittingRef 防止运行/rerun 重复提交"
```

---

## Task 4: 修复 handleBackToEdit 未清理 dryRunResult

**问题**：`handleBackToEdit` 清理了运行相关状态，但遗漏了 `dryRunResult`。切回编辑模式后可能显示过时的验证结果。

**Files:**
- Modify: `web/src/pages/workflow/hooks/useWorkflowRun.ts:336-354`

- [ ] **Step 1: 在 handleBackToEdit 和 handleBackToList 中添加 dryRunResult 清理**

```typescript
const handleBackToEdit = useCallback(() => {
  if (pollRef.current) clearTimeout(pollRef.current);
  setRunning(false);
  setActiveRunId(null);
  setRunSnapshot(null);
  setRunEvents([]);
  setRunApprovals([]);
  setSelectedRunNodeId(null);
  setSelectedNodeOutput(null);
  setDryRunResult(null); // 新增：清理 dryRun 结果
  setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, _runStatus: undefined, _exitCode: undefined } })));
}, [
  // deps 中添加 setDryRunResult
  setActiveRunId,
  setRunSnapshot,
  setRunEvents,
  setRunApprovals,
  setSelectedRunNodeId,
  setSelectedNodeOutput,
  setDryRunResult,
  setNodes,
]);
```

对 `handleBackToList` 做同样修改（添加 `setDryRunResult(null)` 和依赖）。

- [ ] **Step 2: 验证类型检查通过**

Run: `bunx tsc --noEmit 2>&1 | grep -i "useWorkflowRun" | head -5`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/workflow/hooks/useWorkflowRun.ts
git commit -m "fix(workflow): 返回编辑/列表时清理 dryRunResult 避免残留"
```

---

## Task 5: 修复后端 recoverFromApproval 数据不一致

**问题**：`recoverFromApproval` 先写入 `audit.approved` 事件，然后直接抛错。导致数据库中有审批事件但运行状态未更新，前端可能看到错误的待审批状态。

**Files:**
- Modify: `packages/workflow-engine/src/engine/workflow-engine.ts:404-448`

- [ ] **Step 1: 移除 recoverFromApproval 中的事件写入**

事件写入应该在恢复成功后由调度器处理，不应该在抛错前写入：

```typescript
/** 非活跃运行的审批恢复 */
async function recoverFromApproval(runId: string, nodeId: string, data?: unknown): Promise<void> {
  const snapshot = await storage.getLatestSnapshot(runId);
  if (!snapshot) {
    throw new WorkflowError(`No snapshot found for run ${runId}`, WorkflowErrorCode.RECOVERY_ERROR, { runId });
  }

  // 不再在抛错前写事件，直接提示使用 recover()
  throw new WorkflowError(
    `Run '${runId}' is not active. Use recover() to resume from snapshot with the workflow YAML.`,
    WorkflowErrorCode.RECOVERY_ERROR,
    { runId, nodeId },
  );
}
```

- [ ] **Step 2: 在 approveNode 中拦截非活跃运行时自动恢复**

改进 `approveNode` 对非活跃运行的处理——当 `activeRuns` 中找不到时，尝试自动恢复而不是直接抛错：

```typescript
// 在 approveNode 的 "2. 查找活跃运行" 部分
const activeRun = activeRuns.get(runId);
if (!activeRun) {
  // 非活跃运行：检查快照中该节点是否处于 SUSPENDED 状态
  const snapshot = await storage.getLatestSnapshot(runId);
  if (!snapshot) {
    throw new WorkflowError(`No snapshot found for run ${runId}`, WorkflowErrorCode.RECOVERY_ERROR, { runId });
  }
  const nodeState = snapshot.node_states[nodeId];
  if (nodeState?.status !== ("SUSPENDED" as import("../types/execution").NodeStatus)) {
    throw new WorkflowError(
      `Node '${nodeId}' is not in SUSPENDED state (current: ${nodeState?.status ?? "unknown"})`,
      WorkflowErrorCode.VALIDATION_ERROR,
      { runId, nodeId },
    );
  }
  // 仍然需要 YAML 才能恢复，抛出明确的错误
  throw new WorkflowError(
    `Run '${runId}' is not active (server may have restarted). Use recover() with the workflow YAML to resume.`,
    WorkflowErrorCode.RECOVERY_ERROR,
    { runId, nodeId, hint: "use_recover" },
  );
}
```

- [ ] **Step 3: 验证类型检查通过**

Run: `bunx tsc --noEmit 2>&1 | grep -i "workflow-engine" | head -5`
Expected: 无输出

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-engine/src/engine/workflow-engine.ts
git commit -m "fix(workflow): 移除 recoverFromApproval 中提前写入事件避免数据不一致"
```

---

## Task 6: 修复 spawnedEnvIds 失败时资源泄漏

**问题**：`runAsync` 的 `result.then` 回调中，环境清理只在成功分支执行。如果运行失败或异常，`spawnedEnvIds` 中的环境实例不会被清理。

**Files:**
- Modify: `src/routes/web/workflow-engine.ts:43-77`

- [ ] **Step 1: 将环境清理移到 finally 块**

```typescript
result.then(
  async (r) => {
    try {
      if (workflowId) {
        await db
          .update(workflowSnapshot)
          .set({ workflowId })
          .where(
            and(
              eq(workflowSnapshot.runId, runId),
              eq(workflowSnapshot.organizationId, authCtx.organizationId),
            ),
          );
        publishWorkflowEvent(workflowId, "workflow.run_status_changed", {
          runId,
          dagStatus: r.status,
        });
      }
    } finally {
      // 无论 DB 写入成功与否，都清理环境实例
      if (r.spawnedEnvIds && r.spawnedEnvIds.length > 0) {
        await cleanupSpawnedEnvironments(new Set(r.spawnedEnvIds), authCtx.organizationId);
      }
    }
  },
  async (err) => {
    console.error("[workflow-engine] run background error:", err);
    if (workflowId) {
      publishWorkflowEvent(workflowId, "workflow.run_status_changed", {
        runId,
        dagStatus: "ERROR",
      });
    }
    // 错误时也需要清理可能已启动的环境
    // 注意：rejected 时无法获取 spawnedEnvIds，但调度器已处理的节点
    // 其 spawnedEnvIds 已在 scheduler context 中收集
    // 此处无法清理——需在引擎层确保 stopAllInstances
  },
);
```

- [ ] **Step 2: 在引擎层 runAsync 的 catch/finally 中确保 spawnedEnvIds 可访问**

在 `packages/workflow-engine/src/engine/workflow-engine.ts` 的 `runAsync` 中，确保 `spawnedEnvIds` 在错误路径也能被收集。当前实现中 `spawnedEnvIds` 通过 `context.spawnedEnvIds` 引用传递给执行器，即使运行失败也应该包含已启动的 ID。验证 DAGRunResult 的 catch 路径是否也能返回 spawnedEnvIds：

```typescript
} catch (err) {
  console.error(`[workflow-engine] runAsync ${runId} failed:`, err);
  throw err;
} finally {
  if (result?.status !== "SUSPENDED") {
    activeRuns.delete(runId);
  }
}
```

如果 `throw err` 导致 `spawnedEnvIds` 丢失，需要在 catch 中构造一个包含 spawnedEnvIds 的错误对象重新抛出。

- [ ] **Step 3: 验证类型检查通过**

Run: `bunx tsc --noEmit 2>&1 | head -10`
Expected: 无输出

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/workflow-engine.ts packages/workflow-engine/src/engine/workflow-engine.ts
git commit -m "fix(workflow): 确保 spawnedEnvIds 在运行失败时也能被清理"
```

---

## Task 7: approveNode 并发保护

**问题**：多个用户同时审批同一节点时，`approveNode` 没有并发保护，可能导致节点被多次审批、工作流重复执行。

**Files:**
- Modify: `packages/workflow-engine/src/engine/workflow-engine.ts:318-401`

- [ ] **Step 1: 添加内存级并发锁**

在引擎级别添加简单的内存锁（对于单进程场景足够）：

```typescript
// 在 createWorkflowEngine 函数内部，activeRuns 附近添加
const approvalLocks = new Set<string>(); // "runId:nodeId" 格式

// 辅助函数
function lockKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}
```

在 `approveNode` 开头加入锁检查：

```typescript
async function approveNode(runId: string, nodeId: string, token: string, data?: unknown): Promise<void> {
  // 并发保护：同一节点同时只允许一个审批
  const key = lockKey(runId, nodeId);
  if (approvalLocks.has(key)) {
    throw new WorkflowError("Approval already in progress", WorkflowErrorCode.VALIDATION_ERROR, { runId, nodeId });
  }
  approvalLocks.add(key);

  try {
    // ... 已有的审批逻辑不变（从 token 验证开始到调度器执行）
  } finally {
    approvalLocks.delete(key);
  }
}
```

- [ ] **Step 2: 验证类型检查通过**

Run: `bunx tsc --noEmit 2>&1 | grep -i "workflow-engine" | head -5`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/engine/workflow-engine.ts
git commit -m "fix(workflow): 添加 approveNode 内存锁防止并发审批"
```

---

## Task 8: runAsync result.then 添加错误处理

**问题**：`runAsync` 的 `result.then` 回调中，DB 写入和 SSE 事件发送没有错误处理。失败时静默忽略。

**Files:**
- Modify: `src/routes/web/workflow-engine.ts:43-77`

- [ ] **Step 1: 给 result.then 的两个回调都加 try-catch**

```typescript
result.then(
  async (r) => {
    try {
      if (workflowId) {
        await db
          .update(workflowSnapshot)
          .set({ workflowId })
          .where(
            and(
              eq(workflowSnapshot.runId, runId),
              eq(workflowSnapshot.organizationId, authCtx.organizationId),
            ),
          );
        publishWorkflowEvent(workflowId, "workflow.run_status_changed", {
          runId,
          dagStatus: r.status,
        });
      }
    } catch (err) {
      console.error("[workflow-engine] post-run DB write or SSE publish failed:", err);
    } finally {
      if (r.spawnedEnvIds && r.spawnedEnvIds.length > 0) {
        await cleanupSpawnedEnvironments(new Set(r.spawnedEnvIds), authCtx.organizationId);
      }
    }
  },
  async (err) => {
    console.error("[workflow-engine] run background error:", err);
    try {
      if (workflowId) {
        publishWorkflowEvent(workflowId, "workflow.run_status_changed", {
          runId,
          dagStatus: "ERROR",
        });
      }
    } catch (sseErr) {
      console.error("[workflow-engine] failed to publish error SSE event:", sseErr);
    }
  },
);
```

- [ ] **Step 2: 验证类型检查通过**

Run: `bunx tsc --noEmit 2>&1 | grep -i "workflow-engine" | head -5`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add src/routes/web/workflow-engine.ts
git commit -m "fix(workflow): runAsync 后台回调添加 try-catch 避免 DB/SSE 失败静默吞没"
```

---

## 自查清单

### Spec 覆盖率

| 审计发现 | 对应 Task |
|---------|-----------|
| 前端 P0: RerunFrom 轮询竞态 | Task 1 |
| 前端 P0: workflowId 切换状态泄漏 | Task 2 |
| 前端 P1: 运行按钮防重复 | Task 3 |
| 前端 P1: dryRunResult 未清理 | Task 4 |
| 后端 P0: recoverFromApproval 数据不一致 | Task 5 |
| 后端 P1: spawnedEnvIds 泄漏 | Task 6 |
| 后端 P1: approveNode 并发 | Task 7 |
| 后端 P2: result.then 无错误处理 | Task 8 |

---

## 安全审计追加 Task（安全 agent 发现 15 个漏洞）

安全审计发现 2 个严重、5 个高、6 个中、2 个低级别漏洞。以下是最紧急的 3 个修复 task。

### 漏洞全景

| # | 严重程度 | 类型 | 问题 |
|---|---------|------|------|
| 1 | **严重** | RCE | Shell 节点 command + env 未清理，可注入 |
| 2 | **严重** | RCE | Python 节点无沙箱，可执行任意代码 |
| 3 | 高 | 路径遍历 | cwd 参数可指向任意目录 |
| 4 | 高 | SSRF | API 节点 URL 无白名单，可访问内网/云元数据 |
| 5 | **高** | 权限绕过 | rerunFrom 未验证 prevRunId 组织归属 |
| 6 | **高** | 权限绕过 | recover 未验证 runId 组织归属 |
| 7 | 中 | DoS | 无节点数量上限 |
| 8 | 中 | DoS | max_iterations 无上限 |
| 9 | 中 | 逻辑漏洞 | 审批 token 可重放 |
| 10 | 中 | 信息泄露 | secrets 在事件中未完全脱敏 |
| 11 | 中 | DoS | 子工作流递归深度无限制 |
| 12 | 中 | DoS | YAML 大小无限制 |
| 13 | 低 | 注入 | 表达式复杂度边界 |
| 14 | 低 | DoS | SSE 连接无速率限制 |
| 15 | 中 | 注入 | env 字段可覆盖 PATH/LD_PRELOAD |

---

## Task 9: rerunFrom/recover 添加组织归属验证

**问题**：`rerunFrom` 和 `recover` 操作不验证目标 runId 是否属于当前组织，攻击者可跨组织访问数据。

**Files:**
- Modify: `src/routes/web/workflow-engine.ts:173-204` (rerunFrom action)
- Modify: `src/routes/web/workflow-engine.ts:165-169` (recover action)

- [ ] **Step 1: 在 rerunFrom action 中验证 prevRunId 组织归属**

```typescript
case "rerunFrom": {
  const prevRunId = payload.runId as string;
  const fromNodeId = payload.fromNodeId as string;
  const yaml = payload.yaml as string;
  const workflowId = payload.workflowId as string | undefined;

  // 验证 prevRunId 归属当前组织
  const storage = createPgStorageAdapter(authCtx.organizationId);
  const prevSnapshot = await storage.getLatestSnapshot(prevRunId);
  if (!prevSnapshot) {
    return error(404, { error: { type: "NOT_FOUND", message: `Run '${prevRunId}' not found` } });
  }

  if (workflowId) {
    publishWorkflowEvent(workflowId, "workflow.run_started", { runId: undefined });
  }
  const result = await engine.rerunFrom(prevRunId, yaml, fromNodeId);
  // ... 后续不变
```

- [ ] **Step 2: 在 recover action 中同样验证 runId 组织归属**

```typescript
case "recover": {
  const runId = payload.runId as string;
  const yaml = payload.yaml as string;

  // 验证 runId 归属当前组织
  const storage = createPgStorageAdapter(authCtx.organizationId);
  const snapshot = await storage.getLatestSnapshot(runId);
  if (!snapshot) {
    return error(404, { error: { type: "NOT_FOUND", message: `Run '${runId}' not found` } });
  }

  const result = await engine.recover(runId, yaml);
  return { success: true, data: result };
}
```

- [ ] **Step 3: 验证类型检查通过**

Run: `bunx tsc --noEmit 2>&1 | grep -i "workflow-engine" | head -5`
Expected: 无输出

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/workflow-engine.ts
git commit -m "fix(workflow): rerunFrom/recover 验证 runId 组织归属防止跨组织数据访问"
```

---

## Task 10: 添加 YAML/节点/迭代次数限制

**问题**：YAML 大小、节点数量、循环迭代次数均无上限，可被利用做 DoS 攻击。

**Files:**
- Modify: `packages/workflow-engine/src/parser/yaml-parser.ts`

- [ ] **Step 1: 在 yaml-parser.ts 中添加资源限制常量**

在文件顶部（import 之后）添加：

```typescript
/** 单个工作流最大节点数 */
const MAX_NODES = 100;
/** YAML 字符串最大长度（1MB） */
const MAX_YAML_SIZE = 1024 * 1024;
```

- [ ] **Step 2: 在解析函数入口添加 YAML 大小检查**

在 `parseWorkflowYaml` 函数的开头添加：

```typescript
if (yaml.length > MAX_YAML_SIZE) {
  throw new WorkflowError(
    `YAML exceeds maximum size (${MAX_YAML_SIZE} bytes). Got ${yaml.length} bytes.`,
    WorkflowErrorCode.VALIDATION_ERROR,
  );
}
```

- [ ] **Step 3: 在节点解析后添加数量检查**

在节点数组解析完成后（`nodes` 数组构建完毕后）添加：

```typescript
if (nodes.length > MAX_NODES) {
  throw new WorkflowError(
    `Workflow exceeds maximum node count (${MAX_NODES}). Got ${nodes.length} nodes.`,
    WorkflowErrorCode.VALIDATION_ERROR,
    { nodeCount: nodes.length, maxNodes: MAX_NODES },
  );
}
```

- [ ] **Step 4: 限制 max_iterations 上限**

在 loop 节点的 max_iterations 验证处添加上限检查：

```typescript
// 在已有的 max_iterations 验证之后
if (n.max_iterations > 1000) {
  throw new WorkflowError(
    `nodes[${index}] (${n.id}): loop max_iterations exceeds limit (max: 1000, got: ${n.max_iterations})`,
    WorkflowErrorCode.VALIDATION_ERROR,
  );
}
```

- [ ] **Step 5: 验证类型检查通过**

Run: `bunx tsc --noEmit 2>&1 | grep -i "yaml-parser" | head -5`
Expected: 无输出

- [ ] **Step 6: Commit**

```bash
git add packages/workflow-engine/src/parser/yaml-parser.ts
git commit -m "fix(workflow): 添加 YAML 大小、节点数量、迭代次数上限防止 DoS"
```

---

## Task 11: 环境变量键名黑名单 + cwd 路径限制

**问题**：Shell/Python 节点的 env 字段可覆盖 PATH、LD_PRELOAD 等敏感环境变量；cwd 参数可指向任意路径。

**Files:**
- Modify: `packages/workflow-engine/src/executor/process-executor.ts`
- Modify: `packages/workflow-engine/src/executor/python-executor.ts`

- [ ] **Step 1: 在 process-executor.ts 中添加环境变量黑名单和 cwd 验证**

在文件顶部添加辅助函数：

```typescript
/** 禁止覆盖的敏感环境变量前缀 */
const BLOCKED_ENV_PREFIXES = ["LD_", "DYLD_", "PATH", "SHELL", "HOME", "USER", "NODE_OPTIONS"];

/** 清理 env 对象，移除危险键 */
function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    const blocked = BLOCKED_ENV_PREFIXES.some((prefix) => upper === prefix || upper.startsWith(prefix + "_"));
    if (!blocked) {
      safe[key] = value;
    }
  }
  return safe;
}
```

在构建子进程 env 的地方（合并 process.env 和 node.env 的位置），对 `node.env` 调用 `sanitizeEnv`：

```typescript
// 找到类似 const mergedEnv = { ...process.env, ...nodeEnv } 的位置
// 改为：
const mergedEnv = { ...process.env, ...sanitizeEnv(nodeEnv) };
```

- [ ] **Step 2: 验证 cwd 路径是否在允许范围内**

在 process-executor 和 python-executor 中，cwd 参数如果指定了，验证它不包含 `..` 且不以 `/` 开头（相对路径限制在 workspace 内）：

```typescript
if (resolved.cwd) {
  const normalized = path.resolve(resolved.cwd);
  // cwd 必须是相对路径（相对于 workspace），禁止绝对路径和路径穿越
  if (path.isAbsolute(resolved.cwd) || resolved.cwd.includes("..")) {
    throw new WorkflowError(
      `Invalid cwd '${resolved.cwd}': must be a relative path without '..'`,
      WorkflowErrorCode.VALIDATION_ERROR,
    );
  }
}
```

- [ ] **Step 3: 对 python-executor.ts 做同样的 env 清理**

在 python-executor.ts 的 env 构建处应用相同的 `sanitizeEnv` 调用。

- [ ] **Step 4: 验证类型检查通过**

Run: `bunx tsc --noEmit 2>&1 | grep -i "executor" | head -5`
Expected: 无输出

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/executor/process-executor.ts packages/workflow-engine/src/executor/python-executor.ts
git commit -m "fix(workflow): 环境变量黑名单 + cwd 路径限制防止注入和穿越"
```

---

### 未覆盖的延迟项（需要独立计划）

- 后端: `saveSnapshotAfterNode` 改为事务写入（需要改 StorageAdapter 接口，影响面大）
- 后端: activeRuns 持久化（需要 PG 表 + 启动时恢复逻辑）
- 后端: rerunFrom 父子关联（需要新增 parentRunId 字段）
- 前端: SSE 断连重连机制（需要改 workflow-sse.ts + 后端 EventBus 持久化）
- 安全: Shell/Python executor 完整沙箱隔离（需要 Docker 容器化执行，独立安全加固计划）
- 安全: API 节点 SSRF 防护（需要 URL 白名单/内网 IP 过滤）
- 安全: 审批 token 一次性使用（需要 token 状态追踪）
- 安全: secrets 脱敏审计（需要梳理所有事件发射点）
- 安全: 子工作流递归深度限制（需要在 SubWorkflowExecutor 中加深度计数器）
- 安全: SSE 连接速率限制（需要在路由层添加）
