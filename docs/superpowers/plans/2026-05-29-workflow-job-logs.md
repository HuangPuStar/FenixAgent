# Workflow Job Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time log viewing to workflow kanban cards — clicking a running/completed job opens a right-side Sheet showing per-node status and stdout output.

**Architecture:** New SSE endpoint streams DAG node events per-job. New `getOutputs` action fetches node stdout. Frontend `JobLogsSheet` component subscribes to SSE, polls stdout for running nodes, renders terminal-style log output.

**Tech Stack:** Elysia SSE, Drizzle ORM (workflowEvent + workflowNodeOutput tables), shadcn Sheet, EventSource API.

**Spec:** `docs/superpowers/specs/2026-05-29-workflow-job-logs-design.md`

---

## File Structure

### Backend — New Files

| File | Responsibility |
|------|---------------|
| `src/routes/web/workflow-jobs-logs.ts` | SSE endpoint for per-job DAG node events |

### Backend — Modified Files

| File | Change |
|------|--------|
| `src/routes/web/workflow-jobs.ts` | Add `getOutputs` action to switch |
| `src/routes/web/index.ts` | Register new SSE route |

### Frontend — New Files

| File | Responsibility |
|------|---------------|
| `web/src/pages/workflow/components/JobLogsSheet.tsx` | Log viewer Sheet component |
| `web/src/api/workflow-job-logs.ts` | Logs SSE client + getOutputs API |

### Frontend — Modified Files

| File | Change |
|------|--------|
| `web/src/pages/workflow/components/KanbanCard.tsx` | Add "View Logs" dropdown menu item |
| `web/src/pages/workflow/components/KanbanColumn.tsx` | Pass `onViewLogs` callback through |
| `web/src/pages/workflow/WorkflowKanban.tsx` | Manage logs sheet state |
| `web/src/i18n/locales/en/kanban.json` | Logs-related English keys |
| `web/src/i18n/locales/zh/kanban.json` | Logs-related Chinese keys |
| `web/components/ui/sheet.tsx` | Generate via shadcn if missing |

---

## Task 1: Add `getOutputs` action to workflow-jobs route

**Files:**
- Modify: `src/routes/web/workflow-jobs.ts`

- [ ] **Step 1: Add `getOutputs` case to the switch statement**

Add before the `default:` case:

```typescript
        // 获取节点输出
        case "getOutputs": {
          const jobId = payload.jobId as string;
          if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          if (!job.lastRunId) return { success: true, data: [] };

          const storage = createPgStorageAdapter(authCtx.organizationId);
          const engine = getTeamEngine(authCtx.organizationId);

          // 获取所有事件以提取节点 ID 列表
          const events = await storage.getEvents(job.lastRunId);
          const nodeIds = [...new Set(events.filter((e) => e.node_id).map((e) => e.node_id!))];

          const outputs = await Promise.all(
            nodeIds.map(async (nodeId) => {
              const output = await storage.getOutput(job.lastRunId!, nodeId);
              const nodeEvents = events.filter((e) => e.node_id === nodeId);
              const started = nodeEvents.find((e) => e.type === "node.started");
              const completed = nodeEvents.find((e) => e.type === "node.completed" || e.type === "node.failed");
              return {
                nodeId,
                nodeType: started?.node_type ?? null,
                stdout: output?.stdout ?? "",
                json: output?.json ?? null,
                exitCode: output?.exit_code ?? 0,
                status: completed
                  ? completed.type === "node.completed"
                    ? "completed"
                    : "failed"
                  : started
                    ? "running"
                    : "pending",
                startedAt: started?.timestamp ?? null,
                completedAt: completed?.timestamp ?? null,
              };
            }),
          );

          return { success: true, data: outputs };
        }
```

Add required imports at top:
```typescript
import { createPgStorageAdapter } from "../../services/workflow/pg-storage-adapter";
```

