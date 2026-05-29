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
  boardId: string;
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
  data: { boardId: string; workflowId: string; version: number; params?: Record<string, unknown> },
): Promise<WorkflowJobRow> {
  const [row] = await db
    .insert(workflowJob)
    .values({
      boardId: data.boardId,
      organizationId,
      userId,
      workflowId: data.workflowId,
      version: data.version,
      params: data.params ?? null,
      status: "ready",
    })
    .returning();
  return row as WorkflowJobRow;
}

/** 获取单个 Job */
export async function getJob(jobId: string, organizationId: string): Promise<WorkflowJobRow | null> {
  const [row] = await db
    .select()
    .from(workflowJob)
    .where(and(eq(workflowJob.id, jobId), eq(workflowJob.organizationId, organizationId)))
    .limit(1);
  return (row as WorkflowJobRow) ?? null;
}

/** 列出组织的所有 Job（含工作流名称和创建人） */
export async function listJobs(organizationId: string, boardId?: string): Promise<WorkflowJobListItem[]> {
  const conditions = [eq(workflowJob.organizationId, organizationId)];
  if (boardId) {
    conditions.push(eq(workflowJob.boardId, boardId));
  }

  const rows = await db
    .select({
      job: workflowJob,
      workflowName: workflow.name,
      userName: user.name,
    })
    .from(workflowJob)
    .innerJoin(workflow, eq(workflowJob.workflowId, workflow.id))
    .leftJoin(user, eq(workflowJob.userId, user.id))
    .where(and(...conditions))
    .orderBy(desc(workflowJob.updatedAt));

  return rows.map((r) => ({
    ...(r.job as WorkflowJobRow),
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
    .where(
      and(eq(workflowJob.id, jobId), eq(workflowJob.organizationId, organizationId), eq(workflowJob.status, "ready")),
    )
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
