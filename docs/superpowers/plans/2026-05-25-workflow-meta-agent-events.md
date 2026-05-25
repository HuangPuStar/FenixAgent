# Workflow Meta Agent Events 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Workflow 编辑器实现运行时事件上下文传递，将报错和运行状态摘要通过 context queue 传递给 meta agent。

**Architecture:** 独立 hook `useWorkflowEvents` 维护错误列表和状态摘要，每次调用 push 函数时立即更新 context queue。WorkflowEditor 在 6 个事件处理点调用 push 函数。

**Tech Stack:** TypeScript, React 19 (hooks), context-queue 模块, DAGSnapshot 类型

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `web/src/lib/use-workflow-events.ts` | 新建 | hook + buildRunSummary 辅助函数 |
| `web/src/__tests__/use-workflow-events.test.ts` | 新建 | buildRunSummary + push 逻辑单元测试 |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 修改 | 调用 hook，6 个事件处理点插入调用 |

---

### Task 1: buildRunSummary 辅助函数 + 测试

**Files:**
- Create: `web/src/lib/use-workflow-events.ts`
- Create: `web/src/__tests__/use-workflow-events.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// web/src/__tests__/use-workflow-events.test.ts
import { describe, expect, test } from "bun:test";

const { buildRunSummary } = await import("../lib/use-workflow-events");

describe("buildRunSummary", () => {
  test("返回 null 当 dag_status 为 PENDING 且无节点状态", () => {
    const snap = {
      snapshot_id: "s1",
      run_id: "r1",
      last_event_id: "e1",
      timestamp: "2026-01-01T00:00:00Z",
      dag_status: "PENDING",
      node_states: {},
    };
    expect(buildRunSummary(snap)).toBeNull();
  });

  test("返回运行中摘要", () => {
    const snap = {
      snapshot_id: "s1",
      run_id: "r1",
      last_event_id: "e1",
      timestamp: "2026-01-01T00:00:00Z",
      dag_status: "RUNNING",
      node_states: {
        shell_1: { status: "COMPLETED" },
        python_1: { status: "COMPLETED" },
        agent_1: { status: "RUNNING" },
        audit_1: { status: "PENDING" },
      },
    };
    const result = buildRunSummary(snap);
    expect(result).toContain("2/4");
    expect(result).toContain("运行中");
  });

  test("返回运行成功摘要", () => {
    const snap = {
      snapshot_id: "s1",
      run_id: "r1",
      last_event_id: "e1",
      timestamp: "2026-01-01T00:00:00Z",
      dag_status: "SUCCESS",
      node_states: {
        shell_1: { status: "COMPLETED" },
        python_1: { status: "COMPLETED" },
      },
    };
    const result = buildRunSummary(snap);
    expect(result).toContain("成功");
    expect(result).toContain("2/2");
  });

  test("返回失败摘要，包含失败节点", () => {
    const snap = {
      snapshot_id: "s1",
      run_id: "r1",
      last_event_id: "e1",
      timestamp: "2026-01-01T00:00:00Z",
      dag_status: "FAILED",
      node_states: {
        shell_1: { status: "COMPLETED" },
        python_1: { status: "FAILED", exit_code: 1 },
        agent_1: { status: "CANCELLED" },
      },
    };
    const result = buildRunSummary(snap);
    expect(result).toContain("失败");
    expect(result).toContain("python_1");
  });

  test("返回等待审批摘要", () => {
    const snap = {
      snapshot_id: "s1",
      run_id: "r1",
      last_event_id: "e1",
      timestamp: "2026-01-01T00:00:00Z",
      dag_status: "SUSPENDED",
      node_states: {
        shell_1: { status: "COMPLETED" },
        audit_1: { status: "RUNNING" },
      },
    };
    const result = buildRunSummary(snap);
    expect(result).toContain("等待审批");
    expect(result).toContain("audit_1");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test web/src/__tests__/use-workflow-events.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 buildRunSummary + useWorkflowEvents hook**

```typescript
// web/src/lib/use-workflow-events.ts
import { pushContext, removeContext } from "./context-queue";

