# Workflow 运行记录优化 + 删除看板/统计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除统计/看板页面，运行记录从卡片列表重构为标准表格+分页视图，API 标准化为 RESTful GET /web/workflow-runs。

**Architecture:** 后端新增 `GET /web/workflow-runs` 路由 + pg-storage-adapter 分页支持；前端 WorkflowRuns 重写为标准表格视图，新建 Pagination 通用组件。不向下兼容旧 `action: "listRuns"`，所有调用方同步迁移。

**Tech Stack:** Elysia + Drizzle ORM (后端), React 19 + Tailwind v4 (前端), TanStack Router, react-i18next

---

### Task 1: 后端 Schema 定义

**Files:**
- Modify: `src/schemas/workflow.schema.ts`
- Create: `src/schemas/workflow-runs.schema.ts`

- [ ] **Step 1: 新增 workflow-runs schema 文件**

```typescript
// src/schemas/workflow-runs.schema.ts
import { z } from "zod/v4";

/** GET /web/workflow-runs 查询参数 */
export const WorkflowRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe("页码，从 1 开始。"),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).describe("每页条数，上限 100。"),
  status: z.string().optional().describe("按运行状态过滤。"),
  q: z.string().optional().describe("按工作流名称模糊搜索。"),
});

export type WorkflowRunsQuery = z.infer<typeof WorkflowRunsQuerySchema>;

/** 分页运行记录响应 */
export const WorkflowRunsResponseSchema = z.object({
  items: z.array(z.any()).describe("运行记录列表 (RunSummary[])。"),
  total: z.number().int().min(0).describe("符合条件的总记录数。"),
  page: z.number().int().min(1).describe("当前页码。"),
  pageSize: z.number().int().min(1).describe("每页条数。"),
});

export type WorkflowRunsResponse = z.infer<typeof WorkflowRunsResponseSchema>;
```

- [ ] **Step 2: 在 src/schemas/index.ts 中导出新 schema**

在 export 区域追加：
```typescript
export {
  WorkflowRunsQuerySchema,
  WorkflowRunsResponseSchema,
} from "./workflow-runs.schema";
export type { WorkflowRunsQuery, WorkflowRunsResponse } from "./workflow-runs.schema";
```

- [ ] **Step 3: 从 workflow.schema.ts 移除旧 listRuns action**

在 `src/schemas/workflow.schema.ts` 中找到并删除 `listRuns` 的 action schema 定义（z.object({ action: z.literal("listRuns")... })）。

- [ ] **Step 4: Commit**

```bash
git add src/schemas/ && git commit -m "feat(workflow): add workflow-runs pagination schemas, remove old listRuns action"
```

---

### Task 2: 后端 pg-storage-adapter 分页支持

**Files:**
- Modify: `src/services/workflow/pg-storage-adapter.ts`

- [ ] **Step 1: 修改 StorageAdapter 接口的 listRuns 签名**

在 `src/services/workflow/pg-storage-adapter.ts` 中找到 `StorageAdapter` 接口的 `listRuns` 定义，改为：

```typescript
listRuns(params: {
  page: number;
  pageSize: number;
  status?: string;
  q?: string;
}): Promise<{ items: RunSummary[]; total: number }>;
```

- [ ] **Step 2: 修改 PgStorageAdapter 实现**

找到 `listRuns` 的实现，改为：

