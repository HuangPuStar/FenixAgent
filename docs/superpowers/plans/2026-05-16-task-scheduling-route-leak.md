# Task 调度路由泄漏修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Task 调度编排逻辑从路由层下沉到 Service 层，路由只做参数提取和响应格式化。

**Architecture:** 当前 `routes/web/tasks.ts` 在创建/更新/删除/toggle 任务后，手动调用 `scheduleTask()`、`rescheduleTask()`、`unscheduleTask()`。调度编排应内聚到 `task.ts` service 中——`createTask` 自动调度、`updateTask` 自动重调度、`deleteTask` 自动取消调度、`toggleTask` 自动切换调度状态。

**Tech Stack:** TypeScript, Elysia, node-schedule

---

### Task 1: 在 task.ts service 中内聚调度编排

**Files:**
- Modify: `src/services/task.ts`

- [ ] **Step 1: 在 `createTask` 末尾添加自动调度**

在 `createTask()` 成功创建任务后，自动调用 `scheduleTask()`：

```typescript
import { scheduleTask, rescheduleTask, unscheduleTask } from "./scheduler";

// 在 createTask 返回成功结果前：
if (result.success && result.data!.enabled) {
  scheduleTask({ id: result.data!.id, cron: result.data!.cron, timezone: result.data!.timezone, enabled: result.data!.enabled });
}
```

- [ ] **Step 2: 在 `updateTask` 末尾添加自动重调度**

更新成功后自动 `rescheduleTask()`，无论 enabled 状态——reschedule 内部处理 enabled=false 的情况。

- [ ] **Step 3: 在 `deleteTask` 末尾添加自动取消调度**

删除成功后自动 `unscheduleTask(taskId)`。

- [ ] **Step 4: 在 `toggleTask` 末尾添加自动切换调度**

toggle 成功后：
- 如果 enabled → `scheduleTask()`
- 如果 disabled → `unscheduleTask()`

- [ ] **Step 5: 运行 typecheck**

Run: `bunx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/services/task.ts
git commit -m "refactor: task service 内聚调度编排，创建/更新/删除自动管理调度状态"
```

### Task 2: 清理路由层调度调用

**Files:**
- Modify: `src/routes/web/tasks.ts`

- [ ] **Step 1: 移除 `import { scheduleTask, unscheduleTask, rescheduleTask }` 从路由**

- [ ] **Step 2: 从 POST /tasks 路由中移除 `scheduleTask()` 调用 (line 50)**

- [ ] **Step 3: 从 PUT /tasks/:id 路由中移除 `rescheduleTask()` 调用 (line 85)**

- [ ] **Step 4: 从 DELETE /tasks/:id 路由中移除 `unscheduleTask()` 调用 (line 101)**

- [ ] **Step 5: 从 POST /tasks/:id/toggle 路由中移除手动调度逻辑 (lines 117-125)**

同时移除 toggle 路由中多余的 `getTask()` 调用（line 118-121）——toggle 结果已包含 enabled 状态。

- [ ] **Step 6: 运行 typecheck**

Run: `bunx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/routes/web/tasks.ts
git commit -m "refactor: 清理 tasks 路由中的调度编排调用，下沉到 service 层"
```