interface DAGSnapshot {
  dag_status: string;
  node_states: Record<string, { status: string; exit_code?: number }>;
}

const errors: string[] = [];
let runStatusSummary: string | null = null;

function syncToContextQueue(): void {
  if (errors.length === 0 && runStatusSummary === null) {
    removeContext("workflow-events");
    return;
  }
  const lines: string[] = ["[工作流事件]"];
  if (runStatusSummary) {
    lines.push(`运行状态: ${runStatusSummary}`);
  }
  for (const err of errors) {
    lines.push(err);
  }
  pushContext("workflow-events", lines.join("\n"));
}

export function pushWorkflowError(source: string, message: string): void {
  errors.push(`错误 (${source}): ${message}`);
  syncToContextQueue();
}

export function pushWorkflowRunStatus(summary: string | null): void {
  runStatusSummary = summary;
  syncToContextQueue();
}

export function clearWorkflowEvents(): void {
  errors.length = 0;
  runStatusSummary = null;
  removeContext("workflow-events");
}

export function buildRunSummary(snap: DAGSnapshot): string | null {
  const { dag_status, node_states } = snap;
  const entries = Object.entries(node_states);
  const total = entries.length;

  if (total === 0 && dag_status === "PENDING") return null;

  const completed = entries.filter(([, s]) => s.status === "COMPLETED").length;
  const failed = entries.filter(([, s]) => s.status === "FAILED").length;
  const failedNodes = entries.filter(([, s]) => s.status === "FAILED").map(([id]) => id);

  if (dag_status === "SUCCESS") {
    return `运行成功 (${completed}/${total} 完成)`;
  }

  if (dag_status === "FAILED" || dag_status === "ERROR") {
    const parts = [`运行失败 (${completed}/${total} 完成, ${failed} 失败`];
    if (failedNodes.length > 0) parts.push(`: ${failedNodes.join(", ")}`);
    parts.push(")");
    return parts.join("");
  }

  if (dag_status === "CANCELLED") {
    return `已取消 (${completed}/${total} 完成)`;
  }

  if (dag_status === "SUSPENDED") {
    const suspendedNodes = entries.filter(([, s]) => s.status === "RUNNING").map(([id]) => id);
    return `等待审批 (${completed}/${total} 完成, 等待: ${suspendedNodes.join(", ") || "无"})`;
  }

  return `运行中 (${completed}/${total} 完成)`;
}