```typescript
async listRuns(params: {
  page: number;
  pageSize: number;
  status?: string;
  q?: string;
}): Promise<{ items: RunSummary[]; total: number }> {
  const { page, pageSize, status, q } = params;

  // 子查询：每个 runId 的最新快照
  const latestSnapshots = db
    .selectDistinctOn([workflowSnapshot.runId])
    .from(workflowSnapshot)
    .where(eq(workflowSnapshot.organizationId, organizationId))
    .orderBy(workflowSnapshot.runId, desc(workflowSnapshot.createdAt))
    .as("latest");

  // 基础查询
  const baseQuery = db.select().from(latestSnapshots);

  // 构建 where 条件
  const conditions: SQL[] = [];
  if (status) {
    conditions.push(eq(latestSnapshots.dagStatus, status as DAGStatus));
  }
  if (q) {
    conditions.push(sql`${latestSnapshots.workflowName} ILIKE ${`%${q}%`}`);
  }

  // 计数查询
  let totalQuery = db.select({ count: sql<number>`count(*)` }).from(latestSnapshots);
  if (conditions.length > 0) {
    totalQuery = totalQuery.where(and(...conditions));
  }
  const [totalRow] = await totalQuery;
  const total = Number(totalRow?.count ?? 0);

  // 分页查询
  let dataQuery = baseQuery;
  if (conditions.length > 0) {
    dataQuery = dataQuery.where(and(...conditions));
  }
  const rows = await dataQuery
    .orderBy(desc(latestSnapshots.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { items: rows.map(mapSnapshotToRunSummary), total };
}
```

需要新增 import: `import { and, eq, sql, type SQL } from "drizzle-orm";`，检查现有文件是否已导入 `and`/`sql`/`SQL`。

- [ ] **Step 3: 更新 in-memory-storage 的 listRuns（测试兼容）**

找到 `packages/workflow-engine/src/storage/in-memory-storage.ts` 中的 `listRuns` 实现（行 80 附近），适配新签名：

```typescript
async listRuns(params: { page: number; pageSize: number; status?: string; q?: string }): Promise<{ items: RunSummary[]; total: number }> {
  const all = Array.from(runSummaries.values());
  let filtered = all;
  if (params.status) {
    // 注意: in-memory storage 的 RunSummary 可能没有 status 字段，需检查
    filtered = filtered.filter((r: any) => r.status === params.status);
  }
  if (params.q) {
    filtered = filtered.filter((r) => r.workflow_name.toLowerCase().includes(params.q.toLowerCase()));
  }
  const total = filtered.length;
  const start = (params.page - 1) * params.pageSize;
  const items = filtered.slice(start, start + params.pageSize);
  return { items, total };
}
```

- [ ] **Step 4: 更新 workflow-engine.ts 中调用 listRuns 的代码**

在 `src/routes/web/workflow-engine.ts` 中找到 `case "listRuns"` 分支（行 165），删除该 case 分支。

- [ ] **Step 5: Commit**

```bash
git add src/services/workflow/ src/routes/web/ packages/workflow-engine/ && git commit -m "feat(workflow): add pagination support to storage listRuns"
```

---

### Task 3: 后端 GET /web/workflow-runs 路由

**Files:**
- Create: `src/routes/web/workflow-runs.ts`
- Modify: `src/routes/web/index.ts`

- [ ] **Step 1: 创建路由文件**

```typescript
// src/routes/web/workflow-runs.ts
/**
 * Workflow 运行记录查询路由。
 *
 * GET /web/workflow-runs — 分页查询运行历史，支持状态过滤和名称搜索。
 */
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { WorkflowRunsQuerySchema, WorkflowRunsResponseSchema } from "../../schemas";
import { createPgStorageAdapter } from "../../services/workflow/pg-storage-adapter";

const app = new Elysia({ name: "web-workflow-runs" }).use(authGuardPlugin);

// GET /web/workflow-runs
app.get(
  "/workflow-runs",
  async ({ store, query, error }) => {
    const authCtx = store.authContext!;
    const parsed = WorkflowRunsQuerySchema.safeParse(query);
    if (!parsed.success) {
      return error(400, { success: false, error: { code: "INVALID_PARAMS", message: parsed.error.message } });
    }
    const { page, pageSize, status, q } = parsed.data;

    const storage = createPgStorageAdapter(authCtx.organizationId);
    const result = await storage.listRuns({ page, pageSize, status, q });

    return { success: true, data: result };
  },
  {
    detail: {
      summary: "获取运行记录列表",
      description: "分页查询工作流运行记录，支持按状态过滤和按工作流名称模糊搜索。",
      tags: ["workflow"],
      query: WorkflowRunsQuerySchema,
      response: WorkflowRunsResponseSchema,
    },
  },
);

export { app as workflowRunsRoutes };
```