- [ ] **Step 2: Verify build**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/web/workflow-jobs.ts
git commit -m "feat(workflow): add getOutputs action to workflow-jobs route"
```

---

## Task 2: Create job logs SSE endpoint

**Files:**
- Create: `src/routes/web/workflow-jobs-logs.ts`
- Modify: `src/routes/web/index.ts`

- [ ] **Step 1: Create `src/routes/web/workflow-jobs-logs.ts`**

```typescript
/**
 * 单个 Job 的实时日志 SSE 端点。
 *
 * GET /web/workflow-jobs/:jobId/logs — 前端通过 EventSource 订阅，
 * 接收该 Job 对应 run 的 DAG 节点事件。
 * 支持 Last-Event-ID / fromSeqNum 断线重连。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { getJob } from "../../repositories/workflow-job";
import { createPgStorageAdapter } from "../../services/workflow/pg-storage-adapter";
import { getKanbanEventBus } from "../../services/workflow/workflow-job-events";

const NODE_EVENTS = ["node.started", "node.completed", "node.failed", "node.cancelled", "node.retrying", "dag.completed"];

const app = new Elysia({ name: "web-workflow-jobs-logs" }).use(authGuardPlugin);

app.get(
  "/workflow-jobs/:jobId/logs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ request, params, query, error, store }: any) => {
    const authCtx = store.authContext;
    if (!authCtx) {
      return error(401, { error: { type: "UNAUTHORIZED", message: "No auth context" } });
    }

    const jobId = (params as Record<string, unknown>).jobId as string;
    if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });

    const job = await getJob(jobId, authCtx.organizationId);
    if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
    if (!job.lastRunId) return error(400, { error: { type: "VALIDATION_ERROR", message: "Job has no run" } });

    const runId = job.lastRunId;
    const storage = createPgStorageAdapter(authCtx.organizationId);
    const bus = getKanbanEventBus(authCtx.organizationId);

    // 加载历史事件
    const history = await storage.getEvents(runId);
    const filtered = history.filter((e) => NODE_EVENTS.includes(e.type));

    const lastEventId = request.headers.get("Last-Event-ID");
    const fromSeq = (query as Record<string, unknown>)?.fromSeqNum;
    const fromSeqNum = fromSeq ? Number(fromSeq) : lastEventId ? Number(lastEventId) : 0;

    let seqCounter = fromSeqNum;

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": keepalive\n\n"));

        // 发送历史事件
        for (const evt of filtered) {
          seqCounter++;
          const data = JSON.stringify(evt);
          controller.enqueue(encoder.encode(`id: ${seqCounter}\nevent: message\ndata: ${data}\n\n`));
        }

        // 订阅实时事件
        const unsub = bus.subscribe((event) => {
          try {
            const payload = event.payload as Record<string, unknown>;
            // 只转发该 runId 的节点事件
            if (payload.runId !== runId) return;
            const type = payload.type as string;
            if (!NODE_EVENTS.includes(type)) return;

            seqCounter++;
            const data = JSON.stringify(payload);
            controller.enqueue(encoder.encode(`id: ${seqCounter}\nevent: message\ndata: ${data}\n\n`));
          } catch {
            unsub();
          }
        });

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

- [ ] **Step 2: Register in `src/routes/web/index.ts`**

Add import and `.use()`:

```typescript
import webWorkflowJobsLogs from "./workflow-jobs-logs";

// Add after webWorkflowJobsSse:
  .use(webWorkflowJobsLogs)
```

- [ ] **Step 3: Verify build**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/workflow-jobs-logs.ts src/routes/web/index.ts
git commit -m "feat(workflow): add per-job logs SSE endpoint"
```

---

## Task 3: Generate shadcn Sheet component (if missing)

**Files:**
- Create: `web/components/ui/sheet.tsx`

- [ ] **Step 1: Check if Sheet exists**

```bash
ls web/components/ui/sheet.tsx 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

- [ ] **Step 2: If missing, generate via shadcn**

```bash
bunx shadcn@latest add sheet --yes
```

- [ ] **Step 3: Commit**

```bash
git add web/components/ui/sheet.tsx
git commit -m "chore: add shadcn Sheet component"
```

---

## Task 4: Frontend API client for job logs

**Files:**
- Create: `web/src/api/workflow-job-logs.ts`
- Modify: `web/src/api/workflow-jobs.ts`

- [ ] **Step 1: Create `web/src/api/workflow-job-logs.ts`**

```typescript
/**
 * Workflow Job Logs API Client。
 *
 * 对接 GET /web/workflow-jobs/:jobId/logs SSE 端点。
 * 对接 POST /web/workflow-jobs getOutputs action。
 */

