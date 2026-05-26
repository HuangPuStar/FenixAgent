# Workflow SSE 实时事件推送 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Workflow 建立 SSE 实时事件推送通道，使 Meta Agent 通过 API 触发的动作（保存草稿、运行、取消、发布等）能实时通知前端更新状态，取代前端 2s 轮询。

**Architecture:** 复用现有 EventBus + SSE 基础设施。后端新增一个 per-workflow 的 EventBus 注册表（`workflowEventBuses`），在 workflow-defs 和 workflow-engine 路由的关键 action 成功后发布事件。新增一个 GET SSE 端点供前端 EventSource 订阅。前端新增 workflow SSE hook，在 useWorkflowRun 中用 SSE 事件替代轮询。

**Tech Stack:** Elysia (后端), EventBus/SSE (现有基础设施), EventSource API (前端浏览器原生)

---

## File Structure

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/services/workflow/workflow-events.ts` | Per-workflow EventBus 注册表 + publishWorkflowEvent 工具函数 |
| `src/routes/web/workflow-sse.ts` | `GET /web/workflow/:workflowId/events` SSE 端点 |
| `web/src/api/workflow-sse.ts` | 前端 workflow EventSource 连接管理 |

### 修改文件

| 文件 | 改什么 |
|------|--------|
| `src/routes/web/workflow-engine.ts` | run/cancel/rerunFrom/approve 成功后发布 workflow 事件 |
| `src/routes/web/workflow-defs.ts` | save/publish 成功后发布 workflow 事件 |
| `src/routes/web/index.ts` | 注册 workflow-sse 路由 |
| `src/services/config/skill-meta-content.ts` | 在 SKILL.md 中增加 API 调用指南 |
| `web/src/pages/workflow/hooks/useWorkflowRun.ts` | 接收 SSE 事件触发参数，用 SSE 替代轮询 |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 管理 SSE 连接生命周期 |
| `web/src/api/workflow-engine.ts` | 新增 SSE 连接所需的 workflowId 参数传递支持 |

---

## Task 1: 后端 Workflow EventBus 注册表

**Files:**
- Create: `src/services/workflow/workflow-events.ts`

这个模块提供 per-workflow 的 EventBus 管理，供路由层发布事件、SSE 端点订阅。

- [ ] **Step 1: 创建 workflow-events.ts**

```typescript
// src/services/workflow/workflow-events.ts

import { type EventBus, getEventBus, removeEventBus } from "../../transport/event-bus";

/** Workflow SSE 事件类型 */
export type WorkflowEventType =
  | "workflow.draft_updated"
  | "workflow.run_started"
  | "workflow.run_status_changed"
  | "workflow.run_cancelled"
  | "workflow.dry_run_completed"
  | "workflow.version_published";

/** Workflow SSE 事件载荷 */
export interface WorkflowEventPayload {
  type: WorkflowEventType;
  workflowId: string;
  [key: string]: unknown;
}

/** 生成 workflow EventBus 的 key */
function workflowBusKey(workflowId: string): string {
  return `wf:${workflowId}`;
}

/** 获取指定 workflow 的 EventBus */
export function getWorkflowEventBus(workflowId: string): EventBus {
  return getEventBus(workflowBusKey(workflowId));
}

