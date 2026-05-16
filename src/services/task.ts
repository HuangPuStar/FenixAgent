import { and, desc, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db";
import { scheduledTask, taskExecutionLog } from "../db/schema";

function generateTaskId(): string {
  return `task_${randomBytes(12).toString("hex")}`;
}

function generateLogId(): string {
  return `log_${randomBytes(12).toString("hex")}`;
}

function toUnixTimestamp(value: Date | null | undefined): number | null {
  return value ? Math.floor(value.getTime() / 1000) : null;
}

function truncateSummary(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.length > 2000 ? value.slice(0, 2000) : value;
}

export interface CreateTaskInput {
  name: string;
  description?: string;
  cron: string;
  timezone?: string | null;
  url: string;
  method?: string;
  headers?: Record<string, string> | null;
  body?: string | null;
}

export type UpdateTaskInput = Partial<CreateTaskInput> & { enabled?: boolean };
type ServiceErrorCode = "VALIDATION_ERROR" | "NOT_FOUND";
type ServiceError = { code: ServiceErrorCode; message: string };
type ServiceSuccess<T> = { success: true; data: T };
type ServiceFailure = { success: false; error: ServiceError };
type ServiceResult<T> = ServiceSuccess<T> | ServiceFailure;

interface TaskResponse {
  id: string;
  name: string;
  description: string | null;
  cron: string;
  timezone: string | null;
  enabled: boolean;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  body: string | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TaskExecutionLogResponse {
  id: string;
  taskId: string;
  status: string;
  error: string | null;
  duration: number | null;
  triggeredBy: string;
  statusCode: number | null;
  skipReason: string | null;
  resultSummary: string | null;
  createdAt: number;
}

function normalizeTimezone(timezone: string | null | undefined): string | null {
  if (timezone === undefined || timezone === null) {
    return null;
  }
  const trimmed = timezone.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validateCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "cron 表达式必须为 5 字段（分 时 日 月 周）";
  const validPattern = /^[\d*/?\-,LW#]+$/;
  for (const part of parts) {
    if (!validPattern.test(part)) return `cron 字段 "${part}" 包含非法字符`;
  }
  return null;
}

function validateTaskInput(data: CreateTaskInput, isUpdate = false): string | null {
  if (!isUpdate && (!data.name || data.name.trim().length === 0)) return "任务名称不能为空";
  if (data.name !== undefined && data.name.trim().length === 0) return "任务名称不能为空";
  if (data.name && data.name.length > 128) return "任务名称不能超过 128 字符";
  if (!isUpdate && (!data.url || data.url.trim().length === 0)) return "URL 不能为空";
  if (data.url !== undefined && data.url.trim().length === 0) return "URL 不能为空";
  if (!isUpdate && (!data.cron || data.cron.trim().length === 0)) return "cron 表达式不能为空";
  if (data.cron) {
    const cronErr = validateCron(data.cron);
    if (cronErr) return cronErr;
  }
  if (data.method && !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(data.method.toUpperCase())) {
    return "不支持的 HTTP 方法";
  }
  return null;
}

function sanitizeTask(row: typeof scheduledTask.$inferSelect): TaskResponse {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    cron: row.cron,
    timezone: row.timezone ?? null,
    enabled: row.enabled,
    url: row.url,
    method: row.method ?? "POST",
    headers: row.headers as Record<string, string> | null ?? null,
    body: row.body ?? null,
    lastRunAt: toUnixTimestamp(row.lastRunAt),
    nextRunAt: toUnixTimestamp(row.nextRunAt),
    lastStatus: row.lastStatus ?? null,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
  };
}

function sanitizeExecutionLog(row: typeof taskExecutionLog.$inferSelect): TaskExecutionLogResponse {
  return {
    id: row.id,
    taskId: row.taskId,
    status: row.status,
    error: row.error ?? null,
    duration: row.duration ?? null,
    triggeredBy: row.triggeredBy,
    statusCode: null,
    skipReason: row.skipReason ?? null,
    resultSummary: row.resultSummary ?? null,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
  };
}

export async function createTask(userId: string, data: CreateTaskInput): Promise<ServiceResult<TaskResponse>> {
  const validationError = validateTaskInput(data);
  if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

  const id = generateTaskId();
  const now = new Date();
  const timezone = normalizeTimezone(data.timezone);

  await db.insert(scheduledTask).values({
    id,
    userId,
    name: data.name.trim(),
    description: data.description?.trim() ?? null,
    cron: data.cron.trim(),
    timezone,
    enabled: true,
    url: data.url.trim(),
    method: data.method?.toUpperCase() ?? "POST",
    headers: data.headers ? JSON.stringify(data.headers) : null,
    body: data.body ?? null,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await db.select().from(scheduledTask).where(eq(scheduledTask.id, id));
  return { success: true, data: sanitizeTask(row) };
}

export async function listTasks(userId: string): Promise<ServiceSuccess<TaskResponse[]>> {
  const rows = await db.select().from(scheduledTask)
    .where(eq(scheduledTask.userId, userId))
    .orderBy(desc(scheduledTask.createdAt));
  return {
    success: true,
    data: rows.map(sanitizeTask),
  };
}

export async function getTask(userId: string, taskId: string): Promise<ServiceResult<TaskResponse>> {
  const [row] = await db.select().from(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  if (!row) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  return { success: true, data: sanitizeTask(row) };
}

export async function updateTask(userId: string, taskId: string, data: UpdateTaskInput): Promise<ServiceResult<TaskResponse>> {
  const [existing] = await db.select().from(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  const validationError = validateTaskInput(data as CreateTaskInput, true);
  if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

  const updates: Partial<typeof scheduledTask.$inferInsert> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name.trim();
  if (data.description !== undefined) updates.description = data.description?.trim() ?? null;
  if (data.cron !== undefined) updates.cron = data.cron.trim();
  if (data.timezone !== undefined) updates.timezone = normalizeTimezone(data.timezone);
  if (data.url !== undefined) updates.url = data.url.trim();
  if (data.method !== undefined) updates.method = data.method.toUpperCase();
  if (data.headers !== undefined) updates.headers = data.headers ? JSON.stringify(data.headers) : null;
  if (data.body !== undefined) updates.body = data.body;
  if (data.enabled !== undefined) updates.enabled = data.enabled;

  await db.update(scheduledTask).set(updates).where(eq(scheduledTask.id, taskId));

  const [row] = await db.select().from(scheduledTask).where(eq(scheduledTask.id, taskId));
  return { success: true, data: sanitizeTask(row) };
}

export async function deleteTask(userId: string, taskId: string): Promise<ServiceResult<undefined>> {
  const [existing] = await db.select({ id: scheduledTask.id }).from(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  await db.delete(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  return { success: true, data: undefined };
}

export async function toggleTask(userId: string, taskId: string): Promise<ServiceResult<{ id: string; enabled: boolean }>> {
  const [existing] = await db.select().from(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  const newEnabled = !existing.enabled;
  await db.update(scheduledTask)
    .set({ enabled: newEnabled, updatedAt: new Date() })
    .where(eq(scheduledTask.id, taskId));

  return { success: true, data: { id: taskId, enabled: newEnabled } };
}

export async function executeTaskById(
  taskId: string,
  triggeredBy: "cron" | "manual",
): Promise<ServiceResult<TaskExecutionLogResponse>> {
  const task = await getTaskById(taskId);
  if (!task) {
    return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  }

  const logId = generateLogId();
  const now = new Date();
  const startTime = Date.now();

  try {
    const headers: Record<string, string> = task.headers
      ? (typeof task.headers === "string" ? JSON.parse(task.headers) : task.headers) as Record<string, string>
      : {};
    if (!headers["Content-Type"] && task.method?.toUpperCase() !== "GET") {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(task.url, {
      method: task.method ?? "POST",
      headers,
      body: task.method?.toUpperCase() === "GET" ? undefined : (task.body ?? undefined),
    });

    const duration = Date.now() - startTime;
    const responseText = await response.text().catch(() => "");
    const status = response.ok ? "success" : "failed";
    const resultSummary = truncateSummary(responseText || `HTTP ${response.status}`);

    await db.insert(taskExecutionLog).values({
      id: logId,
      taskId: task.id,
      status,
      error: response.ok ? null : `HTTP ${response.status}: ${responseText.slice(0, 500)}`,
      duration,
      triggeredBy,
      skipReason: null,
      resultSummary,
      createdAt: now,
    });

    await db.update(scheduledTask)
      .set({ lastRunAt: now, lastStatus: status, updatedAt: now })
      .where(eq(scheduledTask.id, task.id));

    const [logRow] = await db.select().from(taskExecutionLog).where(eq(taskExecutionLog.id, logId));
    return { success: true, data: sanitizeExecutionLog(logRow) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const duration = Date.now() - startTime;

    await db.insert(taskExecutionLog).values({
      id: logId,
      taskId: task.id,
      status: "failed",
      error: message,
      duration,
      triggeredBy,
      skipReason: null,
      resultSummary: truncateSummary(message),
      createdAt: now,
    });

    await db.update(scheduledTask)
      .set({ lastRunAt: now, lastStatus: "failed", updatedAt: now })
      .where(eq(scheduledTask.id, task.id));

    const [logRow] = await db.select().from(taskExecutionLog).where(eq(taskExecutionLog.id, logId));
    return { success: true, data: sanitizeExecutionLog(logRow) };
  }
}

export async function triggerTask(userId: string, taskId: string): Promise<ServiceResult<TaskExecutionLogResponse>> {
  const [task] = await db.select().from(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  if (!task) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  return executeTaskById(taskId, "manual");
}

export async function listExecutionLogs(
  taskId: string,
  page = 1,
  pageSize = 20,
): Promise<ServiceSuccess<{ total: number; items: TaskExecutionLogResponse[] }>> {
  const offset = (page - 1) * pageSize;
  const [{ count: total }] = await db.select({ count: sql<number>`count(*)` })
    .from(taskExecutionLog)
    .where(eq(taskExecutionLog.taskId, taskId));
  const rows = await db.select().from(taskExecutionLog)
    .where(eq(taskExecutionLog.taskId, taskId))
    .orderBy(desc(taskExecutionLog.createdAt))
    .limit(pageSize)
    .offset(offset);

  return {
    success: true,
    data: {
      total,
      items: rows.map(sanitizeExecutionLog),
    },
  };
}

export async function clearExecutionLogs(taskId: string): Promise<ServiceSuccess<undefined>> {
  await db.delete(taskExecutionLog).where(eq(taskExecutionLog.taskId, taskId));
  return { success: true, data: undefined };
}

export async function getTaskById(taskId: string) {
  const [row] = await db.select().from(scheduledTask).where(eq(scheduledTask.id, taskId));
  return row ?? null;
}

export async function createExecutionLog(params: {
  taskId: string;
  status: "success" | "failed" | "timeout" | "skipped";
  error?: string | null;
  duration?: number | null;
  triggeredBy?: "cron" | "manual";
  skipReason?: string | null;
  resultSummary?: string | null;
}) {
  const logId = generateLogId();
  const now = new Date();
  await db.insert(taskExecutionLog).values({
    id: logId,
    taskId: params.taskId,
    status: params.status,
    error: params.error ?? null,
    duration: params.duration ?? null,
    triggeredBy: params.triggeredBy ?? "cron",
    skipReason: params.skipReason ?? null,
    resultSummary: truncateSummary(params.resultSummary),
    createdAt: now,
  });
  return logId;
}
