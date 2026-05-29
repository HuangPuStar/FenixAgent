/**
 * Workflow Statistics Repository。
 *
 * 聚合查询工作流运行统计数据。
 */

import { desc, eq, sql } from "drizzle-orm";
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

// ── helpers ──

/** 获取每个 runId 的最新快照子查询（DISTINCT ON） */
function latestSnapshotSubquery(organizationId: string, since?: Date) {
  const conditions = [eq(workflowSnapshot.organizationId, organizationId)];
  if (since) {
    conditions.push(sql`${workflowSnapshot.createdAt} >= ${since}`);
  }
  return db
    .selectDistinctOn([workflowSnapshot.runId])
    .from(workflowSnapshot)
    .where(sql.join(conditions, sql` and `))
    .orderBy(workflowSnapshot.runId, desc(workflowSnapshot.createdAt))
    .as("latest");
}

// ── 查询 ──

/** 概览：总运行数、成功率、平均耗时、总 Token */
export async function getStatsOverview(organizationId: string, since?: Date): Promise<StatsOverview> {
  const latest = latestSnapshotSubquery(organizationId, since);

  const rows = await db
    .select({
      dagStatus: latest.dagStatus,
    })
    .from(latest);

  const totalRuns = rows.length;
  const successRuns = rows.filter((r) => r.dagStatus === "SUCCESS").length;
  const failedRuns = rows.filter((r) => ["FAILED", "ERROR", "CANCELLED"].includes(r.dagStatus)).length;

  // 平均耗时：从每个 run 的第一个快照到最后一个快照
  const durationRows = await db
    .select({
      runId: workflowSnapshot.runId,
      firstTs: sql<Date>`min(${workflowSnapshot.createdAt})`,
      lastTs: sql<Date>`max(${workflowSnapshot.createdAt})`,
    })
    .from(workflowSnapshot)
    .where(
      sql`${workflowSnapshot.organizationId} = ${organizationId}
        ${since ? sql` and ${workflowSnapshot.createdAt} >= ${since}` : sql``}
        and ${workflowSnapshot.runId} in (select run_id from workflow_snapshot s2 where s2.dag_status in ('SUCCESS','FAILED','ERROR','CANCELLED') and s2.organization_id = ${organizationId} group by s2.run_id)
      `,
    )
    .groupBy(workflowSnapshot.runId);

  const avgDurationMs =
    durationRows.length > 0
      ? Math.round(
          durationRows.reduce((sum, r) => sum + (new Date(r.lastTs).getTime() - new Date(r.firstTs).getTime()), 0) /
            durationRows.length,
        )
      : 0;

  // Token 聚合
  const tokenCondition = since
    ? sql`${workflowNodeOutput.organizationId} = ${organizationId} and ${workflowNodeOutput.createdAt} >= ${since}`
    : sql`${workflowNodeOutput.organizationId} = ${organizationId}`;
  const [tokenRow] = await db
    .select({
      totalInput: sql<number>`coalesce(sum((json->'tokens'->>'input')::numeric), 0)`,
      totalOutput: sql<number>`coalesce(sum((json->'tokens'->>'output')::numeric), 0)`,
    })
    .from(workflowNodeOutput)
    .where(tokenCondition);

  return {
    totalRuns,
    successRuns,
    failedRuns,
    successRate: totalRuns > 0 ? Math.round((successRuns / totalRuns) * 1000) / 10 : 0,
    avgDurationMs,
    totalInputTokens: Math.round(Number(tokenRow?.totalInput ?? 0)),
    totalOutputTokens: Math.round(Number(tokenRow?.totalOutput ?? 0)),
  };
}

/** 按天分组的运行趋势 */
export async function getDailyTrend(organizationId: string, since: Date): Promise<DailyCount[]> {
  const latest = latestSnapshotSubquery(organizationId, since);

  const rows = await db
    .select({
      dagStatus: latest.dagStatus,
      date: sql<string>`date_trunc('day', ${latest.createdAt})::date::text`,
    })
    .from(latest);

  // 聚合到按天
  const byDate = new Map<string, { success: number; failed: number }>();
  for (const r of rows) {
    const existing = byDate.get(r.date) ?? { success: 0, failed: 0 };
    if (r.dagStatus === "SUCCESS") existing.success++;
    else if (["FAILED", "ERROR", "CANCELLED"].includes(r.dagStatus)) existing.failed++;
    byDate.set(r.date, existing);
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));
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
      sql`${workflowNodeOutput.organizationId} = ${organizationId} and ${workflowNodeOutput.createdAt} >= ${since}`,
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
  const latest = latestSnapshotSubquery(organizationId);

  const rows = await db
    .select({
      runId: latest.runId,
      workflowId: latest.workflowId,
      dagStatus: latest.dagStatus,
      completedAt: latest.createdAt,
    })
    .from(latest)
    .where(sql`${latest.dagStatus} in ('FAILED', 'ERROR', 'CANCELLED')`)
    .orderBy(desc(latest.createdAt))
    .limit(limit);

  // 查 workflow 名称 + 开始时间
  const result: FailedRun[] = [];
  for (const r of rows) {
    let workflowName = "Unknown";
    if (r.workflowId) {
      const [wf] = await db
        .select({ name: workflow.name })
        .from(workflow)
        .where(eq(workflow.id, r.workflowId))
        .limit(1);
      if (wf) workflowName = wf.name;
    }

    // 获取该 run 的第一个快照时间（startedAt）
    const [firstSnap] = await db
      .select({ createdAt: workflowSnapshot.createdAt })
      .from(workflowSnapshot)
      .where(sql`${workflowSnapshot.runId} = ${r.runId} and ${workflowSnapshot.organizationId} = ${organizationId}`)
      .orderBy(workflowSnapshot.createdAt)
      .limit(1);

    const startedAt = firstSnap?.createdAt ?? r.completedAt;
    const durationMs =
      startedAt && r.completedAt ? new Date(r.completedAt).getTime() - new Date(startedAt).getTime() : null;

    result.push({
      runId: r.runId,
      workflowId: r.workflowId ?? "",
      workflowName,
      dagStatus: r.dagStatus,
      startedAt,
      completedAt: r.completedAt,
      durationMs,
    });
  }

  return result;
}