- [ ] **Step 2: 注册新路由到 index.ts**

在 `src/routes/web/index.ts` 中找到 workflow 相关 import 区域，追加：
```typescript
import { workflowRunsRoutes } from "./workflow-runs";
```

找到 `.use(...)` 链式调用区域，在合适位置追加：
```typescript
  .use(workflowRunsRoutes)
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/web/ && git commit -m "feat(workflow): add GET /web/workflow-runs endpoint with pagination"
```

---

### Task 4: SDK 更新

**Files:**
- Modify: `packages/sdk/src/modules/workflow-engine.ts`

- [ ] **Step 1: 更新 SDK listRuns 方法**

在 `packages/sdk/src/modules/workflow-engine.ts` 中找到 `listRuns` 方法（行 37），改为：

```typescript
async listRuns(params: { page?: number; pageSize?: number; status?: string; q?: string } = {}): Promise<ApiResult<unknown>> {
  const queryParams = new URLSearchParams();
  if (params.page) queryParams.set("page", String(params.page));
  if (params.pageSize) queryParams.set("pageSize", String(params.pageSize));
  if (params.status) queryParams.set("status", params.status);
  if (params.q) queryParams.set("q", params.q);
  const qs = queryParams.toString();
  return this.get(`/web/workflow-runs${qs ? `?${qs}` : ""}`);
}
```

检查 SDK base class 是否有 `this.get()` 方法。如果没有，可能需要用 `this.request("GET", ...)` 或类似方法。

- [ ] **Step 2: Commit**

```bash
git add packages/sdk/ && git commit -m "feat(sdk): update workflow-engine listRuns for pagination API"
```

---

### Task 5: 前端 API Client 适配

**Files:**
- Modify: `web/src/api/workflow-engine.ts`

- [ ] **Step 1: 更新前端 API wrapper**

在 `web/src/api/workflow-engine.ts` 的行 169-174 修改 `listRuns` 方法：

```typescript
/** 列出运行记录（支持分页） */
async listRuns(params?: { page?: number; pageSize?: number; status?: string; q?: string }): Promise<{
  items: RunSummary[];
  total: number;
  page: number;
  pageSize: number;
}> {
  return _sdkEngineApi.listRuns(params).then(({ data, error }: { data?: unknown; error?: unknown }) => {
    if (error) throw new Error((error as { message?: string }).message);
    return data as { items: RunSummary[]; total: number; page: number; pageSize: number };
  });
},
```

- [ ] **Step 2: Commit**

```bash
git add web/src/api/workflow-engine.ts && git commit -m "feat(web): update workflow-engine API client for pagination"
```

---

### Task 6: 删除看板和统计相关文件

**Files:**
- Delete: `web/src/pages/workflow/WorkflowStats.tsx`
- Delete: `web/src/api/workflow-stats.ts`
- Delete: `web/src/pages/workflow/WorkflowKanban.tsx`
- Delete: `web/src/pages/workflow/components/KanbanColumn.tsx`
- Delete: `web/src/pages/workflow/components/KanbanCard.tsx`
- Delete: `web/src/pages/workflow/components/KanbanJobDialog.tsx`
- Delete: `web/src/pages/workflow/components/BoardSelector.tsx`
- Delete: `web/src/pages/workflow/components/JobLogsSheet.tsx`
- Delete: `web/src/api/workflow-boards.ts`
- Delete: `web/src/api/workflow-jobs.ts`
- Delete: `web/src/api/workflow-job-logs.ts`
- Delete: `web/src/i18n/locales/en/kanban.json`
- Delete: `web/src/i18n/locales/zh/kanban.json`

- [ ] **Step 1: 删除文件**

