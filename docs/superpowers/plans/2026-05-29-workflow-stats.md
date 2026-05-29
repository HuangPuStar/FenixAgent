# Workflow Statistics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Statistics" tab to the workflow page showing global (cross-board) run analytics: success rate trend, duration distribution, token consumption, and recent failures.

**Architecture:** New backend stats API aggregates data from `workflowSnapshot` (run status/duration) and `workflowNodeOutput` (token usage). Frontend uses Recharts for charts, independent tab alongside existing kanban/runs tabs.

**Tech Stack:** Drizzle ORM (SQL aggregation: count, avg, date_trunc), Elysia action-dispatch route, Recharts (LineChart, BarChart, AreaChart), react-i18next (NS.WORKFLOWS).

**Design Decisions:**

| Decision | Choice |
|----------|--------|
| Tab position | Independent tab "Statistics", after "Runs" |
| Data scope | Global (all org runs), not per-board |
| Time ranges | Fixed: 7 days / 30 days / All |
| Charts | Recharts (not yet installed) |
| i18n namespace | NS.WORKFLOWS (reuse existing) |
| API pattern | POST /web/workflow-stats with action dispatch |

---

## File Structure

### Backend — New Files

| File | Responsibility |
|------|---------------|
| `src/repositories/workflow-stats.ts` | Stats aggregation queries |
| `src/routes/web/workflow-stats.ts` | Stats API route (action dispatch) |

### Backend — Modified Files

| File | Change |
|------|--------|
| `src/routes/web/index.ts` | Register workflow-stats route |

### Frontend — New Files

| File | Responsibility |
|------|---------------|
| `web/src/pages/workflow/WorkflowStats.tsx` | Stats dashboard page |
| `web/src/api/workflow-stats.ts` | Stats API client |

### Frontend — Modified Files

| File | Change |
|------|--------|
| `web/src/routes/agent/_panel/workflow.tsx` | Add stats tab |
| `web/src/i18n/locales/en/workflows.json` | Stats English keys |
| `web/src/i18n/locales/zh/workflows.json` | Stats Chinese keys |
| `package.json` | Add recharts dependency |

---

## Task 1: Install Recharts

- [ ] **Step 1:** Install recharts

```bash
bun add recharts
```

- [ ] **Step 2:** Commit

```bash
git add package.json bun.lock
git commit -m "chore: add recharts dependency"
```

---

## Task 2: Backend stats repository

**Files:**
- Create: `src/repositories/workflow-stats.ts`

- [ ] **Step 1: Create `src/repositories/workflow-stats.ts`**

Uses Drizzle ORM SQL aggregation over `workflowSnapshot` and `workflowNodeOutput` tables. All queries scoped to `organizationId`.