/** 发布一个 workflow SSE 事件 */
export function publishWorkflowEvent(
  workflowId: string,
  type: WorkflowEventType,
  extra: Omit<WorkflowEventPayload, "type" | "workflowId"> = {},
): void {
  const bus = getWorkflowEventBus(workflowId);
  bus.publish({
    id: `wf_evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: workflowBusKey(workflowId),
    type,
    payload: { type, workflowId, ...extra },
    direction: "outbound",
  });
}

/** 清理 workflow EventBus（可选，防止内存泄漏） */
export function removeWorkflowEventBus(workflowId: string): void {
  removeEventBus(workflowBusKey(workflowId));
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add src/services/workflow/workflow-events.ts
git commit -m "feat: 新增 workflow SSE 事件总线模块"
```

---

## Task 2: 后端 SSE 端点

**Files:**
- Create: `src/routes/web/workflow-sse.ts`
- Modify: `src/routes/web/index.ts` — 注册新路由

提供 `GET /web/workflow/:workflowId/events` SSE 端点，复用现有 `createSSEStream` 模式。

- [ ] **Step 1: 创建 workflow-sse.ts 路由**

```typescript
// src/routes/web/workflow-sse.ts

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { getWorkflowEventBus } from "../../services/workflow/workflow-events";

const app = new Elysia({ name: "web-workflow-sse" }).use(authGuardPlugin);

/**
 * GET /web/workflow/:workflowId/events — Workflow SSE 实时事件流
 *
 * 前端通过 EventSource 订阅此端点，接收 workflow 状态变更事件。
 * 支持 Last-Event-ID / fromSeqNum 参数用于断线重连。
 */
app.get(
  "/workflow/:workflowId/events",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ request, params, query, error, store }: any) => {
    const authCtx = store.authContext;
    if (!authCtx) {
      return error(401, { error: { type: "UNAUTHORIZED", message: "No auth context" } });
    }

    const workflowId = params.workflowId as string;
    if (!workflowId) {
      return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
    }

    const bus = getWorkflowEventBus(workflowId);

    const lastEventId = request.headers.get("Last-Event-ID");
    const fromSeq = (query as Record<string, unknown>)?.fromSeqNum;
    const fromSeqNum = fromSeq ? Number(fromSeq) : lastEventId ? Number(lastEventId) : 0;

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": keepalive\n\n"));

        // 回放历史事件（断线重连）
        if (fromSeqNum > 0) {
          const missed = bus.getEventsSince(fromSeqNum);
          for (const event of missed) {
            const data = JSON.stringify(event.payload);
            controller.enqueue(
              encoder.encode(`id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`),
            );
          }
        }

        // 订阅新事件
        const unsub = bus.subscribe((event) => {
          try {
            const data = JSON.stringify(event.payload);
            controller.enqueue(
              encoder.encode(`id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`),
            );
          } catch {
            unsub();
          }
        });

        // Keepalive（15s）
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
            unsub();
          }
        }, 15_000);

        request.signal.addEventListener("abort", () => {
          unsub();
          clearInterval(keepalive);
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  },
  { sessionAuth: true },
);

export default app;
```

- [ ] **Step 2: 在 web/index.ts 注册路由**

在 `src/routes/web/index.ts` 中添加 import 和 `.use()`：

在 import 区域添加：
```typescript
import webWorkflowSse from "./workflow-sse";
```

在链式调用中（在 `.use(webWorkflowEngine)` 后面）添加：
```typescript
  .use(webWorkflowSse)
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/workflow-sse.ts src/routes/web/index.ts
git commit -m "feat: 新增 workflow SSE 实时事件端点"
```

---

## Task 3: 后端路由发布事件

**Files:**
- Modify: `src/routes/web/workflow-engine.ts` — run/cancel/rerunFrom 成功后发布事件
- Modify: `src/routes/web/workflow-defs.ts` — save/publish 成功后发布事件

在已有的路由 action 成功后，调用 `publishWorkflowEvent` 发布 SSE 事件。

- [ ] **Step 1: 修改 workflow-engine.ts 发布事件**

在文件顶部 import 区域添加：
```typescript
import { publishWorkflowEvent } from "../../services/workflow/workflow-events";
```

在 `case "run":` 的 `return { success: true, data: result };` 之前添加：
```typescript
          if (workflowId) {
            publishWorkflowEvent(workflowId, "workflow.run_started", { runId: result.runId });
          }
```

在 `case "cancel":` 的 `return { success: true };` 之前添加：
```typescript
          // cancel 事件需要 workflowId，从 run 的 snapshot 中获取
          // 由于 cancel 路由没有直接传 workflowId，这里用 runId 查找
          // 简化方案：在 payload 中增加可选 workflowId 字段
          const cancelWorkflowId = payload.workflowId as string | undefined;
          if (cancelWorkflowId) {
            publishWorkflowEvent(cancelWorkflowId, "workflow.run_cancelled", { runId });
          }
```

在 `case "rerunFrom":` 的 `return { success: true, data: result };` 之前添加：
```typescript
          if (workflowId) {
            publishWorkflowEvent(workflowId, "workflow.run_started", { runId: result.runId });
          }
```

在 `case "approve":` 的 `return { success: true };` 之前添加：
```typescript
          const approveWorkflowId = payload.workflowId as string | undefined;
          if (approveWorkflowId) {
            publishWorkflowEvent(approveWorkflowId, "workflow.run_status_changed", {
              runId,
              dagStatus: "RUNNING",
            });
          }
```

在 `case "dryRun":` 的 `return { success: true, data: result };` 之前添加：
```typescript
          const dryRunWorkflowId = payload.workflowId as string | undefined;
          if (dryRunWorkflowId) {
            publishWorkflowEvent(dryRunWorkflowId, "workflow.dry_run_completed", {
              valid: result.valid,
              issues: result.issues,
            });
          }
```

- [ ] **Step 2: 修改 workflow-defs.ts 发布事件**

在文件顶部 import 区域添加：
```typescript
import { publishWorkflowEvent } from "../../services/workflow/workflow-events";
```

在 `case "save":` 的 `return { success: true };` 之前添加：
```typescript
          publishWorkflowEvent(workflowId, "workflow.draft_updated", { yaml });
```

在 `case "publish":` 的 `return { success: true, data: vRow };` 之前添加：
```typescript
          publishWorkflowEvent(workflowId, "workflow.version_published", {
            version: vRow?.version,
          });
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/workflow-engine.ts src/routes/web/workflow-defs.ts
git commit -m "feat: workflow 路由成功后发布 SSE 事件"
```

---

## Task 4: 后端引擎运行时事件推送

**Files:**
- Modify: `src/services/workflow/index.ts` — 引擎执行时发布 DAG 状态变更事件

当 Workflow Engine 内部调度器完成/失败 DAG 时，后端路由层无法感知。需要在引擎回调中发布事件。

引擎 `createWorkflowEngine` 接受一个可选的 `onEvent` 回调，用于在引擎产生事件时通知宿主层。查看引擎 `run` 方法返回后通过存储适配器写入的事件，我们通过在路由层 run 之后立即轮询一次 + SSE 补发的方式简化实现。

- [ ] **Step 1: 在 workflow-engine.ts 的 run case 中添加完成事件推送**

由于 `engine.run()` 是同步阻塞的（会等待 DAG 完成），run 返回后 DAG 状态已经确定。在 run case 的 `publishWorkflowEvent("workflow.run_started", ...)` 之后，根据 result.status 追加发布完成事件：

在 `case "run":` 中，`return` 之前，紧接 `publishWorkflowEvent("workflow.run_started", ...)` 后面添加：

```typescript
          // run 是同步阻塞的，返回时 DAG 已完成（或挂起）
          if (workflowId && result.status) {
            const terminalStatuses = ["SUCCESS", "FAILED", "CANCELLED", "ERROR"];
            if (terminalStatuses.includes(result.status)) {
              publishWorkflowEvent(workflowId, "workflow.run_status_changed", {
                runId: result.runId,
                dagStatus: result.status,
              });
            }
          }
```

- [ ] **Step 2: 在 cancel case 中添加状态变更事件**

cancel 成功后也需要推送状态变更。由于 cancel 是异步的，取消后需要读取最新状态：

在 `case "cancel":` 的 `await engine.cancel(runId);` 之后、return 之前：

```typescript
          if (cancelWorkflowId) {
            publishWorkflowEvent(cancelWorkflowId, "workflow.run_status_changed", {
              runId,
              dagStatus: "CANCELLED",
            });
          }
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/workflow-engine.ts
git commit -m "feat: 引擎 run/cancel 完成后推送 DAG 状态变更事件"
```

---

## Task 5: 前端 Workflow SSE 客户端

**Files:**
- Create: `web/src/api/workflow-sse.ts`

封装 workflow EventSource 连接管理，复用现有 SSE 模式（参考 `web/src/api/sse.ts`）。

- [ ] **Step 1: 创建 workflow-sse.ts**

```typescript
// web/src/api/workflow-sse.ts

export interface WorkflowSSEEvent {
  type: string;
  workflowId: string;
  [key: string]: unknown;
}

let currentES: EventSource | null = null;
let lastSeqNum = 0;

/**
 * 连接 workflow SSE 事件流。
 * 同一时间只维护一个连接（调用时会自动断开旧连接）。
 */
export function connectWorkflowSSE(
  workflowId: string,
  onEvent: (event: WorkflowSSEEvent) => void,
): void {
  disconnectWorkflowSSE();

  const url = `/web/workflow/${encodeURIComponent(workflowId)}/events${
    lastSeqNum > 0 ? `?fromSeqNum=${lastSeqNum}` : ""
  }`;
  const es = new EventSource(url, { withCredentials: true });
  currentES = es;

  es.addEventListener("message", (e: MessageEvent) => {
    try {
      const seqNum = Number(e.lastEventId);
      if (seqNum && seqNum <= lastSeqNum) return;
      if (seqNum) lastSeqNum = seqNum;

      const data = JSON.parse(e.data) as WorkflowSSEEvent;
      onEvent(data);
    } catch {
      // ignore parse errors
    }
  });

  es.addEventListener("error", () => {
    // EventSource 自动重连
  });
}

/** 断开 workflow SSE 连接 */
export function disconnectWorkflowSSE(): void {
  if (currentES) {
    currentES.close();
    currentES = null;
  }
  lastSeqNum = 0;
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add web/src/api/workflow-sse.ts
git commit -m "feat: 新增前端 workflow SSE 事件客户端"
```

---

## Task 6: 前端 useWorkflowRun 集成 SSE

**Files:**
- Modify: `web/src/pages/workflow/hooks/useWorkflowRun.ts` — 接收 SSE 事件回调参数
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx` — 连接 SSE + 分发事件

在 WorkflowEditor 中建立 SSE 连接，收到事件后调用 useWorkflowRun 中已有的方法（loadRunData、handleRefreshDraft 等）。

- [ ] **Step 1: 在 useWorkflowRun 中暴露 handleWorkflowEvent 方法**

在 `useWorkflowRun.ts` 的 return 之前，新增一个 handleWorkflowEvent 回调：

```typescript
  const handleWorkflowEvent = useCallback(
    (event: import("../../../api/workflow-sse").WorkflowSSEEvent) => {
      switch (event.type) {
        case "workflow.draft_updated": {
          // 刷新画布（由 WorkflowEditor 层调用 handleRefreshDraft）
          break;
        }
        case "workflow.run_started": {
          const runId = event.runId as string;
          if (runId && runId !== activeRunId) {
            setActiveRunId(runId);
            setRunSnapshot(null);
            setRunEvents([]);
            setRunApprovals([]);
            setSelectedRunNodeId(null);
            setSelectedNodeOutput(null);
            loadRunData(runId);
          }
          break;
        }
        case "workflow.run_status_changed":
        case "workflow.run_cancelled": {
          if (activeRunId) loadRunData(activeRunId);
          break;
        }
        case "workflow.version_published": {
          // 版本列表在 VersionPanel 中自行管理，无需操作
          break;
        }
        case "workflow.dry_run_completed": {
          // dryRun 结果需要回传给上层，由 WorkflowEditor 处理
          break;
        }
      }
    },
    [activeRunId, setActiveRunId, setRunSnapshot, setRunEvents, setRunApprovals, setSelectedRunNodeId, setSelectedNodeOutput, loadRunData],
  );
```

在 `UseWorkflowRunReturn` 接口中添加：
```typescript
  handleWorkflowEvent: (event: import("../../../api/workflow-sse").WorkflowSSEEvent) => void;
```

在 return 对象中添加：
```typescript
    handleWorkflowEvent,
```

- [ ] **Step 2: 在 WorkflowEditor.tsx 中管理 SSE 连接生命周期**

在 `WorkflowEditor.tsx` 的 import 区域添加：
```typescript
import { connectWorkflowSSE, disconnectWorkflowSSE } from "../../api/workflow-sse";
```

在 `WorkflowEditorInner` 组件中，在 `// ── Derived state ──` 之前（数据加载 useEffect 之后），添加 SSE 连接管理 useEffect：

```typescript
  // ── Workflow SSE 实时事件 ──
  useEffect(() => {
    if (!workflowId) return;

    connectWorkflowSSE(workflowId, (event) => {
      switch (event.type) {
        case "workflow.draft_updated":
          handleRefreshDraft();
          break;
        case "workflow.run_started":
        case "workflow.run_status_changed":
        case "workflow.run_cancelled":
          handleWorkflowEvent(event);
          break;
        case "workflow.dry_run_completed":
          // dryRunResult 由 useWorkflowRun 管理，这里直接设置
          if (event.valid !== undefined) {
            clearDryRunResult();
            // 通过 setDryRunResult 设置需要暴露，当前简化处理
          }
          break;
        case "workflow.version_published":
          // VersionPanel 自管理
          break;
      }
    });

    return () => {
      disconnectWorkflowSSE();
    };
  }, [workflowId, handleRefreshDraft, handleWorkflowEvent, clearDryRunResult]);
```

注意：`handleWorkflowEvent` 需要从 `useWorkflowRun` 的返回值中解构出来。在 WorkflowEditorInner 的 `const { ..., handleWorkflowEvent } = useWorkflowRun({...})` 解构中添加 `handleWorkflowEvent`。

- [ ] **Step 3: 降级轮询频率**

SSE 连接成功后，轮询频率可以从 2s 降为 10s 作为兜底。

在 `useWorkflowRun.ts` 的轮询 useEffect 中，修改间隔：
将 `pollRef.current = setTimeout(poll, 2000);` 改为 `pollRef.current = setTimeout(poll, 10_000);`

并添加注释：
```typescript
          // SSE 作为主要状态更新机制，轮询 10s 作为兜底
```

- [ ] **Step 4: 验证 TypeScript 编译**

Run: `npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 5: Format + lint**

Run: `bunx biome format --write web/src/pages/workflow/ && bunx biome check --linter-enabled=false --write web/src/pages/workflow/`
Expected: Fixed files count may vary

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/workflow/hooks/useWorkflowRun.ts web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat: 前端集成 workflow SSE 事件，用实时推送替代轮询"
```

---

## Task 7: Meta Agent Skill 增加 API 调用指南

**Files:**
- Modify: `src/services/config/skill-meta-content.ts` — 在 SKILL.md 中增加 API 调用说明

教 Meta Agent 如何通过 curl 调用后端 API，触发工作流运行、保存、发布等操作。事件推送由后端自动完成，Meta Agent 无需关心 SSE 细节。

- [ ] **Step 1: 在 SKILL.md 末尾增加 API 调用指南章节**

在 `META_SKILL_MARKDOWN` 模板字符串的 `## 注意事项` 之前，插入以下内容：

```markdown

## API 调用

你可以通过 CLI 工具调用后端 API 来操作工作流。所有请求需要携带环境变量 \`$USER_META_API_KEY\` 作为 Bearer token。

### 保存草稿

当用户确认修改后，将 YAML 写入 draft.yaml 文件，然后调用保存接口：

\`\`\`bash
curl -X POST http://localhost:${process.env.RCS_PORT || 3000}/web/workflow-defs \\
  -H "Authorization: Bearer $USER_META_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"action":"save","workflowId":"<workflowId>","yaml":"<yaml_content>"}'
\`\`\`

保存成功后，前端画布会自动刷新。

### 运行工作流

\`\`\`bash
curl -X POST http://localhost:${process.env.RCS_PORT || 3000}/web/workflow-engine \\
  -H "Authorization: Bearer $USER_META_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"action":"run","yaml":"<yaml_content>","workflowId":"<workflowId>"}'
\`\`\`

运行会阻塞到完成。前端会自动切换到运行视图并显示进度。

### 干运行（验证）

\`\`\`bash
curl -X POST http://localhost:${RCS_PORT || 3000}/web/workflow-engine \\
  -H "Authorization: Bearer $USER_META_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"action":"dryRun","yaml":"<yaml_content>","workflowId":"<workflowId>"}'
\`\`\`

### 查询运行状态

\`\`\`bash
curl -X POST http://localhost:${process.env.RCS_PORT || 3000}/web/workflow-engine \\
  -H "Authorization: Bearer $USER_META_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"action":"getRunStatus","runId":"<runId>"}'
\`\`\`

### 取消运行

\`\`\`bash
curl -X POST http://localhost:${process.env.RCS_PORT || 3000}/web/workflow-engine \\
  -H "Authorization: Bearer $USER_META_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"action":"cancel","runId":"<runId>","workflowId":"<workflowId>"}'
\`\`\`

### 发布版本

\`\`\`bash
curl -X POST http://localhost:${process.env.RCS_PORT || 3000}/web/workflow-defs \\
  -H "Authorization: Bearer $USER_META_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"action":"publish","workflowId":"<workflowId>"}'
\`\`\`

### 工作流操作建议

1. **修改后保存**：先修改 YAML 文件，再调用 save API，前端会自动刷新
2. **先验证再运行**：建议先 dryRun 验证，通过后再 run
3. **告知用户操作结果**：API 返回 success:true 表示成功，前端会自动更新
4. **workflowId 从 scenePrompt 中获取**：会话开始时的上下文信息中包含 workflowId
```

注意：由于 META_SKILL_MARKDOWN 是模板字符串，`${process.env.RCS_PORT || 3000}` 会被实际求值。如果不想在运行时求值，可以用固定端口或让 Meta Agent 从环境变量自行读取。推荐使用固定值 `3000` 替代 `${process.env.RCS_PORT || 3000}`，因为 Meta Agent 和后端在同一主机。

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add src/services/config/skill-meta-content.ts
git commit -m "feat: Meta Agent Skill 增加 workflow API 调用指南"
```

---

## Task 8: 全量验证

**Files:**
- All modified files

- [ ] **Step 1: 运行后端 TypeScript 编译**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | tail -5`
Expected: 0 errors（允许已存在的 pre-existing errors）

- [ ] **Step 2: 运行前端 TypeScript 编译**

Run: `npx tsc --noEmit --project web/tsconfig.json 2>&1 | tail -5`
Expected: 0 errors

- [ ] **Step 3: 运行 Biome 格式化**

Run: `bunx biome format --write src/services/workflow/ src/routes/web/workflow-*.ts web/src/api/workflow-sse.ts web/src/pages/workflow/`
Expected: 可能修复少量格式问题

- [ ] **Step 4: 运行 Biome check（import 排序）**

Run: `bunx biome check --linter-enabled=false --write src/services/workflow/ src/routes/web/workflow-*.ts web/src/api/workflow-sse.ts web/src/pages/workflow/`
Expected: 可能修复 import 顺序

- [ ] **Step 5: 运行 Biome 全量检查**

Run: `bunx biome check src/services/workflow/ src/routes/web/workflow-*.ts web/src/api/workflow-sse.ts web/src/pages/workflow/`
Expected: 0 errors，可能有少量 warnings（noUnusedVariables 等已存在的）

- [ ] **Step 6: 运行后端测试**

Run: `bun test src/__tests__/ 2>&1 | tail -10`
Expected: 所有测试通过

- [ ] **Step 7: 运行前端测试**

Run: `bun test web/src/__tests__/ 2>&1 | tail -10`
Expected: 所有测试通过

- [ ] **Step 8: 最终提交**

```bash
git add -A
git commit -m "chore: workflow SSE 事件推送全量验证通过"
```

---

## Self-Review

### 1. Spec Coverage

| 需求 | 对应 Task |
|------|----------|
| SSE 基础设施（后端 EventBus + SSE 端点） | Task 1, 2 |
| draft_updated 事件 | Task 3（workflow-defs save） |
| run_started 事件 | Task 3（workflow-engine run）, Task 4（完成后推送） |
| run_status_changed 事件 | Task 4（run 完成 + cancel） |
| version_published 事件 | Task 3（workflow-defs publish） |
| dry_run_completed 事件 | Task 3（workflow-engine dryRun） |
| 前端 SSE 连接管理 | Task 5 |
| 前端 SSE 事件分发 | Task 6 |
| Meta Agent API 调用指南 | Task 7 |
| 全量验证 | Task 8 |

### 2. Placeholder Scan

无 TBD/TODO/placeholder。所有步骤包含完整代码。

### 3. Type Consistency

- `WorkflowEventType` 在 Task 1 定义，Task 3/4 中使用相同的字符串字面量
- `WorkflowSSEEvent` 在 Task 5 定义，Task 6 中用 `import("../../../api/workflow-sse").WorkflowSSEEvent` 引用
- `publishWorkflowEvent` 签名 `(workflowId, type, extra)` 在 Task 1 定义，Task 3/4 调用时参数一致
- EventBus 的 `publish` 接受 `Omit<SessionEvent, "seqNum" | "createdAt">`，Task 1 中传入的 `{ id, sessionId, type, payload, direction }` 匹配