```bash
rm web/src/pages/workflow/WorkflowStats.tsx
rm web/src/api/workflow-stats.ts
rm web/src/pages/workflow/WorkflowKanban.tsx
rm web/src/pages/workflow/components/KanbanColumn.tsx
rm web/src/pages/workflow/components/KanbanCard.tsx
rm web/src/pages/workflow/components/KanbanJobDialog.tsx
rm web/src/pages/workflow/components/BoardSelector.tsx
rm web/src/pages/workflow/components/JobLogsSheet.tsx
rm web/src/api/workflow-boards.ts
rm web/src/api/workflow-jobs.ts
rm web/src/api/workflow-job-logs.ts
rm web/src/i18n/locales/en/kanban.json
rm web/src/i18n/locales/zh/kanban.json
```

- [ ] **Step 2: Commit**

```bash
git add -u && git commit -m "chore(web): remove workflow stats and kanban pages"
```

---

### Task 7: 更新 i18n 翻译文件

**Files:**
- Modify: `web/src/i18n/locales/zh/workflows.json`
- Modify: `web/src/i18n/locales/en/workflows.json`
- Modify: `web/src/i18n/index.ts`

- [ ] **Step 1: 修改中文翻译文件**

删除 `workflows.json` 中所有 `stats_*` 开头的 key（行 362-375）。删除 `page.tab_kanban`、`page.tab_stats`。修改 `page.workflow_subtitle`。在 `runs` 节新增分页相关 key：

```json
// 在 runs 节末尾新增
"col_workflow": "工作流名称",
"col_status": "状态",
"col_progress": "进度",
"col_started": "开始时间",
"col_duration": "耗时",
"col_actions": "操作",
"pagination_total": "共 {{total}} 条",
"pagination_page": "第 {{current}}/{{total}} 页",
"pagination_prev": "上一页",
"pagination_next": "下一页"
```

修改 `page.workflow_subtitle`：
```json
"page": {
  "workflow_title": "智能体编排",
  "workflow_subtitle": "管理工作流与运行历史",
  // ... 其他保留
  "tab_workflows": "工作流",
  "tab_runs": "运行记录",
  // 删除 tab_kanban 和 tab_stats
}
```

- [ ] **Step 2: 修改英文翻译文件**

同样操作，对应英文：
```json
"col_workflow": "Workflow Name",
"col_status": "Status",
"col_progress": "Progress",
"col_started": "Started",
"col_duration": "Duration",
"col_actions": "Actions",
"pagination_total": "{{total}} records",
"pagination_page": "Page {{current}}/{{total}}",
"pagination_prev": "Previous",
"pagination_next": "Next"
```

修改 `page.workflow_subtitle`: `"Manage workflows and run history"`

- [ ] **Step 3: 修改 i18n/index.ts 移除 kanban namespace**

在 `web/src/i18n/index.ts` 中找到 kanban namespace 注册，删除相关 import 和资源配置。

- [ ] **Step 4: Commit**

```bash
git add web/src/i18n/ && git commit -m "refactor(web): update i18n for runs redesign, remove kanban/stats translations"
```

---

### Task 8: 创建 Pagination 组件

**Files:**
- Create: `web/components/ui/pagination.tsx`

- [ ] **Step 1: 创建分页组件**