```typescript
/**
 * Workflow Statistics Repository。
 *
 * 聚合查询工作流运行统计数据。
 */

import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { workflow, workflowNodeOutput, workflowSnapshot } from "../db/schema";

// ── 类型 ──

export interface StatsOverview {
  totalRuns: number;
  successRuns: number;
  failedRuns: number;
  successRate: number;
  avgDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface DailyCount {
  date: string;
  success: number;
  failed: number;
}

export interface DurationBucket {
  range: string;
  count: number;
}

export interface TokenDaily {
  date: string;
  inputTokens: number;
  outputTokens: number;
}

export interface FailedRun {
  runId: string;
  workflowId: string;
  workflowName: string;
  dagStatus: string;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
}

// ── 查询 ──

/** 概览：总运行数、成功率、平均耗时、总 Token */
export async function getStatsOverview(organizationId: string, since?: Date): Promise<StatsOverview> {
  const sinceCondition = since ? sql`${workflowSnapshot.timestamp} >= ${since}` : sql`1=1`;

  const [row] = await db
    .select({
      total: count(),
      success: sql<number>`count(*) filter (where ${workflowSnapshot.dagStatus} = 'SUCCESS')`,
      failed: sql<number>`count(*) filter (where ${workflowSnapshot.dagStatus} in ('FAILED', 'ERROR', 'CANCELLED'))`,
      avgDuration: sql<number>`avg(extract(epoch from (
        coalesce(${workflowSnapshot.timestamp}, now()) -
        coalesce(${workflowSnapshot.timestamp}, now())
      )) * 1000)`,
    })
    .from(workflowSnapshot)
    .where(
      and(
        eq(workflowSnapshot.organizationId, organizationId),
        // 只取每个 run 的最新 snapshot
        sql`${workflowSnapshot.snapshotId} in (
          select max(s2.snapshot_id) from workflow_snapshot s2
          where s2.organization_id = ${organizationId}
          ${since ? sql`and s2.timestamp >= ${since}` : sql``}
          group by s2.run_id
        )`,
        sinceCondition,
      ),
    );

  const totalRuns = row?.total ?? 0;
  const successRuns = row?.success ?? 0;
  const failedRuns = row?.failed ?? 0;

  // Token 聚合
  const tokenSinceCondition = since ? sql`and wno.created_at >= ${since}` : sql``;
  const [tokenRow] = await db
    .select({
      totalInput: sql<number>`coalesce(sum((wno.json->'tokens'->>'input')::numeric), 0)`,
      totalOutput: sql<number>`coalesce(sum((wno.json->'tokens'->>'output')::numeric), 0)`,
    })
    .from(workflowNodeOutput)
    .where(sql`${workflowNodeOutput.organizationId} = ${organizationId} ${tokenSinceCondition}`);

  return {
    totalRuns,
    successRuns,
    failedRuns,
    successRate: totalRuns > 0 ? Math.round((successRuns / totalRuns) * 1000) / 10 : 0,
    avgDurationMs: Math.round(Number(row?.avgDuration ?? 0)),
    totalInputTokens: Math.round(Number(tokenRow?.totalInput ?? 0)),
    totalOutputTokens: Math.round(Number(tokenRow?.totalOutput ?? 0)),
  };
}

/** 按天分组的运行趋势 */
export async function getDailyTrend(organizationId: string, since: Date): Promise<DailyCount[]> {
  const rows = await db
    .select({
      date: sql<string>`date_trunc('day', ${workflowSnapshot.timestamp})::date::text`,
      success: sql<number>`count(*) filter (where ${workflowSnapshot.dagStatus} = 'SUCCESS')`,
      failed: sql<number>`count(*) filter (where ${workflowSnapshot.dagStatus} in ('FAILED', 'ERROR', 'CANCELLED'))`,
    })
    .from(workflowSnapshot)
    .where(
      and(
        eq(workflowSnapshot.organizationId, organizationId),
        sql`${workflowSnapshot.timestamp} >= ${since}`,
        sql`${workflowSnapshot.snapshotId} in (
          select max(s2.snapshot_id) from workflow_snapshot s2
          where s2.organization_id = ${organizationId}
          and s2.timestamp >= ${since}
          group by s2.run_id
        )`,
      ),
    )
    .groupBy(sql`date_trunc('day', ${workflowSnapshot.timestamp})`)
    .orderBy(sql`date_trunc('day', ${workflowSnapshot.timestamp})`);

  return rows.map((r) => ({
    date: r.date,
    success: Number(r.success),
    failed: Number(r.failed),
  }));
}

/** 按天汇总的 Token 消耗 */
export async function getDailyTokens(organizationId: string, since: Date): Promise<TokenDaily[]> {
  const rows = await db
    .select({
      date: sql<string>`date_trunc('day', ${workflowNodeOutput.createdAt})::date::text`,
      inputTokens: sql<number>`coalesce(sum((json->'tokens'->>'input')::numeric), 0)`,
      outputTokens: sql<number>`coalesce(sum((json->'tokens'->>'output')::numeric), 0)`,
    })
    .from(workflowNodeOutput)
    .where(
      and(
        eq(workflowNodeOutput.organizationId, organizationId),
        sql`${workflowNodeOutput.createdAt} >= ${since}`,
      ),
    )
    .groupBy(sql`date_trunc('day', ${workflowNodeOutput.createdAt})`)
    .orderBy(sql`date_trunc('day', ${workflowNodeOutput.createdAt})`);

  return rows.map((r) => ({
    date: r.date,
    inputTokens: Math.round(Number(r.inputTokens)),
    outputTokens: Math.round(Number(r.outputTokens)),
  }));
}

/** 最近失败的运行 */
export async function getRecentFailedRuns(organizationId: string, limit = 10): Promise<FailedRun[]> {
  const rows = await db
    .select({
      runId: workflowSnapshot.runId,
      workflowId: workflowSnapshot.workflowId,
      dagStatus: workflowSnapshot.dagStatus,
      timestamp: workflowSnapshot.timestamp,
      workflowName: workflow.name,
    })
    .from(workflowSnapshot)
    .leftJoin(workflow, eq(workflowSnapshot.workflowId, workflow.id))
    .where(
      and(
        eq(workflowSnapshot.organizationId, organizationId),
        sql`${workflowSnapshot.dagStatus} in ('FAILED', 'ERROR', 'CANCELLED')`,
        sql`${workflowSnapshot.snapshotId} in (
          select max(s2.snapshot_id) from workflow_snapshot s2
          where s2.organization_id = ${organizationId}
          group by s2.run_id
        )`,
      ),
    )
    .orderBy(desc(workflowSnapshot.timestamp))
    .limit(limit);

  return rows.map((r) => ({
    runId: r.runId,
    workflowId: r.workflowId ?? "",
    workflowName: r.workflowName ?? "Unknown",
    dagStatus: r.dagStatus,
    startedAt: r.timestamp,
    completedAt: r.timestamp,
    durationMs: null,
  }));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/repositories/workflow-stats.ts
git commit -m "feat(workflow): add workflow-stats repository"
```

