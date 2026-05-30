# Workflow Kanban Board 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在工作流管理页面新增 Kanban tab，提供看板式工作流 Job 编排界面（创建 → 填参 → 运行 → 审批 → 完成/重跑）。

**Architecture:** 新建 `workflow_job` 表作为 Job 实体（与 `workflow_run` 解耦），通过 `POST /web/workflow-jobs` action 分发路由提供 CRUD + run/cancel/approve API，per-organization EventBus + SSE 端点推送实时状态变更。前端四列看板布局，卡片展示状态/进度/参数摘要。

**Tech Stack:** Drizzle ORM (schema + migration), Elysia (route), EventBus (SSE), React 19 + TanStack Router (frontend), react-i18next (i18n)

---

## File Structure

### Backend — New Files

| File | Responsibility |
|------|----------------|
| `src/repositories/workflow-job.ts` | Job 数据访问层（CRUD + 状态更新） |
| `src/routes/web/workflow-jobs.ts` | Job API 路由（action 分发：create/list/get/updateParams/run/cancel/approve/getPendingApprovals/delete） |
| `src/routes/web/workflow-jobs-sse.ts` | 看板 SSE 端点（`GET /web/workflow-jobs/events`） |
| `src/services/workflow/workflow-job-events.ts` | Per-organization EventBus + publish helpers |

### Backend — Modified Files

| File | Change |
|------|--------|
| `src/db/schema.ts` | 新增 `workflowJob` 表定义（在 `workflowTrigger` 表之前） |
| `drizzle/` | `bunx drizzle-kit generate --name workflow-job` 生成迁移 |
| `src/routes/web/workflow-defs.ts` | 新增 `getParamDefs` action |
| `src/routes/web/workflow-engine.ts` | run/cancel 回调中同步 Job 状态（通过事件监听） |

### Frontend — New Files

| File | Responsibility |
|------|----------------|
| `web/src/pages/workflow/WorkflowKanban.tsx` | 看板主页面（四列布局 + SSE 订阅） |
| `web/src/pages/workflow/components/KanbanColumn.tsx` | 单列组件（列头 + 卡片列表 + 折叠） |
| `web/src/pages/workflow/components/KanbanCard.tsx` | 卡片组件（状态/进度/操作菜单） |
| `web/src/pages/workflow/components/KanbanJobDialog.tsx` | 创建/编辑 Job 对话框（选工作流 + 动态参数表单） |
| `web/src/api/workflow-jobs.ts` | Job API 客户端 |
| `web/src/i18n/locales/en/kanban.json` | 英文翻译 |
| `web/src/i18n/locales/zh/kanban.json` | 中文翻译 |

### Frontend — Modified Files

| File | Change |
|------|--------|
| `web/src/routes/agent/_panel/workflow.tsx` | 新增第三个 tab「Kanban」 |
| `web/src/pages/workflow/WorkflowList.tsx` | 每行新增「添加到看板」按钮 |
| `web/src/i18n/index.ts` | 注册 `kanban` 命名空间 |

---

### Task 1: DB Schema + Migration

**Files:**
- Modify: `src/db/schema.ts`（在 `workflowTrigger` 表定义之前插入）
- Generate: `drizzle/` 迁移文件

- [ ] **Step 1: 在 schema.ts 中添加 workflowJob 表定义**

在 `workflowTrigger` 表（约第 734 行）之前插入：

```typescript
// ────────────────────────────────────────────
// Workflow Job（看板 Job 实体）
// ────────────────────────────────────────────

export const workflowJob = pgTable(
  "workflow_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    params: jsonb("params"),
    status: varchar("status", { length: 20 }).notNull().default("ready"),
    lastRunId: varchar("last_run_id"),
    lastDagStatus: varchar("last_dag_status", { length: 20 }),
    runCount: integer("run_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("idx_workflow_job_org").on(table.organizationId),
    statusIdx: index("idx_workflow_job_status").on(table.organizationId, table.status),
    workflowIdx: index("idx_workflow_job_workflow").on(table.workflowId),
  }),
);
```

- [ ] **Step 2: 生成迁移文件**

Run: `bunx drizzle-kit generate --name workflow-job`
Expected: 在 `drizzle/` 目录下生成新的 SQL 迁移文件，包含 `CREATE TABLE workflow_job` 和三个索引。

- [ ] **Step 3: 推送到开发数据库验证**

Run: `bun run db:push`
Expected: 无错误，表创建成功。

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: 添加 workflow_job 表 schema 和迁移"
```

---

### Task 2: Repository

**Files:**
- Create: `src/repositories/workflow-job.ts`
- Modify: `src/repositories/index.ts`（re-export）

- [ ] **Step 1: 创建 workflow-job.ts repository**

```typescript
/**
 * Workflow Job Repository。
 *
 * 管理看板 Job 的 CRUD 和状态更新。
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { user, workflow, workflowJob } from "../db/schema";

// ── 类型 ──

export interface WorkflowJobRow {
  id: string;
  organizationId: string;
  userId: string;
  workflowId: string;
  version: number;
  params: Record<string, unknown> | null;
  status: string;
  lastRunId: string | null;
  lastDagStatus: string | null;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowJobListItem extends WorkflowJobRow {
  workflowName: string;
  userName: string | null;
}

export type JobStatus = "ready" | "running" | "suspended" | "completed";

// ── CRUD ──

/** 创建 Job */
export async function createJob(
  organizationId: string,
  userId: string,
  data: { workflowId: string; version: number; params?: Record<string, unknown> },
): Promise<WorkflowJobRow> {
  const [row] = await db
    .insert(workflowJob)
    .values({
      organizationId,
      userId,
      workflowId: data.workflowId,
      version: data.version,
      params: data.params ?? null,
      status: "ready",
    })
    .returning();
  return row;
}