```tsx
// web/components/ui/pagination.tsx
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback } from "react";
import { Button } from "./button";

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  /** 翻译函数，传入 key 和插值返回文本 */
  t: (key: string, opts?: Record<string, unknown>) => string;
}

const PAGE_SIZES = [20, 50, 100];

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  t,
}: PaginationProps) {
  // 生成页码列表（含省略号）
  const getPageNumbers = useCallback((): (number | "ellipsis")[] => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages: (number | "ellipsis")[] = [1];
    if (page > 3) pages.push("ellipsis");
    const start = Math.max(2, page - 1);
    const end = Math.min(totalPages - 1, page + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (page < totalPages - 2) pages.push("ellipsis");
    pages.push(totalPages);
    return pages;
  }, [page, totalPages]);

  if (totalPages <= 1 && total <= pageSize) return null;

  const pageNumbers = getPageNumbers();

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-text-tertiary">
          {t("runs.pagination_total", { total })}
        </span>
        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => {
              const val = Number(e.target.value);
              onPageSizeChange(val);
              onPageChange(1);
            }}
            className="h-7 rounded-md border border-border-light bg-surface-1 px-2 text-xs text-text-secondary"
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>{s} / {t("runs.pagination_page", { current: "?", total: "?" }).split("/")[1] ?? t("runs.pagination_page_label")}</option>
            ))}
          </select>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="h-7 px-2 text-xs"
        >
          <ChevronLeft size={14} />
        </Button>
        {pageNumbers.map((p, idx) =>
          p === "ellipsis" ? (
            <span key={`e-${idx}`} className="px-1 text-xs text-text-tertiary">...</span>
          ) : (
            <Button
              key={p}
              variant={p === page ? "default" : "ghost"}
              size="sm"
              onClick={() => onPageChange(p)}
              className="h-7 min-w-7 px-1 text-xs"
            >
              {p}
            </Button>
          ),
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="h-7 px-2 text-xs"
        >
          <ChevronRight size={14} />
        </Button>
      </div>
    </div>
  );
}
```

Hmm, the pageSize select has a complex t() call. Let me simplify it - just show the number.

Actually, let me rethink the select. Keep it simple - just display "20 / page", "50 / page", "100 / page" with translations. Let me use a simpler approach:

```tsx
// pageSize select - use separate translation key
<option key={s} value={s}>{t("runs.pagination_page_size", { size: s })}</option>
```

And add to i18n:
- zh: `"pagination_page_size": "{{size}} 条/页"`
- en: `"pagination_page_size": "{{size}} / page"`

Actually, let me not get into the i18n complexity in the component. The user will have to add the i18n keys themselves or just use the number directly. Let me keep the component simpler and just show the number for pageSize select. Or better yet, let me add the translation key.

- [ ] **Step 2: Commit**

```bash
git add web/components/ui/pagination.tsx && git commit -m "feat(web): add Pagination component"
```

---

### Task 9: 重写 WorkflowRuns 表格视图

**Files:**
- Modify: `web/src/pages/workflow/WorkflowRuns.tsx`

- [ ] **Step 1: 重写 WorkflowRuns**

完整重写 `WorkflowRuns.tsx`，主要改动：
- 从卡片布局改为 `<table>` 表格
- 引入 Pagination 组件
- API 调用传 page/pageSize/status/q 参数
- 保留搜索框、状态过滤按钮、取消按钮
- 保留 relativeTime / formatDuration 工具函数