---

## Task 3: Backend stats API route

**Files:**
- Create: `src/routes/web/workflow-stats.ts`
- Modify: `src/routes/web/index.ts`

- [ ] **Step 1: Create `src/routes/web/workflow-stats.ts`**

```typescript
/**
 * Workflow Statistics API 路由。
 *
 * POST /web/workflow-stats — action 分发，聚合查询工作流运行统计。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  getDailyTokens,
  getDailyTrend,
  getRecentFailedRuns,
  getStatsOverview,
} from "../../repositories/workflow-stats";

const app = new Elysia({ name: "web-workflow-stats" }).use(authGuardPlugin);

app.post(
  "/workflow-stats",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as Record<string, unknown>;
    const action = payload.action as string;
    const range = payload.range as string;

    // 计算时间范围
    let since: Date | undefined;
    if (range === "7d") since = new Date(Date.now() - 7 * 86400000);
    else if (range === "30d") since = new Date(Date.now() - 30 * 86400000);
    // "all" or undefined → no since filter

    try {
      switch (action) {
        case "overview": {
          const data = await getStatsOverview(authCtx.organizationId, since);
          return { success: true, data };
        }

        case "trend": {
          if (!since) since = new Date(Date.now() - 30 * 86400000);
          const data = await getDailyTrend(authCtx.organizationId, since);
          return { success: true, data };
        }

        case "tokens": {
          if (!since) since = new Date(Date.now() - 30 * 86400000);
          const data = await getDailyTokens(authCtx.organizationId, since);
          return { success: true, data };
        }

        case "failedRuns": {
          const data = await getRecentFailedRuns(authCtx.organizationId);
          return { success: true, data };
        }

        default:
          return error(400, { error: { type: "VALIDATION_ERROR", message: `Unknown action: ${action}` } });
      }
    } catch (err: unknown) {
      console.error("[workflow-stats] Error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  { sessionAuth: true },
);

export default app;
```

- [ ] **Step 2: Register in `src/routes/web/index.ts`**

```typescript
import webWorkflowStats from "./workflow-stats";

// Add .use(webWorkflowStats) after webWorkflowJobsLogs:
  .use(webWorkflowStats)
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/workflow-stats.ts src/routes/web/index.ts
git commit -m "feat(workflow): add workflow-stats API route"
```

---

## Task 4: Frontend stats API client

**Files:**
- Create: `web/src/api/workflow-stats.ts`

- [ ] **Step 1: Create `web/src/api/workflow-stats.ts`**

```typescript
/**
 * Workflow Statistics API Client。
 *
 * 对接 POST /web/workflow-stats，通过 action 字段分发。
 */

export type StatsRange = "7d" | "30d" | "all";

export interface StatsOverview {
  totalRuns: number;
  successRuns: number;
  failedRuns: number;
  successRate: number;
  avgDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface DailyCount {
  date: string;
  success: number;
  failed: number;
}

export interface TokenDaily {
  date: string;
  inputTokens: number;
  outputTokens: number;
}

export interface FailedRun {
  runId: string;
  workflowId: string;
  workflowName: string;
  dagStatus: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

async function postAction(action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch("/web/workflow-stats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action, ...extra }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Unknown error");
  return json.data;
}

export const workflowStatsApi = {
  async overview(range: StatsRange): Promise<StatsOverview> {
    return postAction("overview", { range }) as Promise<StatsOverview>;
  },

  async trend(range: StatsRange): Promise<DailyCount[]> {
    const data = await postAction("trend", { range });
    return Array.isArray(data) ? data : [];
  },

  async tokens(range: StatsRange): Promise<TokenDaily[]> {
    const data = await postAction("tokens", { range });
    return Array.isArray(data) ? data : [];
  },

  async failedRuns(): Promise<FailedRun[]> {
    const data = await postAction("failedRuns");
    return Array.isArray(data) ? data : [];
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add web/src/api/workflow-stats.ts
git commit -m "feat(workflow): add workflow-stats API client"
```