/** 获取单个 Job */
export async function getJob(jobId: string, organizationId: string): Promise<WorkflowJobRow | null> {
  const [row] = await db
    .select()
    .from(workflowJob)
    .where(and(eq(workflowJob.id, jobId), eq(workflowJob.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

/** 列出组织的所有 Job（含工作流名称和创建人） */
export async function listJobs(organizationId: string): Promise<WorkflowJobListItem[]> {
  const rows = await db
    .select({
      job: workflowJob,
      workflowName: workflow.name,
      userName: user.name,
    })
    .from(workflowJob)
    .innerJoin(workflow, eq(workflowJob.workflowId, workflow.id))
    .leftJoin(user, eq(workflowJob.userId, user.id))
    .where(eq(workflowJob.organizationId, organizationId))
    .orderBy(desc(workflowJob.updatedAt));

  return rows.map((r) => ({
    ...r.job,
    workflowName: r.workflowName,
    userName: r.userName ?? null,
  }));
}

/** 更新参数（仅 ready 状态） */
export async function updateJobParams(
  jobId: string,
  organizationId: string,
  params: Record<string, unknown>,
): Promise<boolean> {
  const result = await db
    .update(workflowJob)
    .set({ params, updatedAt: new Date() })
    .where(and(eq(workflowJob.id, jobId), eq(workflowJob.organizationId, organizationId), eq(workflowJob.status, "ready")))
    .returning();
  return result.length > 0;
}

/** 更新 Job 状态 */
export async function updateJobStatus(
  jobId: string,
  organizationId: string,
  data: { status: JobStatus; lastRunId?: string; lastDagStatus?: string; incRunCount?: boolean },
): Promise<boolean> {
  const updates: Record<string, unknown> = { status: data.status, updatedAt: new Date() };
  if (data.lastRunId !== undefined) updates.lastRunId = data.lastRunId;
  if (data.lastDagStatus !== undefined) updates.lastDagStatus = data.lastDagStatus;

  if (data.incRunCount) {
    const result = await db
      .update(workflowJob)
      .set({ ...updates, runCount: sql`${workflowJob.runCount} + 1` })
      .where(and(eq(workflowJob.id, jobId), eq(workflowJob.organizationId, organizationId)))
      .returning();
    return result.length > 0;
  }

  const result = await db
    .update(workflowJob)
    .set(updates)
    .where(and(eq(workflowJob.id, jobId), eq(workflowJob.organizationId, organizationId)))
    .returning();
  return result.length > 0;
}

/** 删除 Job */
export async function deleteJob(jobId: string, organizationId: string): Promise<boolean> {
  const result = await db
    .delete(workflowJob)
    .where(and(eq(workflowJob.id, jobId), eq(workflowJob.organizationId, organizationId)))
    .returning();
  return result.length > 0;
}
```

- [ ] **Step 2: 在 repositories/index.ts 中添加 re-export**

在文件末尾 `resetAllRepos` 函数之前添加：

```typescript
export type { JobStatus, WorkflowJobListItem, WorkflowJobRow } from "./workflow-job";
export {
  createJob,
  deleteJob,
  getJob,
  listJobs,
  updateJobParams,
  updateJobStatus,
} from "./workflow-job";
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: 无类型错误。

- [ ] **Step 4: Commit**

```bash
git add src/repositories/workflow-job.ts src/repositories/index.ts
git commit -m "feat: 添加 workflow-job repository"
```

---

### Task 3: Job Events Service

**Files:**
- Create: `src/services/workflow/workflow-job-events.ts`

复用现有 `EventBus` 基础设施（`transport/event-bus.ts`），为看板提供 per-organization 的事件发布/订阅。

- [ ] **Step 1: 创建 workflow-job-events.ts**

```typescript
/**
 * Per-organization 看板事件总线。
 *
 * 供 workflow-jobs 路由发布 SSE 事件，供 SSE 端点订阅推送。
 * 复用 transport/event-bus 的 EventBus 实例管理。
 */

import { type EventBus, getEventBus, removeEventBus } from "../../transport/event-bus";

/** 看板 SSE 事件类型 */
export type JobEventType =
  | "job.created"
  | "job.started"
  | "job.suspended"
  | "job.completed"
  | "job.deleted"
  | "job.params_updated";

/** 看板 SSE 事件载荷 */
export interface JobEventPayload {
  type: JobEventType;
  jobId: string;
  [key: string]: unknown;
}

/** 生成 organization EventBus 的 key */
function orgBusKey(organizationId: string): string {
  return `kanban:${organizationId}`;
}

/** 获取指定 organization 的看板 EventBus */
export function getKanbanEventBus(organizationId: string): EventBus {
  return getEventBus(orgBusKey(organizationId));
}

/** 发布一个看板 SSE 事件 */
export function publishJobEvent(
  organizationId: string,
  type: JobEventType,
  extra: { jobId: string; [key: string]: unknown },
): void {
  const bus = getKanbanEventBus(organizationId);
  bus.publish({
    id: `job_evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: orgBusKey(organizationId),
    type,
    payload: { type, ...extra },
    direction: "outbound",
  });
}

/** 清理看板 EventBus（防止内存泄漏） */
export function removeKanbanEventBus(organizationId: string): void {
  removeEventBus(orgBusKey(organizationId));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/workflow/workflow-job-events.ts
git commit -m "feat: 添加看板事件服务（workflow-job-events）"
```

---

### Task 4: getParamDefs API

**Files:**
- Modify: `src/routes/web/workflow-defs.ts`

在现有 workflow-defs 路由中新增 `getParamDefs` action，解析工作流 YAML 的 `params` 字段返回参数定义。

- [ ] **Step 1: 在 workflow-defs.ts 的 switch 中添加 getParamDefs case**

在 `default` case 之前（约第 235 行 `default:` 之前）插入：

```typescript
        case "getParamDefs": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number | undefined;
          if (!workflowId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          }

          // 确定 YAML 版本
          let targetVersion = version;
          if (targetVersion === undefined) {
            const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
            if (!wf) return error(404, { error: { type: "NOT_FOUND", message: "Workflow not found" } });
            targetVersion = wf.latestVersion ?? 0;
          }

          const yaml = await getVersionYaml(workflowId, targetVersion);
          if (!yaml) return error(404, { error: { type: "NOT_FOUND", message: "Version not found" } });

          // 解析 YAML 中的 params 字段
          let params: Record<string, unknown> = {};
          try {
            const parsed = await import("yaml").then((m) => m.parse(yaml));
            params = (parsed as Record<string, unknown>)?.params as Record<string, unknown> ?? {};
          } catch {
            // YAML 解析失败，返回空 params
          }

          return { success: true, data: { version: targetVersion, params } };
        }
```

注意：项目已有 `yaml` 依赖（workflow-engine 使用），可以直接 `import("yaml")` 动态解析。

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/routes/web/workflow-defs.ts
git commit -m "feat: 添加 getParamDefs action 到 workflow-defs 路由"
```

---

### Task 5: Job API Route — 基础 CRUD

**Files:**
- Create: `src/routes/web/workflow-jobs.ts`

- [ ] **Step 1: 创建 workflow-jobs.ts 路由（create / list / get / updateParams / delete）**

```typescript
/**
 * Workflow Jobs API 路由。
 *
 * POST /web/workflow-jobs — action 分发，管理看板 Job 的创建、查询、参数编辑、删除。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { createJob, deleteJob, getJob, listJobs, updateJobParams } from "../../repositories/workflow-job";
import { getWorkflowDef } from "../../repositories/workflow-def";
import { publishJobEvent } from "../../services/workflow/workflow-job-events";

const app = new Elysia({ name: "web-workflow-jobs" }).use(authGuardPlugin);

app.post(
  "/workflow-jobs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as Record<string, unknown>;
    const action = payload.action as string;

    try {
      switch (action) {
        // 创建 Job
        case "create": {
          const workflowId = payload.workflowId as string;
          const params = payload.params as Record<string, unknown> | undefined;
          if (!workflowId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          }
          // 查询 workflow 定义获取最新版本
          const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
          if (!wf) return error(404, { error: { type: "NOT_FOUND", message: "Workflow not found" } });
          const version = wf.latestVersion ?? 0;

          const job = await createJob(authCtx.organizationId, authCtx.userId, { workflowId, version, params });
          publishJobEvent(authCtx.organizationId, "job.created", { jobId: job.id });
          return { success: true, data: job };
        }

        // 列出所有 Job
        case "list": {
          const jobs = await listJobs(authCtx.organizationId);
          return { success: true, data: jobs };
        }

        // 获取单个 Job
        case "get": {
          const jobId = payload.jobId as string;
          if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          return { success: true, data: job };
        }

        // 更新参数（仅 ready 状态）
        case "updateParams": {
          const jobId = payload.jobId as string;
          const params = payload.params as Record<string, unknown>;
          if (!jobId || !params) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId and params are required" } });
          }
          const ok = await updateJobParams(jobId, authCtx.organizationId, params);
          if (!ok) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "Job not found or not in ready status" } });
          }
          publishJobEvent(authCtx.organizationId, "job.params_updated", { jobId });
          return { success: true };
        }

        // 删除 Job
        case "delete": {
          const jobId = payload.jobId as string;
          if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          if (job.status === "running" || job.status === "suspended") {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "Cannot delete a running or suspended job" } });
          }
          const deleted = await deleteJob(jobId, authCtx.organizationId);
          if (deleted) publishJobEvent(authCtx.organizationId, "job.deleted", { jobId });
          return { success: true };
        }

        default:
          return error(400, { error: { type: "VALIDATION_ERROR", message: `Unknown action: ${action}` } });
      }
    } catch (err: unknown) {
      console.error("[workflow-jobs] Error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  { sessionAuth: true },
);

export default app;
```

- [ ] **Step 2: 在 src/index.ts 中注册路由**

检查 `src/index.ts` 中 workflow 路由的注册方式（搜索 `workflow-defs` 或 `workflow-engine`），在旁边添加：

```typescript
import workflowJobsRoute from "./routes/web/workflow-jobs";
// 在 .group() 内注册：
.use(workflowJobsRoute)
```

- [ ] **Step 3: 验证编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/workflow-jobs.ts src/index.ts
git commit -m "feat: 添加 workflow-jobs 路由（create/list/get/updateParams/delete）"
```

---

### Task 6: Job API Route — run / cancel / approve / getPendingApprovals

**Files:**
- Modify: `src/routes/web/workflow-jobs.ts`（在 Task 5 的 switch 中添加新 case）

- [ ] **Step 1: 在 workflow-jobs.ts 的 switch 中添加 run / cancel / approve / getPendingApprovals**

在 Task 5 创建的 `delete` case 之后、`default` 之前插入：

```typescript
        // 触发运行
        case "run": {
          const jobId = payload.jobId as string;
          if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          if (job.status !== "ready" && job.status !== "completed") {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "Job must be in ready or completed status" } });
          }

          // 读取绑定版本的 YAML
          const { getVersionYaml } = await import("../../repositories/workflow-def");
          const yaml = await getVersionYaml(job.workflowId, job.version);
          if (!yaml) return error(400, { error: { type: "VALIDATION_ERROR", message: "Workflow YAML not found" } });

          const engine = getTeamEngine(authCtx.organizationId);
          const { runId, result } = engine.runAsync(yaml, (job.params as Record<string, unknown>) ?? undefined);

          // 更新 Job 状态
          const { updateJobStatus } = await import("../../repositories/workflow-job");
          await updateJobStatus(jobId, authCtx.organizationId, {
            status: "running",
            lastRunId: runId,
            incRunCount: true,
          });
          publishJobEvent(authCtx.organizationId, "job.started", { jobId, runId });

          // 后台：监听终态更新 Job
          result.then(
            async (r) => {
              await updateJobStatus(jobId, authCtx.organizationId, {
                status: "completed",
                lastDagStatus: r.status,
              });
              publishJobEvent(authCtx.organizationId, "job.completed", { jobId, runId, dagStatus: r.status });
            },
            async (err) => {
              console.error("[workflow-jobs] run error:", err);
              await updateJobStatus(jobId, authCtx.organizationId, {
                status: "completed",
                lastDagStatus: "ERROR",
              });
              publishJobEvent(authCtx.organizationId, "job.completed", { jobId, runId, dagStatus: "ERROR" });
            },
          );

          return { success: true, data: { runId } };
        }

        // 取消运行
        case "cancel": {
          const jobId = payload.jobId as string;
          if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          if (job.status !== "running" && job.status !== "suspended") {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "Job is not running or suspended" } });
          }

          const engine = getTeamEngine(authCtx.organizationId);
          if (job.lastRunId) await engine.cancel(job.lastRunId);

          const { updateJobStatus } = await import("../../repositories/workflow-job");
          await updateJobStatus(jobId, authCtx.organizationId, {
            status: "completed",
            lastDagStatus: "CANCELLED",
          });
          publishJobEvent(authCtx.organizationId, "job.completed", { jobId, dagStatus: "CANCELLED" });
          return { success: true };
        }

        // 获取待审批节点
        case "getPendingApprovals": {
          const jobId = payload.jobId as string;
          if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          if (!job.lastRunId) return { success: true, data: [] };

          const engine = getTeamEngine(authCtx.organizationId);
          const approvals = await engine.getPendingApprovals(job.lastRunId);
          return { success: true, data: approvals };
        }

        // 审批通过
        case "approve": {
          const jobId = payload.jobId as string;
          const nodeId = payload.nodeId as string;
          const token = payload.token as string;
          const approveData = payload.data as unknown;
          if (!jobId || !nodeId || !token) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId, nodeId and token are required" } });
          }
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          if (job.status !== "suspended") {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "Job is not suspended" } });
          }

          const engine = getTeamEngine(authCtx.organizationId);
          await engine.approveNode(job.lastRunId!, nodeId, token, approveData);

          const { updateJobStatus } = await import("../../repositories/workflow-job");
          await updateJobStatus(jobId, authCtx.organizationId, { status: "running" });
          publishJobEvent(authCtx.organizationId, "job.started", { jobId });
          return { success: true };
        }