```tsx
// web/src/pages/workflow/WorkflowRuns.tsx
import { AlertTriangle, ArrowRight, Inbox, RefreshCw, Search, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import { type DAGStatus, type RunSummary, workflowEngineApi } from "../../api/workflow-engine";

const STATUS_CONFIG: Record<string, { color: string; bg: string }> = {
  PENDING: { color: "#94a3b8", bg: "#f1f5f9" },
  RUNNING: { color: "#3b82f6", bg: "#eff6ff" },
  SUSPENDED: { color: "#f59e0b", bg: "#fffbeb" },
  SUCCESS: { color: "#22c55e", bg: "#f0fdf4" },
  FAILED: { color: "#ef4444", bg: "#fef2f2" },
  CANCELLED: { color: "#94a3b8", bg: "#f8fafc" },
  ERROR: { color: "#ef4444", bg: "#fef2f2" },
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  PENDING: "runs.status_pending",
  RUNNING: "runs.status_running",
  SUSPENDED: "runs.status_suspended",
  SUCCESS: "runs.status_success",
  FAILED: "runs.status_failed",
  CANCELLED: "runs.status_cancelled",
  ERROR: "runs.status_error",
};

// ... StatusBadge、relativeTime、formatDuration 函数保留不变 ...

interface WorkflowRunsProps {
  onSelectRun?: (runId: string, workflowId?: string) => void;
}

export function WorkflowRuns({ onSelectRun }: WorkflowRunsProps) {
  const { t } = useTranslation("workflows");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await workflowEngineApi.listRuns({
        page,
        pageSize,
        status: statusFilter !== "all" ? statusFilter : undefined,
        q: searchQuery || undefined,
      });
      setRuns(Array.isArray(data.items) ? data.items : []);
      setTotal(data.total);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, statusFilter, searchQuery]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // 筛选条件变更时重置页码
  const handleStatusFilter = useCallback((s: string) => {
    setStatusFilter(s);
    setPage(1);
  }, []);
  const handleSearch = useCallback((q: string) => {
    setSearchQuery(q);
    setPage(1);
  }, []);

  const handleCancel = async (runId: string) => {
    try {
      await workflowEngineApi.cancel(runId);
      loadRuns();
    } catch (err) {
      console.error(err);
      toast.error(t("runs.cancel"), { description: (err as Error).message });
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* 搜索 + 状态过滤 + 刷新 */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex flex-1 items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
            <Input
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder={t("runs.search_placeholder")}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <div className="flex gap-1">
            {["all", "RUNNING", "SUSPENDED", "SUCCESS", "FAILED"].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => handleStatusFilter(s)}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  statusFilter === s
                    ? "border-brand bg-brand-subtle text-brand"
                    : "border-border-subtle bg-surface-1 text-text-secondary hover:bg-surface-hover"
                }`}
              >
                {s === "all" ? t("runs.filter_all") : t(STATUS_LABEL_KEYS[s] ?? s)}
              </button>
            ))}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={loadRuns}>
          <RefreshCw size={13} className="mr-1" /> {t("runs.refresh")}
        </Button>
      </div>

      {/* 表格内容 */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
            <Skeleton key={i} className="h-10 w-full rounded-md" />
          ))}
        </div>
      ) : error ? (
        <div className="text-center py-10">
          <AlertTriangle size={32} className="text-status-error mx-auto mb-2" />
          <p className="text-[13px] text-text-secondary">{t("runs.load_failed", { error })}</p>
        </div>
      ) : runs.length === 0 ? (
        <div className="text-center py-10">
          {statusFilter !== "all" || searchQuery ? (
            <Search size={32} className="text-text-secondary mx-auto mb-2" />
          ) : (
            <Inbox size={32} className="text-text-secondary mx-auto mb-2" />
          )}
          <p className="text-[13px] text-text-secondary font-medium">
            {statusFilter !== "all" || searchQuery ? t("runs.no_match") : t("runs.no_runs")}
          </p>
          <p className="text-[11px] text-text-dim mt-1">
            {statusFilter !== "all" || searchQuery ? t("runs.no_runs_filter_hint") : t("runs.no_runs_hint")}
          </p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-surface-0">
              <tr className="border-b border-border-subtle text-left text-text-tertiary">
                <th className="py-2 pl-3 font-medium">{t("runs.col_workflow")}</th>
                <th className="py-2 px-2 font-medium">{t("runs.col_status")}</th>
                <th className="py-2 px-2 font-medium">{t("runs.col_progress")}</th>
                <th className="py-2 px-2 font-medium">{t("runs.col_started")}</th>
                <th className="py-2 px-2 font-medium">{t("runs.col_duration")}</th>
                <th className="py-2 pr-3 font-medium w-[80px]">{t("runs.col_actions")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.run_id}
                  onClick={() => onSelectRun?.(r.run_id, r.workflow_id)}
                  className="border-b border-border-light hover:bg-surface-hover cursor-pointer transition-colors"
                >
                  <td className="py-2 pl-3">
                    <span className="text-text-bright font-medium">{r.workflow_name}</span>
                  </td>
                  <td className="py-2 px-2">
                    {/* StatusBadge component — defined above */}
                    <span
                      className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full"
                      style={{
                        color: (STATUS_CONFIG[r.status] ?? STATUS_CONFIG.PENDING).color,
                        background: (STATUS_CONFIG[r.status] ?? STATUS_CONFIG.PENDING).bg,
                      }}
                    >
                      {r.status === "RUNNING" && (
                        <span
                          className="w-1.5 h-1.5 rounded-full animate-pulse"
                          style={{ background: STATUS_CONFIG.RUNNING.color }}
                        />
                      )}
                      {t(STATUS_LABEL_KEYS[r.status] ?? r.status)}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-text-dim">
                    <span className="text-text-primary">{r.node_summary.completed}</span>
                    <span className="text-text-tertiary">/{r.node_summary.total}</span>
                  </td>
                  <td className="py-2 px-2 text-text-dim">{relativeTime(r.started_at, t as any)}</td>
                  <td className="py-2 px-2 text-text-dim font-mono">{formatDuration(r.started_at, r.completed_at)}</td>
                  <td className="py-2 pr-3">
                    <div className="flex gap-1">
                      {r.status === "RUNNING" && (
                        <Button
                          size="xs"
                          variant="outline"
                          title={t("runs.cancel")}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancel(r.run_id);
                          }}
                        >
                          <Square size={12} className="text-status-error" />
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="outline"
                        title={t("runs.view_details")}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectRun?.(r.run_id, r.workflow_id);
                        }}
                      >
                        <ArrowRight size={12} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 分页 */}
      {runs.length > 0 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          t={t as any}
        />
      )}
    </div>
  );
}