export function useWorkflowEvents() {
  return { pushWorkflowError, pushWorkflowRunStatus, clearWorkflowEvents };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test web/src/__tests__/use-workflow-events.test.ts`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/use-workflow-events.ts web/src/__tests__/use-workflow-events.test.ts
git commit -m "feat: 添加 useWorkflowEvents hook 及单元测试"
```

---

### Task 2: WorkflowEditor 集成 — 保存/发布/验证错误

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

- [ ] **Step 1: 添加 import**

在 `web/src/pages/workflow/WorkflowEditor.tsx` 的 import 区域添加：

```typescript
import { useWorkflowEvents } from "../../lib/use-workflow-events";
```

- [ ] **Step 2: 在组件内调用 hook**

在 WorkflowEditor 组件函数体中，在其他 hook 调用之后（约第 131 行 `const scenePrompt = useMemo(...)` 之后）添加：

```typescript
const { pushWorkflowError, pushWorkflowRunStatus, clearWorkflowEvents } = useWorkflowEvents();
```

- [ ] **Step 3: 保存失败时 push 错误**

找到 `handleSaveDraft` 的 catch 块（约第 462 行）：

```typescript
    } catch (err) {
      console.error(err);
      alert(`${t("editor.save_failed")}: ${(err as Error).message}`);
      setSaveStatus("idle");
    }
```

在 `console.error(err);` 之后添加：

```typescript
      pushWorkflowError("save", (err as Error).message);
```

- [ ] **Step 4: 发布失败时 push 错误**

找到 `handlePublish` 的第二个 catch 块（约第 490 行）：

```typescript
    } catch (err) {
      console.error(err);
      alert(`${t("editor.publish_failed")}: ${(err as Error).message}`);
    }
```

在 `console.error(err);` 之后添加：

```typescript
      pushWorkflowError("publish", (err as Error).message);
```

- [ ] **Step 5: 验证错误时 push 错误**

找到 `handleDryRun` 的 catch 块（约第 517 行）：

```typescript
    } catch (err) {
      console.error(err);
      setDryRunResult({ valid: false, issues: [{ type: "error", message: (err as Error).message }] });
    }
```

在 `console.error(err);` 之后添加：

```typescript
      pushWorkflowError("validation", (err as Error).message);
```

- [ ] **Step 6: 验证编译通过**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 7: 提交**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat: WorkflowEditor 保存/发布/验证错误 push 到 context queue"
```

---

### Task 3: WorkflowEditor 集成 — 运行状态和错误

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

- [ ] **Step 1: 运行启动时清空旧事件**

找到 `handleRun` 函数（约第 656 行），在 `setRunning(true);` 之后添加：

```typescript
    clearWorkflowEvents();
```

- [ ] **Step 2: 运行失败时 push 错误**

找到 `handleRun` 中的 try-finally 块（约第 676-688 行）：

```typescript
    try {
      const result = await workflowEngineApi.run(y, undefined, workflowId);
      setActiveRunId(result.runId);
      setRunSnapshot(null);
      setRunEvents([]);
      setRunApprovals([]);
      setSelectedRunNodeId(null);
      setSelectedNodeOutput(null);
      setRightTab("run");
      await loadRunData(result.runId);
    } finally {
      setRunning(false);
    }
```

改为 try-catch-finally：

```typescript
    try {
      const result = await workflowEngineApi.run(y, undefined, workflowId);
      setActiveRunId(result.runId);
      setRunSnapshot(null);
      setRunEvents([]);
      setRunApprovals([]);
      setSelectedRunNodeId(null);
      setSelectedNodeOutput(null);
      setRightTab("run");
      await loadRunData(result.runId);
    } catch (err) {
      console.error(err);
      pushWorkflowError("run", (err as Error).message);
    } finally {
      setRunning(false);
    }
```

注意：`handleRun` 的 useCallback 依赖数组需要保持不变。

- [ ] **Step 3: 运行状态变化时 push 摘要**

找到 `loadRunData` 函数（约第 593 行），在 `if (snap) { setRunSnapshot(snap); ... }` 块中添加 push 调用：

当前代码：
```typescript
        if (snap) {
          setRunSnapshot(snap);
          updateNodesFromSnapshot(snap);
        }
```

改为：
```typescript
        if (snap) {
          setRunSnapshot(snap);
          updateNodesFromSnapshot(snap);
          pushWorkflowRunStatus(buildRunSummary(snap));
        }
```

需要在文件顶部添加 import：

```typescript
import { buildRunSummary } from "../../lib/use-workflow-events";
```

（注意：`useWorkflowEvents` 已经在 Task 2 中导入了，但 `buildRunSummary` 需要单独添加到该 import 语句中。）

更新 import 行：

```typescript
import { buildRunSummary, useWorkflowEvents } from "../../lib/use-workflow-events";
```

- [ ] **Step 4: 验证编译通过**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat: WorkflowEditor 运行状态和错误 push 到 context queue"
```

---

### Task 4: precheck 和最终验证

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck`
Expected: 通过（format + import sort + tsc + biome check，仅有已有代码的 lint 警告）

- [ ] **Step 2: 运行所有相关测试**

Run: `bun test web/src/__tests__/use-workflow-events.test.ts web/src/__tests__/context-queue.test.ts`
Expected: ALL PASS

- [ ] **Step 3: 最终提交（如有 precheck 自动修复）**

```bash
git add -A
git commit -m "chore: precheck 修复"
```