```

注意：文件顶部需要添加 `import { getTeamEngine } from "../../services/workflow";`。

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/routes/web/workflow-jobs.ts
git commit -m "feat: 添加 workflow-jobs run/cancel/approve/getPendingApprovals"
```

---

### Task 7: Job SSE 端点

**Files:**
- Create: `src/routes/web/workflow-jobs-sse.ts`
- Modify: `src/index.ts`（注册路由）

- [ ] **Step 1: 创建 workflow-jobs-sse.ts**

复用现有 `workflow-sse.ts` 的模式（EventSource + EventBus 订阅 + Last-Event-ID 断线重连）。

```typescript
/**
 * 看板 SSE 实时事件流端点。
 *
 * GET /web/workflow-jobs/events — 前端通过 EventSource 订阅，
 * 接收当前组织所有 Job 的状态变更事件。
 * 支持 Last-Event-ID / fromSeqNum 断线重连。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { getKanbanEventBus } from "../../services/workflow/workflow-job-events";

const app = new Elysia({ name: "web-workflow-jobs-sse" }).use(authGuardPlugin);

app.get(
  "/workflow-jobs/events",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ request, query, error, store }: any) => {
    const authCtx = store.authContext;
    if (!authCtx) {
      return error(401, { error: { type: "UNAUTHORIZED", message: "No auth context" } });
    }

    const bus = getKanbanEventBus(authCtx.organizationId);

    const lastEventId = request.headers.get("Last-Event-ID");
    const fromSeq = (query as Record<string, unknown>)?.fromSeqNum;
    const fromSeqNum = fromSeq ? Number(fromSeq) : lastEventId ? Number(lastEventId) : 0;

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": keepalive\n\n"));

        // 回放历史事件
        if (fromSeqNum > 0) {
          const missed = bus.getEventsSince(fromSeqNum);
          for (const event of missed) {
            const data = JSON.stringify(event.payload);
            controller.enqueue(encoder.encode(`id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`));
          }
        }

        // 订阅新事件
        const unsub = bus.subscribe((event) => {
          try {
            const data = JSON.stringify(event.payload);
            controller.enqueue(encoder.encode(`id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`));
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

- [ ] **Step 2: 在 src/index.ts 中注册路由**

```typescript
import workflowJobsSseRoute from "./routes/web/workflow-jobs-sse";
// 在 .group() 内注册：
.use(workflowJobsSseRoute)
```

- [ ] **Step 3: 验证编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/workflow-jobs-sse.ts src/index.ts
git commit -m "feat: 添加看板 SSE 端点"
```