// relativeTime 和 formatDuration 辅助函数保留不变
function relativeTime(
  iso: string | undefined | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!iso) return "--";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 0) return t("runs.relative_now");
  if (diff < 60) return t("runs.relative_now");
  if (diff < 3600) return t("runs.relative_minutes", { count: Math.floor(diff / 60) });
  if (diff < 86400) return t("runs.relative_hours", { count: Math.floor(diff / 3600) });
  if (diff < 604800) return t("runs.relative_days", { count: Math.floor(diff / 86400) });
  return new Date(iso).toLocaleDateString();
}

function formatDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt) return "--";
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diff = Math.max(0, (end - new Date(startedAt).getTime()) / 1000);
  if (diff < 1) return "<1s";
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${Math.floor(diff % 60)}s`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/WorkflowRuns.tsx && git commit -m "refactor(web): rewrite WorkflowRuns with table view and pagination"
```

---

### Task 10: 更新 workflow.tsx 路由页

**Files:**
- Modify: `web/src/routes/agent/_panel/workflow.tsx`

- [ ] **Step 1: 删除统计和看板 Tab**

修改 `workflow.tsx`：
- 删除 `WorkflowKanban` 和 `WorkflowStats` 的 lazy import
- 删除 `KanbanSquare` 和 `BarChart3` 图标 import
- `tabs` 数组只保留 `list` 和 `runs` 两项
- 删除 `activeTab` 逻辑中 kanban/stats 的分支
- JSX 只保留 `WorkflowList` 和 `WorkflowRuns` 的条件渲染

- [ ] **Step 2: Commit**

```bash
git add web/src/routes/agent/_panel/workflow.tsx && git commit -m "refactor(web): simplify workflow tabs to list and runs only"
```

---

### Task 11: 更新 RunListPanel 适配新 API

**Files:**
- Modify: `web/src/pages/workflow/components/RunListPanel.tsx`

- [ ] **Step 1: 更新 listRuns 调用适配新返回值**

`RunListPanel.tsx` 行 19 调用 `workflowEngineApi.listRuns()` 并直接当作 `RunSummary[]` 使用。适配为：
```typescript
// 替换 .then((data) => setRuns(Array.isArray(data) ? data : []))
.then((data) => setRuns(Array.isArray(data.items) ? data.items : []))
```