---

## Task 5: Frontend i18n keys

**Files:**
- Modify: `web/src/i18n/locales/en/workflows.json`
- Modify: `web/src/i18n/locales/zh/workflows.json`

- [ ] **Step 1: Read both files, then add these English keys**

```json
  "tab_stats": "Statistics",
  "stats_total_runs": "Total Runs",
  "stats_success_rate": "Success Rate",
  "stats_avg_duration": "Avg Duration",
  "stats_total_tokens": "Tokens",
  "stats_input": "Input",
  "stats_output": "Output",
  "stats_7d": "7 Days",
  "stats_30d": "30 Days",
  "stats_all": "All",
  "stats_trend_title": "Run Trend",
  "stats_tokens_title": "Token Consumption",
  "stats_failed_title": "Recent Failures",
  "stats_no_data": "No data available",
  "stats_loading": "Loading statistics..."
```

- [ ] **Step 2: Add Chinese keys**

```json
  "tab_stats": "统计",
  "stats_total_runs": "总运行",
  "stats_success_rate": "成功率",
  "stats_avg_duration": "平均耗时",
  "stats_total_tokens": "Token",
  "stats_input": "输入",
  "stats_output": "输出",
  "stats_7d": "7 天",
  "stats_30d": "30 天",
  "stats_all": "全部",
  "stats_trend_title": "运行趋势",
  "stats_tokens_title": "Token 消耗",
  "stats_failed_title": "最近失败",
  "stats_no_data": "暂无数据",
  "stats_loading": "加载统计中..."
```

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/locales/en/workflows.json web/src/i18n/locales/zh/workflows.json
git commit -m "feat(workflow): add stats-related i18n keys"
```

---

## Task 6: WorkflowStats page component

**Files:**
- Create: `web/src/pages/workflow/WorkflowStats.tsx`

- [ ] **Step 1: Create `WorkflowStats.tsx`**

The page has:
- Top row: 4 metric cards (Total Runs, Success Rate, Avg Duration, Tokens)
- Time range selector: 7d / 30d / all buttons
- Chart 1: Run trend (LineChart — success + failed lines)
- Chart 2: Token consumption (AreaChart — input + output)
- Bottom: Recent failures table

```typescript
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  DailyCount,
  FailedRun,
  StatsOverview,
  StatsRange,
  TokenDaily,
} from "../../../api/workflow-stats";
import { workflowStatsApi } from "../../../api/workflow-stats";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-elevated p-4">
      <div className="text-[11px] font-semibold tracking-wide uppercase text-text-dim mb-1">{label}</div>
      <div className="text-2xl font-bold text-text-primary">{value}</div>
      {sub && <div className="text-[11px] text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

export function WorkflowStats() {
  const { t } = useTranslation("workflows");
  const [range, setRange] = useState<StatsRange>("30d");
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  const [trend, setTrend] = useState<DailyCount[]>([]);
  const [tokens, setTokens] = useState<TokenDaily[]>([]);
  const [failedRuns, setFailedRuns] = useState<FailedRun[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, tr, tk, fr] = await Promise.all([
        workflowStatsApi.overview(range),
        workflowStatsApi.trend(range),
        workflowStatsApi.tokens(range),
        workflowStatsApi.failedRuns(),
      ]);
      setOverview(ov);
      setTrend(tr);
      setTokens(tk);
      setFailedRuns(fr);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading && !overview) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-muted mr-2" />
        <span className="text-sm text-text-muted">{t("stats_loading")}</span>
      </div>
    );
  }

  const rangeButtons: { key: StatsRange; label: string }[] = [
    { key: "7d", label: t("stats_7d") },
    { key: "30d", label: t("stats_30d") },
    { key: "all", label: t("stats_all") },
  ];

  return (
    <div className="flex flex-col h-full overflow-y-auto p-6 space-y-6">
      {/* Header + range selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text-primary">{t("tab_stats")}</h2>
        <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-0.5">
          {rangeButtons.map((btn) => (
            <button
              key={btn.key}
              type="button"
              onClick={() => setRange(btn.key)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                range === btn.key
                  ? "bg-surface-elevated text-text-primary shadow-sm"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* Metric cards */}
      {overview && (
        <div className="grid grid-cols-4 gap-4">
          <MetricCard
            label={t("stats_total_runs")}
            value={String(overview.totalRuns)}
            sub={`${overview.successRuns} ${t("stats_success_rate").toLowerCase()} / ${overview.failedRuns} failed`}
          />
          <MetricCard
            label={t("stats_success_rate")}
            value={`${overview.successRate}%`}
          />
          <MetricCard
            label={t("stats_avg_duration")}
            value={formatDuration(overview.avgDurationMs)}
          />
          <MetricCard
            label={t("stats_total_tokens")}
            value={formatTokens(overview.totalInputTokens + overview.totalOutputTokens)}
            sub={`${t("stats_input")}: ${formatTokens(overview.totalInputTokens)} / ${t("stats_output")}: ${formatTokens(overview.totalOutputTokens)}`}
          />
        </div>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Run trend */}
        <div className="rounded-lg border border-border-subtle bg-surface-elevated p-4">
          <h3 className="text-sm font-semibold text-text-primary mb-3">{t("stats_trend_title")}</h3>
          {trend.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" />
                <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="success" stroke="#22c55e" strokeWidth={2} name="Success" />
                <Line type="monotone" dataKey="failed" stroke="#ef4444" strokeWidth={2} name="Failed" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-text-muted text-sm">
              {t("stats_no_data")}
            </div>
          )}
        </div>

        {/* Token consumption */}
        <div className="rounded-lg border border-border-subtle bg-surface-elevated p-4">
          <h3 className="text-sm font-semibold text-text-primary mb-3">{t("stats_tokens_title")}</h3>
          {tokens.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={tokens}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" />
                <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-muted)" />
                <Tooltip />
                <Legend />
                <Area type="monotone" dataKey="inputTokens" stroke="#3b82f6" fill="#3b82f620" name="Input" />
                <Area type="monotone" dataKey="outputTokens" stroke="#8b5cf6" fill="#8b5cf620" name="Output" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-text-muted text-sm">
              {t("stats_no_data")}
            </div>
          )}
        </div>
      </div>

      {/* Recent failures */}
      <div className="rounded-lg border border-border-subtle bg-surface-elevated p-4">
        <h3 className="text-sm font-semibold text-text-primary mb-3">{t("stats_failed_title")}</h3>
        {failedRuns.length > 0 ? (
          <div className="divide-y divide-border-subtle">
            {failedRuns.map((run) => (
              <div key={run.runId} className="flex items-center gap-3 py-2.5">
                <span className="h-2 w-2 rounded-full bg-red-500 flex-shrink-0" />
                <span className="text-sm text-text-primary flex-1 truncate">{run.workflowName}</span>
                <span className="text-[11px] font-mono text-text-dim">{run.dagStatus}</span>
                <span className="text-[11px] text-text-muted">
                  {new Date(run.startedAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-text-muted text-sm">{t("stats_no_data")}</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/WorkflowStats.tsx
git commit -m "feat(workflow): add WorkflowStats page component"
```

---

## Task 7: Add stats tab to workflow page

**Files:**
- Modify: `web/src/routes/agent/_panel/workflow.tsx`

- [ ] **Step 1: Read the file, then add stats tab**

Add lazy import near the top (after existing lazy imports):

```typescript
const WorkflowStats = lazy(() => import("../../../pages/workflow/WorkflowStats").then((m) => ({ default: m.WorkflowStats })));
```

Add to the `tabs` array (after the `runs` tab):

```typescript
{ id: "stats", icon: BarChart3, label: t("page.tab_stats") },
```

Add `BarChart3` to the lucide import.

Add conditional rendering in the content area:

```typescript
{tab === "stats" && (
  <Suspense>
    <WorkflowStats />
  </Suspense>
)}
```

- [ ] **Step 2: Verify build**

```bash
bun run build:web
```

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/agent/_panel/workflow.tsx
git commit -m "feat(workflow): add statistics tab to workflow page"
```

---

## Task 8: Final Verification

- [ ] **Step 1: Run precheck**

```bash
bun run precheck
```

- [ ] **Step 2: Run backend tests**

```bash
bun test src/__tests__/
```

- [ ] **Step 3: Run frontend build**

```bash
bun run build:web
```

- [ ] **Step 4: Fix and commit if needed**