export interface NodeOutput {
  nodeId: string;
  nodeType: string | null;
  stdout: string;
  json: unknown | null;
  exitCode: number;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string | null;
  completedAt: string | null;
}

export interface NodeEvent {
  type: string;
  runId: string;
  nodeId?: string;
  nodeType?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

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

export const workflowJobLogsApi = {
  async getOutputs(jobId: string): Promise<NodeOutput[]> {
    const data = await postAction("getOutputs", { jobId });
    return Array.isArray(data) ? data : [];
  },

  createLogsEventSource(jobId: string): EventSource {
    return new EventSource(`/web/workflow-jobs/${jobId}/logs`);
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add web/src/api/workflow-job-logs.ts
git commit -m "feat(workflow): add job logs API client"
```

---

## Task 5: Frontend i18n keys for logs

**Files:**
- Modify: `web/src/i18n/locales/en/kanban.json`
- Modify: `web/src/i18n/locales/zh/kanban.json`

- [ ] **Step 1: Add English keys to `web/src/i18n/locales/en/kanban.json`**

Add these new keys:

```json
  "logs_title": "Logs",
  "logs_view": "View Logs",
  "logs_no_run": "No run data available",
  "logs_loading": "Loading logs...",
  "logs_node_pending": "Pending",
  "logs_node_running": "Running",
  "logs_node_completed": "Completed",
  "logs_node_failed": "Failed",
  "logs_no_output": "No output",
  "logs_summary": "{{completed}}/{{total}} nodes",
  "logs_duration": "{{duration}}"
```

- [ ] **Step 2: Add Chinese keys to `web/src/i18n/locales/zh/kanban.json`**

```json
  "logs_title": "日志",
  "logs_view": "查看日志",
  "logs_no_run": "暂无运行数据",
  "logs_loading": "加载日志中...",
  "logs_node_pending": "等待中",
  "logs_node_running": "运行中",
  "logs_node_completed": "已完成",
  "logs_node_failed": "失败",
  "logs_no_output": "无输出",
  "logs_summary": "{{completed}}/{{total}} 节点",
  "logs_duration": "{{duration}}"
```

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/locales/en/kanban.json web/src/i18n/locales/zh/kanban.json
git commit -m "feat(workflow): add logs-related i18n keys"
```

---

## Task 6: JobLogsSheet component

**Files:**
- Create: `web/src/pages/workflow/components/JobLogsSheet.tsx`

- [ ] **Step 1: Create `JobLogsSheet.tsx`**

The component:
- Right-side Sheet, width `w-[480px]`
- Header: workflow name + status badge
- Content: list of nodes with status icon + expandable stdout
- SSE subscription for real-time node events
- Polling for stdout updates on running nodes
- Terminal-style stdout display (dark bg, monospace)

```typescript
import { CheckCircle2, Circle, Loader2, ScrollText, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { WorkflowJob } from "../../../api/workflow-jobs";
import { workflowJobLogsApi, type NodeOutput } from "../../../api/workflow-job-logs";

interface JobLogsSheetProps {
  job: WorkflowJob | null;
  open: boolean;
  onClose: () => void;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  pending: <Circle size={13} className="text-text-muted" />,
  running: <Loader2 size={13} className="text-brand animate-spin" />,
  completed: <CheckCircle2 size={13} className="text-emerald-500" />,
  failed: <XCircle size={13} className="text-red-500" />,
};

function formatDuration(start?: string | null, end?: string | null): string {
  if (!start) return "";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const diff = Math.max(0, Math.round((e - s) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
}

export function JobLogsSheet({ job, open, onClose }: JobLogsSheetProps) {
  const { t } = useTranslation("kanban");
  const [nodes, setNodes] = useState<NodeOutput[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // 加载初始输出
  const loadOutputs = useCallback(async () => {
    if (!job) return;
    setLoading(true);
    try {
      const data = await workflowJobLogsApi.getOutputs(job.id);
      setNodes(data);
      // 默认展开 running 节点
      const runningIds = data.filter((n) => n.status === "running").map((n) => n.nodeId);
      if (runningIds.length > 0) {
        setExpandedIds((prev) => {
          const next = new Set(prev);
          for (const id of runningIds) next.add(id);
          return next;
        });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [job]);

  // 打开时加载 + 建立 SSE + 启动轮询
  useEffect(() => {
    if (!open || !job || !job.lastRunId) return;

    loadOutputs();

    // SSE 实时事件
    const es = workflowJobLogsApi.createLogsEventSource(job.id);
    esRef.current = es;
    es.onmessage = () => {
      // 收到事件后刷新输出
      loadOutputs();
    };
    es.onerror = () => {
      // SSE 断线不处理，浏览器自动重连
    };

    // 轮询 stdout（running 节点 2s 刷新）
    pollingRef.current = setInterval(() => {
      workflowJobLogsApi.getOutputs(job.id).then(setNodes).catch(console.error);
    }, 2000);

    return () => {
      es.close();
      esRef.current = null;
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [open, job, loadOutputs]);

  const toggleExpand = useCallback((nodeId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const hasRunning = nodes.some((n) => n.status === "running");
  const completedCount = nodes.filter((n) => n.status === "completed" || n.status === "failed").length;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-[480px] sm:max-w-[480px] p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-sm font-semibold flex items-center gap-2">
              <ScrollText size={15} />
              {job?.workflowName ?? t("logs_title")}
            </SheetTitle>
            <div className="text-[11px] text-text-dim">
              {t("logs_summary", { completed: completedCount, total: nodes.length })}
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {loading && nodes.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-text-muted text-sm">
              <Loader2 size={16} className="animate-spin mr-2" />
              {t("logs_loading")}
            </div>
          ) : nodes.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-text-muted text-sm">
              {t("logs_no_run")}
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {nodes.map((node) => {
                const isExpanded = expandedIds.has(node.nodeId);
                const duration = formatDuration(node.startedAt, node.completedAt);
                return (
                  <div key={node.nodeId}>
                    <button
                      type="button"
                      onClick={() => toggleExpand(node.nodeId)}
                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-hover transition-colors"
                    >
                      {STATUS_ICON[node.status] ?? STATUS_ICON.pending}
                      <span className="text-xs font-medium text-text-primary flex-1 truncate">
                        {node.nodeType ? `${node.nodeId} (${node.nodeType})` : node.nodeId}
                      </span>
                      {duration && (
                        <span className="text-[10px] text-text-dim font-mono">{duration}</span>
                      )}
                    </button>
                    {isExpanded && (
                      <div className="px-4 pb-3">
                        {node.stdout ? (
                          <pre className="bg-gray-900 text-gray-100 rounded-md p-3 text-[11px] font-mono leading-relaxed overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all">
                            {node.stdout}
                            {node.status === "running" && (
                              <span className="inline-block w-1.5 h-3.5 bg-gray-100 animate-pulse ml-0.5 align-middle" />
                            )}
                          </pre>
                        ) : (
                          <div className="text-[11px] text-text-muted py-2">{t("logs_no_output")}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {hasRunning && (
          <div className="px-4 py-2 border-t border-border-subtle flex items-center gap-2 text-[11px] text-text-dim flex-shrink-0">
            <Loader2 size={12} className="animate-spin" />
            {t("logs_node_running")}...
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/components/JobLogsSheet.tsx
git commit -m "feat(workflow): add JobLogsSheet component"
```

---

## Task 7: Integrate logs into KanbanCard + WorkflowKanban

**Files:**
- Modify: `web/src/pages/workflow/components/KanbanCard.tsx`
- Modify: `web/src/pages/workflow/components/KanbanColumn.tsx`
- Modify: `web/src/pages/workflow/WorkflowKanban.tsx`

- [ ] **Step 1: Update `KanbanCard.tsx`**

Add `onViewLogs` to props:

```typescript
interface KanbanCardProps {
  job: WorkflowJob;
  onRefresh: () => void;
  onEditParams: (job: WorkflowJob) => void;
  onViewLogs: (job: WorkflowJob) => void;
}
```

Update component signature:

```typescript
export function KanbanCard({ job, onRefresh, onEditParams, onViewLogs }: KanbanCardProps) {
```

Add `ScrollText` to lucide imports:

```typescript
import { CheckCircle2, MoreHorizontal, Pause, Play, ScrollText, Trash2 } from "lucide-react";
```

Add "View Logs" menu item inside `<DropdownMenuContent>`, before the delete item. Only show for running/completed/suspended:

```typescript
              {(job.status === "running" || job.status === "completed" || job.status === "suspended") && (
                <DropdownMenuItem onClick={() => onViewLogs(job)}>
                  <ScrollText size={13} className="mr-1.5" /> {t("logs_view")}
                </DropdownMenuItem>
              )}
```

- [ ] **Step 2: Update `KanbanColumn.tsx`**

Add `onViewLogs` to props interface:

```typescript
interface KanbanColumnProps {
  titleKey: string;
  jobs: WorkflowJob[];
  onRefresh: () => void;
  onEditParams: (job: WorkflowJob) => void;
  onViewLogs: (job: WorkflowJob) => void;
}
```

Update component signature and pass to KanbanCard:

```typescript
export function KanbanColumn({ titleKey, jobs, onRefresh, onEditParams, onViewLogs }: KanbanColumnProps) {
```

In the KanbanCard render, add `onViewLogs`:

```typescript
<KanbanCard key={job.id} job={job} onRefresh={onRefresh} onEditParams={onEditParams} onViewLogs={onViewLogs} />
```

- [ ] **Step 3: Update `WorkflowKanban.tsx`**

Add import:

```typescript
import { JobLogsSheet } from "./components/JobLogsSheet";
```

Add state:

```typescript
const [logsJob, setLogsJob] = useState<WorkflowJob | null>(null);
const [logsOpen, setLogsOpen] = useState(false);
```

Add handler:

```typescript
const handleViewLogs = useCallback((job: WorkflowJob) => {
  setLogsJob(job);
  setLogsOpen(true);
}, []);
```

Pass `onViewLogs={handleViewLogs}` to all `<KanbanColumn>` instances.

Add `<JobLogsSheet>` at the bottom of the return JSX, after `<KanbanJobDialog>`:

```typescript
      <JobLogsSheet
        job={logsJob}
        open={logsOpen}
        onClose={() => {
          setLogsOpen(false);
          setLogsJob(null);
        }}
      />
```

- [ ] **Step 4: Verify build**

```bash
bun run build:web
```

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/workflow/components/KanbanCard.tsx web/src/pages/workflow/components/KanbanColumn.tsx web/src/pages/workflow/WorkflowKanban.tsx
git commit -m "feat(workflow): integrate job logs into kanban cards and page"
```

---

## Task 8: Final Verification

**Files:** None — verification only.

- [ ] **Step 1: Run full precheck**

```bash
bun run precheck
```

Expected: All checks pass.

- [ ] **Step 2: Run backend tests**

```bash
bun test src/__tests__/
```

Expected: All existing tests pass.

- [ ] **Step 3: Run frontend build**

```bash
bun run build:web
```

Expected: Build succeeds.

- [ ] **Step 4: Fix and commit if needed**

```bash
git add -A
git commit -m "fix(workflow): final cleanup for job logs feature"
```