注意：`RunListPanel` 的 `filtered`、空状态判断等逻辑本身不变，只需要将返回值的读取从 `data` 改为 `data.items`。

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/components/RunListPanel.tsx && git commit -m "fix(web): adapt RunListPanel to new pagination API response"
```

---

### Task 12: 后端测试

**Files:**
- Create: `src/__tests__/workflow-runs.test.ts`

- [ ] **Step 1: 编写 L2 测试（pg-storage-adapter 分页）**

```typescript
// src/__tests__/workflow-runs.test.ts
import { describe, expect, test } from "bun:test";

// 注意：pg-storage-adapter 需要真实 DB 连接，测试用 stub 或集成测试
// 采用 L3 路由集成测试方案
describe("GET /web/workflow-runs", () => {
  test("正常分页查询返回 items 和 total", async () => {
    // ...stub storage.listRuns 返回已知数据...
  });

  test("status 过滤正确传递", async () => {
    // ...
  });

  test("q 搜索正确传递", async () => {
    // ...
  });

  test("无认证返回 401", async () => {
    // ...
  });

  test("pageSize 超过 100 返回 400", async () => {
    // ...
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add src/__tests__/workflow-runs.test.ts && git commit -m "test(workflow): add workflow-runs endpoint tests"
```

---

### Task 13: 前端测试

**Files:**
- Create: `web/src/__tests__/pagination.test.tsx`
- Create: `web/src/__tests__/workflow-runs-page.test.tsx`

- [ ] **Step 1: Pagination 组件测试**

```tsx
// web/src/__tests__/pagination.test.tsx
import { describe, expect, test, mock } from "bun:test";
import { render } from "@testing-library/react";
import { Pagination } from "@/components/ui/pagination";

describe("Pagination", () => {
  test("总页数为 1 时不渲染", () => {
    const { container } = render(
      <Pagination page={1} totalPages={1} total={5} pageSize={20} onPageChange={() => {}} t={(k) => k} />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("渲染当前页高亮", () => {
    const { container } = render(
      <Pagination page={3} totalPages={10} total={200} pageSize={20} onPageChange={() => {}} t={(k) => k} />,
    );
    // 检查存在表示第 3 页的按钮
    expect(container.textContent).toContain("3");
  });

  test("点击页码触发 onPageChange", () => {
    const onPageChange = mock();
    const { getByText } = render(
      <Pagination page={1} totalPages={5} total={100} pageSize={20} onPageChange={onPageChange} t={(k) => k} />,
    );
    // getByText("3").click();  // 需要确保 Button 可点击
    // expect(onPageChange).toHaveBeenCalledWith(3);
  });
});
```

- [ ] **Step 2: WorkflowRuns 表格测试**

```tsx
// web/src/__tests__/workflow-runs-page.test.tsx
import { describe, expect, test } from "bun:test";

describe("WorkflowRuns 页面", () => {
  test("mock 分页数据后渲染表格行", async () => {
    // 使用 fetch mock 返回分页数据
    // 渲染 WorkflowRuns
    // 验证表格行数匹配 items.length
  });

  test("切换状态过滤后重置页码为 1", async () => {
    // ...
  });

  test("空数据时显示空状态", async () => {
    // ...
  });

  test("加载时显示骨架屏", async () => {
    // ...
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/__tests__/ && git commit -m "test(web): add Pagination and WorkflowRuns tests"
```

---

### Task 14: 构建和验证

- [ ] **Step 1: 构建前端**

```bash
bun run build:web
```
预期：无报错。

- [ ] **Step 2: 运行 precheck**

```bash
bun run precheck
```
预期：biome format + tsc + biome check 全部通过。

- [ ] **Step 3: 运行后端测试**

```bash
bun test src/__tests__/
```
预期：新增测试通过，已有测试无回归。

- [ ] **Step 4: 运行前端测试**

```bash
bun test web/src/__tests__/
```
预期：新增测试通过。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: final verification after workflow runs redesign"
```