---

### Task 8: SUSPENDED 状态检测

**Files:**
- Modify: `src/routes/web/workflow-jobs.ts`（run case 中添加 SUSPENDED 监听）

当前 run case 的 `result.then` 只处理终态。需要额外监听引擎事件流中的 `audit.requested` 事件来检测 SUSPENDED 状态。

- [ ] **Step 1: 在 run case 的 `engine.runAsync()` 之后、`result.then()` 之前添加 SUSPENDED 监听**

在 run case 中，`publishJobEvent(authCtx.organizationId, "job.started", ...)` 之后插入：

```typescript
          // 监听 SUSPENDED 状态（轮询快照，间隔 2 秒）
          const suspendedCheck = setInterval(async () => {
            try {
              const snapshot = await engine.getRunStatus(runId);
              if (snapshot?.dag_status === "SUSPENDED") {
                clearInterval(suspendedCheck);
                await updateJobStatus(jobId, authCtx.organizationId, { status: "suspended" });
                publishJobEvent(authCtx.organizationId, "job.suspended", { jobId, runId });
              }
            } catch {
              // snapshot 可能还未就绪，忽略
            }
          }, 2000);

          // run 完成后清除轮询
          result.finally(() => clearInterval(suspendedCheck));
```

注意：这是简洁的轮询方案。`updateJobStatus` 已在文件顶部 import 过，无需再动态 import。

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/routes/web/workflow-jobs.ts
git commit -m "feat: 添加 SUSPENDED 状态检测（轮询快照）"
```

---

### Task 9: 前端 i18n

**Files:**
- Create: `web/src/i18n/locales/en/kanban.json`
- Create: `web/src/i18n/locales/zh/kanban.json`
- Modify: `web/src/i18n/index.ts`

- [ ] **Step 1: 创建英文翻译文件**

`web/src/i18n/locales/en/kanban.json`:

```json
{
  "title": "Kanban",
  "tab_label": "Kanban",
  "col_ready": "Ready",
  "col_running": "Running",
  "col_suspended": "Pending Approval",
  "col_completed": "Completed",
  "status_ready": "Ready",
  "status_running": "Running",
  "status_suspended": "Awaiting Approval",
  "status_success": "Success",
  "status_failed": "Failed",
  "status_cancelled": "Cancelled",
  "status_error": "Error",
  "params_summary": "Params: {{summary}}",
  "no_params": "No params",
  "card_run": "Run",
  "card_edit_params": "Edit Params",
  "card_delete": "Delete",
  "card_cancel": "Cancel",
  "card_rerun": "Rerun",
  "card_approve": "Approve",
  "card_view_details": "View Details",
  "card_created_by": "Created by {{name}}",
  "card_relative_now": "just now",
  "card_relative_minutes": "{{count}}m ago",
  "card_relative_hours": "{{count}}h ago",
  "card_relative_days": "{{count}}d ago",
  "card_progress": "{{completed}}/{{total}}",
  "card_duration": "{{duration}}",
  "card_run_count": "Run {{count}} times",
  "completed_show_more": "Show more ({{count}})",
  "completed_show_less": "Show less",
  "dialog_create_title": "Create Job",
  "dialog_edit_title": "Edit Params",
  "dialog_select_workflow": "Select Workflow",
  "dialog_select_workflow_placeholder": "Choose a workflow...",
  "dialog_version_label": "Version",
  "dialog_version_auto": "Latest published (v{{version}})",
  "dialog_version_draft": "Draft",
  "dialog_params_title": "Params",
  "dialog_no_params": "This workflow has no parameters.",
  "dialog_param_required": "Required",
  "dialog_cancel": "Cancel",
  "dialog_create": "Create",
  "dialog_save": "Save",
  "dialog_creating": "Creating...",
  "dialog_saving": "Saving...",
  "dialog_load_params_failed": "Failed to load params",
  "dialog_create_failed": "Create failed",
  "dialog_save_failed": "Save failed",
  "empty_ready": "No jobs ready",
  "empty_running": "No jobs running",
  "empty_suspended": "No jobs awaiting approval",
  "empty_completed": "No completed jobs",
  "delete_confirm": "Delete this job?",
  "delete_failed": "Delete failed",
  "run_failed": "Run failed",
  "cancel_failed": "Cancel failed",
  "approve_failed": "Approve failed",
  "load_failed": "Load failed: {{error}}",
  "add_to_kanban": "Add to Kanban",
  "refresh": "Refresh"
}
```

- [ ] **Step 2: 创建中文翻译文件**

`web/src/i18n/locales/zh/kanban.json`:

```json
{
  "title": "看板",
  "tab_label": "看板",
  "col_ready": "准备运行",
  "col_running": "运行中",
  "col_suspended": "待审批",
  "col_completed": "已完成",
  "status_ready": "就绪",
  "status_running": "运行中",
  "status_suspended": "等待审批",
  "status_success": "成功",
  "status_failed": "失败",
  "status_cancelled": "已取消",
  "status_error": "错误",
  "params_summary": "参数: {{summary}}",
  "no_params": "无参数",
  "card_run": "运行",
  "card_edit_params": "编辑参数",
  "card_delete": "删除",
  "card_cancel": "取消运行",
  "card_rerun": "重新运行",
  "card_approve": "通过",
  "card_view_details": "查看详情",
  "card_created_by": "由 {{name}} 创建",
  "card_relative_now": "刚刚",
  "card_relative_minutes": "{{count}} 分钟前",
  "card_relative_hours": "{{count}} 小时前",
  "card_relative_days": "{{count}} 天前",
  "card_progress": "{{completed}}/{{total}}",
  "card_duration": "{{duration}}",
  "card_run_count": "已运行 {{count}} 次",
  "completed_show_more": "查看更多（{{count}}）",
  "completed_show_less": "收起",
  "dialog_create_title": "创建任务",
  "dialog_edit_title": "编辑参数",
  "dialog_select_workflow": "选择工作流",
  "dialog_select_workflow_placeholder": "选择一个工作流...",
  "dialog_version_label": "版本",
  "dialog_version_auto": "最新发布版（v{{version}}）",
  "dialog_version_draft": "草稿",
  "dialog_params_title": "参数",
  "dialog_no_params": "该工作流没有参数。",
  "dialog_param_required": "必填",
  "dialog_cancel": "取消",
  "dialog_create": "创建",
  "dialog_save": "保存",
  "dialog_creating": "创建中...",
  "dialog_saving": "保存中...",
  "dialog_load_params_failed": "加载参数失败",
  "dialog_create_failed": "创建失败",
  "dialog_save_failed": "保存失败",
  "empty_ready": "暂无准备运行的任务",
  "empty_running": "暂无运行中的任务",
  "empty_suspended": "暂无待审批的任务",
  "empty_completed": "暂无已完成的任务",
  "delete_confirm": "确定删除该任务？",
  "delete_failed": "删除失败",
  "run_failed": "运行失败",
  "cancel_failed": "取消失败",
  "approve_failed": "审批失败",
  "load_failed": "加载失败: {{error}}",
  "add_to_kanban": "添加到看板",
  "refresh": "刷新"
}
```

- [ ] **Step 3: 在 i18n/index.ts 中注册 kanban 命名空间**

1. 添加 import（在其他 import 旁边）：

```typescript
import kanbanEN from "./locales/en/kanban.json";
import kanbanZH from "./locales/zh/kanban.json";
```

2. 在 `NS` 常量中添加：

```typescript
KANBAN: "kanban",
```

3. 在 `resources.en` 和 `resources.zh` 中添加：

```typescript
[NS.KANBAN]: kanbanEN,
// zh 中
[NS.KANBAN]: kanbanZH,
```

4. 在 `ns` 数组中添加 `NS.KANBAN`。

- [ ] **Step 4: Commit**

```bash
git add web/src/i18n/
git commit -m "feat: 添加 kanban i18n 翻译（中英双语）"
```

---

### Task 10: 前端 API 客户端

**Files:**
- Create: `web/src/api/workflow-jobs.ts`

- [ ] **Step 1: 创建 workflow-jobs.ts API 客户端**

```typescript
/**
 * Workflow Jobs API Client。
 *
 * 对接后端 POST /web/workflow-jobs，通过 action 字段分发。
 * 对接 GET /web/workflow-jobs/events SSE 端点。
 */

// ── 类型 ──

export type JobStatus = "ready" | "running" | "suspended" | "completed";
export type DagStatus = "SUCCESS" | "FAILED" | "CANCELLED" | "ERROR";

export interface WorkflowJob {
  id: string;
  organizationId: string;
  userId: string;
  workflowId: string;
  version: number;
  params: Record<string, unknown> | null;
  status: JobStatus;
  lastRunId: string | null;
  lastDagStatus: DagStatus | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  // list 附加字段
  workflowName?: string;
  userName?: string | null;
}

export interface JobEventPayload {
  type: string;
  jobId: string;
  [key: string]: unknown;
}

export interface PendingApproval {
  runId: string;
  nodeId: string;
  approvalToken: string;
  expiresAt: string;
  displayData?: unknown;
}

// ── helpers ──

async function postAction(action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch("/web/workflow-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action, ...extra }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Unknown error");
  return json.data;
}

// ── API ──

export const workflowJobsApi = {
  /** 创建 Job */
  async create(workflowId: string, params?: Record<string, unknown>): Promise<WorkflowJob> {
    return postAction("create", { workflowId, params }) as Promise<WorkflowJob>;
  },

  /** 列出所有 Job */
  async list(): Promise<WorkflowJob[]> {
    const data = await postAction("list");
    return Array.isArray(data) ? data : [];
  },

  /** 获取单个 Job */
  async get(jobId: string): Promise<WorkflowJob> {
    return postAction("get", { jobId }) as Promise<WorkflowJob>;
  },

  /** 更新参数 */
  async updateParams(jobId: string, params: Record<string, unknown>): Promise<void> {
    await postAction("updateParams", { jobId, params });
  },

  /** 触发运行 */
  async run(jobId: string): Promise<{ runId: string }> {
    return postAction("run", { jobId }) as Promise<{ runId: string }>;
  },

  /** 取消运行 */
  async cancel(jobId: string): Promise<void> {
    await postAction("cancel", { jobId });
  },

  /** 获取待审批节点 */
  async getPendingApprovals(jobId: string): Promise<PendingApproval[]> {
    const data = await postAction("getPendingApprovals", { jobId });
    return Array.isArray(data) ? data : [];
  },

  /** 审批通过 */
  async approve(jobId: string, nodeId: string, token: string, data?: unknown): Promise<void> {
    await postAction("approve", { jobId, nodeId, token, data });
  },

  /** 删除 Job */
  async delete(jobId: string): Promise<void> {
    await postAction("delete", { jobId });
  },

  /** 创建 SSE 连接 */
  createEventSource(): EventSource {
    return new EventSource("/web/workflow-jobs/events");
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add web/src/api/workflow-jobs.ts
git commit -m "feat: 添加前端 workflow-jobs API 客户端"
```

---

### Task 11: KanbanColumn + KanbanCard 组件

**Files:**
- Create: `web/src/pages/workflow/components/KanbanColumn.tsx`
- Create: `web/src/pages/workflow/components/KanbanCard.tsx`

- [ ] **Step 1: 创建 KanbanCard.tsx**

卡片组件，根据 Job 状态展示不同信息和操作按钮。

```tsx
import { CheckCircle2, Circle, Clock, Loader2, MoreHorizontal, Pause, Play, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { DagStatus, JobStatus, WorkflowJob } from "../../../api/workflow-jobs";
import { workflowJobsApi } from "../../../api/workflow-jobs";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

interface KanbanCardProps {
  job: WorkflowJob;
  onRefresh: () => void;
  onEditParams: (job: WorkflowJob) => void;
}

const STATUS_STYLES: Record<string, { dot: string; color: string; bg: string }> = {
  ready: { dot: "bg-slate-400", color: "text-slate-600", bg: "bg-slate-50" },
  running: { dot: "bg-blue-500 animate-pulse", color: "text-blue-600", bg: "bg-blue-50" },
  suspended: { dot: "bg-amber-500", color: "text-amber-600", bg: "bg-amber-50" },
};

function dagStatusStyle(status: DagStatus) {
  if (status === "SUCCESS") return { dot: "bg-emerald-500", color: "text-emerald-600", bg: "bg-emerald-50" };
  return { dot: "bg-red-500", color: "text-red-600", bg: "bg-red-50" };
}

function relativeTime(iso: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t("card_relative_now");
  if (diff < 3600) return t("card_relative_minutes", { count: Math.floor(diff / 60) });
  if (diff < 86400) return t("card_relative_days", { count: Math.floor(diff / 86400) });
  return t("card_relative_hours", { count: Math.floor(diff / 3600) });
}

function paramsSummary(params: Record<string, unknown> | null, t: (k: string) => string): string {
  if (!params || Object.keys(params).length === 0) return t("no_params");
  const entries = Object.entries(params)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${String(v).substring(0, 15)}`)
    .join(", ");
  const remaining = Object.keys(params).length - 2;
  return remaining > 0 ? `${entries} +${remaining}` : entries;
}

export function KanbanCard({ job, onRefresh, onEditParams }: KanbanCardProps) {
  const { t } = useTranslation("kanban");
  const [loading, setLoading] = useState(false);

  const isTerminal = job.status === "completed";
  const style = isTerminal ? dagStatusStyle(job.lastDagStatus ?? "FAILED") : STATUS_STYLES[job.status] ?? STATUS_STYLES.ready;

  const handleAction = async (action: () => Promise<void>) => {
    setLoading(true);
    try {
      await action();
      onRefresh();
    } catch (err) {
      console.error(err);
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const statusLabel = isTerminal
    ? t(`status_${(job.lastDagStatus ?? "failed").toLowerCase()}`)
    : t(`status_${job.status}`);

  return (
    <div className={`rounded-lg border p-3 text-xs space-y-1.5 transition-shadow hover:shadow-sm ${style.bg}`}>
      {/* 标题行 */}
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-text-primary truncate text-[13px]">{job.workflowName ?? job.workflowId}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="p-0.5 rounded hover:bg-black/5 flex-shrink-0" disabled={loading}>
              <MoreHorizontal size={14} className="text-text-secondary" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[120px]">
            {job.status === "ready" && (
              <>
                <DropdownMenuItem onClick={() => handleAction(() => workflowJobsApi.run(job.id))}>
                  <Play size={13} className="mr-1.5" /> {t("card_run")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onEditParams(job)}>
                  <Clock size={13} className="mr-1.5" /> {t("card_edit_params")}
                </DropdownMenuItem>
              </>
            )}
            {job.status === "running" && (
              <DropdownMenuItem onClick={() => handleAction(() => workflowJobsApi.cancel(job.id))}>
                <Pause size={13} className="mr-1.5" /> {t("card_cancel")}
              </DropdownMenuItem>
            )}
            {job.status === "suspended" && (
              <DropdownMenuItem
                onClick={() =>
                  handleAction(async () => {
                    const approvals = await workflowJobsApi.getPendingApprovals(job.id);
                    if (approvals.length > 0) {
                      await workflowJobsApi.approve(job.id, approvals[0].nodeId, approvals[0].approvalToken);
                    }
                  })
                }
              >
                <CheckCircle2 size={13} className="mr-1.5" /> {t("card_approve")}
              </DropdownMenuItem>
            )}
            {job.status === "completed" && (
              <DropdownMenuItem onClick={() => handleAction(() => workflowJobsApi.run(job.id))}>
                <Play size={13} className="mr-1.5" /> {t("card_rerun")}
              </DropdownMenuItem>
            )}
            {(job.status === "ready" || job.status === "completed") && (
              <DropdownMenuItem className="text-red-600" onClick={() => handleAction(() => workflowJobsApi.delete(job.id))}>
                <Trash2 size={13} className="mr-1.5" /> {t("card_delete")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 参数摘要 */}
      <div className="text-text-secondary truncate" title={paramsSummary(job.params, t)}>
        {paramsSummary(job.params, t)}
      </div>

      {/* 状态行 */}
      <div className={`flex items-center gap-1.5 font-medium ${style.color}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
        {statusLabel}
        {(job.status === "running" || job.status === "suspended") && loading && (
          <Loader2 size={12} className="animate-spin ml-1" />
        )}
      </div>

      {/* 底部元信息 */}
      <div className="text-text-secondary flex items-center gap-1">
        {job.userName && <span>{t("card_created_by", { name: job.userName })}</span>}
        <span>·</span>
        <span>{relativeTime(job.createdAt, t)}</span>
        {job.runCount > 1 && (
          <>
            <span>·</span>
            <span>{t("card_run_count", { count: job.runCount })}</span>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 创建 KanbanColumn.tsx**

```tsx
import { useTranslation } from "react-i18next";
import { Inbox } from "lucide-react";
import type { WorkflowJob } from "../../../api/workflow-jobs";
import { KanbanCard } from "./KanbanCard";

interface KanbanColumnProps {
  titleKey: string;
  jobs: WorkflowJob[];
  onRefresh: () => void;
  onEditParams: (job: WorkflowJob) => void;
  defaultLimit?: number;
}

export function KanbanColumn({ titleKey, jobs, onRefresh, onEditParams, defaultLimit }: KanbanColumnProps) {
  const { t } = useTranslation("kanban");
  const hasLimit = defaultLimit !== undefined;

  return (
    <div className="flex flex-col min-w-[260px] flex-1 border-r last:border-r-0">
      {/* 列头 */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-surface-base flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-primary">{t(titleKey)}</span>
          <span className="text-[10px] font-medium text-text-secondary bg-surface-hover rounded-full px-1.5 py-0.5">
            {jobs.length}
          </span>
        </div>
      </div>

      {/* 卡片列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-muted">
            <Inbox size={24} className="mb-1.5" />
            <span className="text-[11px]">{t(`empty_${titleKey.replace("col_", "")}`)}</span>
          </div>
        ) : (
          jobs.map((job) => (
            <KanbanCard key={job.id} job={job} onRefresh={onRefresh} onEditParams={onEditParams} />
          ))
        )}
      </div>
    </div>
  );
}
```

注意：完成列的折叠逻辑在 `WorkflowKanban` 主组件中处理（通过 `useState` 控制 `showAllCompleted`），传给 `KanbanColumn` 的 `jobs` 已经是裁剪后的数组。

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/workflow/components/KanbanCard.tsx web/src/pages/workflow/components/KanbanColumn.tsx
git commit -m "feat: 添加 KanbanCard 和 KanbanColumn 组件"
```

---

### Task 12: WorkflowKanban 主组件

**Files:**
- Create: `web/src/pages/workflow/WorkflowKanban.tsx`

- [ ] **Step 1: 创建 WorkflowKanban.tsx**

看板主组件：加载 Job 列表，按状态分组到四列，SSE 实时更新，完成列折叠。

```tsx
import { Loader, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowJob } from "../../api/workflow-jobs";
import { workflowJobsApi } from "../../api/workflow-jobs";
import { KanbanColumn } from "./components/KanbanColumn";
import { KanbanJobDialog } from "./components/KanbanJobDialog";

const COMPLETED_COLLAPSE_LIMIT = 10;

export function WorkflowKanban() {
  const { t } = useTranslation("kanban");
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editJob, setEditJob] = useState<WorkflowJob | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await workflowJobsApi.list();
      setJobs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // SSE 实时更新
  useEffect(() => {
    const es = workflowJobsApi.createEventSource();
    es.onmessage = () => {
      loadJobs();
    };
    es.onerror = () => {
      // 自动重连由 EventSource 处理
    };
    return () => es.close();
  }, [loadJobs]);

  // 按状态分组
  const grouped = useMemo(() => {
    const ready = jobs.filter((j) => j.status === "ready");
    const running = jobs.filter((j) => j.status === "running");
    const suspended = jobs.filter((j) => j.status === "suspended");
    const completed = jobs.filter((j) => j.status === "completed");
    return { ready, running, suspended, completed };
  }, [jobs]);

  const completedToShow = showAllCompleted ? grouped.completed : grouped.completed.slice(0, COMPLETED_COLLAPSE_LIMIT);
  const hasMoreCompleted = grouped.completed.length > COMPLETED_COLLAPSE_LIMIT;

  const handleEditParams = useCallback((job: WorkflowJob) => {
    setEditJob(job);
    setDialogOpen(true);
  }, []);

  const handleDialogClose = useCallback(() => {
    setDialogOpen(false);
    setEditJob(null);
  }, []);

  if (loading && jobs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader className="h-6 w-6 animate-spin text-text-secondary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-text-secondary text-sm p-6">
        {t("load_failed", { error })}
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-surface-base flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setEditJob(null);
              setDialogOpen(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand-dark transition-colors"
          >
            + {t("dialog_create_title")}
          </button>
        </div>
        <button
          type="button"
          onClick={loadJobs}
          className="flex items-center gap-1 px-2 py-1 rounded-md border border-border text-text-secondary text-xs hover:bg-surface-hover transition-colors"
        >
          <RefreshCw size={12} /> {t("refresh")}
        </button>
      </div>

      {/* 四列看板 */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <KanbanColumn titleKey="col_ready" jobs={grouped.ready} onRefresh={loadJobs} onEditParams={handleEditParams} />
        <KanbanColumn titleKey="col_running" jobs={grouped.running} onRefresh={loadJobs} onEditParams={handleEditParams} />
        <KanbanColumn
          titleKey="col_suspended"
          jobs={grouped.suspended}
          onRefresh={loadJobs}
          onEditParams={handleEditParams}
        />
        <div className="flex flex-col min-w-[260px] flex-1">
          <KanbanColumn
            titleKey="col_completed"
            jobs={completedToShow}
            onRefresh={loadJobs}
            onEditParams={handleEditParams}
          />
          {hasMoreCompleted && !showAllCompleted && (
            <button
              type="button"
              onClick={() => setShowAllCompleted(true)}
              className="text-xs text-brand hover:underline py-2 text-center flex-shrink-0"
            >
              {t("completed_show_more", { count: grouped.completed.length - COMPLETED_COLLAPSE_LIMIT })}
            </button>
          )}
          {showAllCompleted && hasMoreCompleted && (
            <button
              type="button"
              onClick={() => setShowAllCompleted(false)}
              className="text-xs text-brand hover:underline py-2 text-center flex-shrink-0"
            >
              {t("completed_show_less")}
            </button>
          )}
        </div>
      </div>

      {/* 创建/编辑对话框 */}
      <KanbanJobDialog open={dialogOpen} onClose={handleDialogClose} editJob={editJob} onRefresh={loadJobs} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/WorkflowKanban.tsx
git commit -m "feat: 添加 WorkflowKanban 主组件"
```

---

### Task 13: KanbanJobDialog 组件

**Files:**
- Create: `web/src/pages/workflow/components/KanbanJobDialog.tsx`

- [ ] **Step 1: 创建 KanbanJobDialog.tsx**

创建/编辑 Job 的对话框：选择工作流 → 加载参数定义 → 动态渲染表单。

```tsx
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { WorkflowJob } from "../../../api/workflow-jobs";
import { workflowJobsApi } from "../../../api/workflow-jobs";
import { workflowDefApi } from "../../../api/sdk";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ParamDef {
  type?: "string" | "number" | "boolean" | "object";
  default?: unknown;
  required?: boolean;
}

interface WorkflowOption {
  id: string;
  name: string;
  description?: string | null;
}

interface KanbanJobDialogProps {
  open: boolean;
  onClose: () => void;
  editJob: WorkflowJob | null;
  onRefresh: () => void;
}

export function KanbanJobDialog({ open, onClose, editJob, onRefresh }: KanbanJobDialogProps) {
  const { t } = useTranslation("kanban");
  const isEdit = !!editJob;

  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [paramDefs, setParamDefs] = useState<Record<string, ParamDef>>({});
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const [loadingParams, setLoadingParams] = useState(false);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState<number | null>(null);

  // 加载工作流列表
  useEffect(() => {
    if (!open) return;
    workflowDefApi
      .list()
      .then(({ data, error }) => {
        if (error) throw new Error(error.message);
        setWorkflows(
          (data ?? []).map((wf: Record<string, unknown>) => ({
            id: wf.id as string,
            name: wf.name as string,
            description: wf.description as string | null,
          })),
        );
      })
      .catch((err) => {
        console.error(err);
        toast.error(t("load_failed", { error: err.message }));
      });
  }, [open, t]);

  // 编辑模式：预填参数
  useEffect(() => {
    if (editJob) {
      setSelectedId(editJob.workflowId);
      setParamValues(editJob.params ?? {});
      setVersion(editJob.version);
    } else {
      setSelectedId("");
      setParamValues({});
      setVersion(null);
    }
  }, [editJob]);

  // 选择工作流后加载参数定义
  useEffect(() => {
    if (!selectedId || isEdit) return;
    setLoadingParams(true);
    setParamDefs({});
    setParamValues({});

    const loadParams = async () => {
      try {
        const res = await fetch("/web/workflow-defs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action: "getParamDefs", workflowId: selectedId }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error?.message ?? "Failed");
        const result = json.data;
        setParamDefs(result.params ?? {});
        setVersion(result.version);
        // 预填默认值
        const defaults: Record<string, unknown> = {};
        for (const [key, def] of Object.entries(result.params ?? {})) {
          if ((def as ParamDef).default !== undefined) defaults[key] = (def as ParamDef).default;
        }
        setParamValues(defaults);
      } catch (err) {
        console.error(err);
        toast.error(t("dialog_load_params_failed"));
      } finally {
        setLoadingParams(false);
      }
    };
    loadParams();
  }, [selectedId, isEdit, t]);

  const handleSubmit = useCallback(async () => {
    setSaving(true);
    try {
      if (isEdit) {
        await workflowJobsApi.updateParams(editJob.id, paramValues);
        toast.success(t("dialog_save"));
      } else {
        await workflowJobsApi.create(selectedId, paramValues);
        toast.success(t("dialog_create"));
      }
      onRefresh();
      onClose();
    } catch (err) {
      console.error(err);
      toast.error(isEdit ? t("dialog_save_failed") : t("dialog_create_failed"));
    } finally {
      setSaving(false);
    }
  }, [editJob, isEdit, selectedId, paramValues, onRefresh, onClose, t]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("dialog_edit_title") : t("dialog_create_title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* 选择工作流 */}
          {!isEdit && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t("dialog_select_workflow")}</Label>
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
              >
                <option value="">{t("dialog_select_workflow_placeholder")}</option>
                {workflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>
                    {wf.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 版本信息 */}
          {version !== null && (
            <div className="text-xs text-text-secondary">
              {t("dialog_version_label")}: v{version}
            </div>
          )}

          {/* 加载中 */}
          {loadingParams && (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={14} className="animate-spin" /> {t("dialog_load_params_failed")}
            </div>
          )}

          {/* 参数表单 */}
          {!loadingParams && Object.keys(paramDefs).length > 0 && (
            <div className="space-y-3">
              <div className="text-xs font-medium text-text-primary">{t("dialog_params_title")}</div>
              {Object.entries(paramDefs).map(([key, def]) => (
                <div key={key} className="space-y-1">
                  <Label className="text-xs flex items-center gap-1">
                    {key}
                    {def.required && <span className="text-red-500">*</span>}
                  </Label>
                  {def.type === "boolean" ? (
                    <input
                      type="checkbox"
                      checked={!!paramValues[key]}
                      onChange={(e) => setParamValues((v) => ({ ...v, [key]: e.target.checked }))}
                      className="rounded"
                    />
                  ) : (
                    <Input
                      type={def.type === "number" ? "number" : "text"}
                      value={String(paramValues[key] ?? "")}
                      onChange={(e) =>
                        setParamValues((v) => ({
                          ...v,
                          [key]: def.type === "number" ? Number(e.target.value) : e.target.value,
                        }))
                      }
                      className="h-8 text-sm"
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {!loadingParams && selectedId && Object.keys(paramDefs).length === 0 && (
            <div className="text-xs text-text-secondary">{t("dialog_no_params")}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("dialog_cancel")}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving || (!isEdit && !selectedId)}>
            {saving ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
            {isEdit ? t("dialog_save") : t("dialog_create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/components/KanbanJobDialog.tsx
git commit -m "feat: 添加 KanbanJobDialog 创建/编辑对话框组件"
```

---

### Task 14: 路由集成 + WorkflowList 快捷入口

**Files:**
- Modify: `web/src/routes/agent/_panel/workflow.tsx`（新增 Kanban tab）
- Modify: `web/src/pages/workflow/WorkflowList.tsx`（添加「添加到看板」按钮）

- [ ] **Step 1: 修改 workflow.tsx 路由，添加第三个 tab**

在现有文件中：
1. 新增 lazy import：

```typescript
const WorkflowKanban = lazy(() =>
  import("../../../pages/workflow/WorkflowKanban").then((m) => ({ default: m.WorkflowKanban })),
);
```

2. 导入 `KanbanSquare` 图标：

```typescript
import { History, KanbanSquare, Loader, Pencil } from "lucide-react";
```

3. 在 `tabs` 数组中添加第三个 tab（放在 Workflows 和 Runs 之间）：

```typescript
const tabs = [
  { id: "list" as const, label: t("page.tab_workflows"), icon: Pencil },
  { id: "kanban" as const, label: t("page.tab_kanban"), icon: KanbanSquare },
  { id: "runs" as const, label: t("page.tab_runs"), icon: History },
];
```

4. 更新 `activeTab` 解析逻辑：

```typescript
const activeTab = search.tab === "runs" ? "runs" : search.tab === "kanban" ? "kanban" : "list";
```

5. 在 JSX 中添加 Kanban 渲染分支（在 `activeTab === "list"` 和 `activeTab === "runs"` 之间）：

```tsx
{activeTab === "kanban" ? (
  <WorkflowKanban />
) : activeTab === "list" ? (
```

6. 更新 tab 的 search 参数逻辑，kanban 不需要额外 search：

```tsx
search={tab.id === "runs" ? { tab: "runs" } : tab.id === "kanban" ? { tab: "kanban" } : {}}
```

- [ ] **Step 2: 在 i18n workflows.json 中添加 tab_kanban 翻译 key**

英文 `web/src/i18n/locales/en/workflows.json` 的 `page` 部分添加：

```json
"tab_kanban": "Kanban"
```

中文 `web/src/i18n/locales/zh/workflows.json` 的 `page` 部分添加：

```json
"tab_kanban": "看板"
```

- [ ] **Step 3: 在 WorkflowList.tsx 添加「添加到看板」按钮**

在每行的操作区域（通常在版本历史/删除按钮旁），添加一个 `KanbanSquare` 图标按钮：

```tsx
import { KanbanSquare } from "lucide-react";
```

在行操作按钮区域添加：

```tsx
<button
  type="button"
  title={t("list:add_to_kanban")}
  onClick={() => {
    navigate({ to: "/agent/workflow", search: { tab: "kanban" } });
  }}
  className="..."
>
  <KanbanSquare size={14} />
</button>
```

注意：`navigate` 需要使用 `useNavigate()` 钩子。具体样式参考行内其他按钮。

- [ ] **Step 4: 验证编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/agent/_panel/workflow.tsx web/src/pages/workflow/WorkflowList.tsx web/src/i18n/
git commit -m "feat: 集成 Kanban tab 和 WorkflowList 快捷入口"
```

---

## Precheck 验证

完成所有任务后，运行完整检查：

```bash
bun run precheck
```

确保格式化、import 排序、tsc 类型检查和 biome lint 全部通过。如有问题修复后重新提交。

