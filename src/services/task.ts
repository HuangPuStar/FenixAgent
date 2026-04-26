import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { scheduledTask, taskExecutionLog } from "../db/schema";
import { randomBytes } from "node:crypto";

function generateTaskId(): string {
  return `task_${randomBytes(12).toString("hex")}`;
}
function generateLogId(): string {
  return `log_${randomBytes(12).toString("hex")}`;
}

export interface CreateTaskInput {
  name: string;
  description?: string;
  cron: string;
  timezone?: string;
  url: string;
  method?: string;
  headers?: Record<string, string> | null;
  body?: string | null;
  timeout?: number;
  retryEnabled?: boolean;
  retryCount?: number;
  retryInterval?: number;
}
export type UpdateTaskInput = Partial<CreateTaskInput> & { enabled?: boolean };

const SENSITIVE_HEADER_KEYS = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"]);

function maskHeaders(headers: Record<string, string> | null): Record<string, string> | null {
  if (!headers) return null;
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) {
      masked[key] = value.length > 4 ? `***${value.slice(-4)}` : "***";
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

function sanitizeTask(row: any) {
  const parsedHeaders = row.headers ? JSON.parse(row.headers) : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    url: row.url,
    method: row.method,
    headers: maskHeaders(parsedHeaders),
    body: row.body ?? null,
    timeout: row.timeout,
    retryEnabled: row.retryEnabled,
    retryCount: row.retryCount,
    retryInterval: row.retryInterval,
    lastRunAt: row.lastRunAt ? Math.floor(row.lastRunAt.getTime() / 1000) : null,
    nextRunAt: row.nextRunAt ? Math.floor(row.nextRunAt.getTime() / 1000) : null,
    lastStatus: row.lastStatus ?? null,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
  };
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

const VALID_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
function validateTaskInput(data: CreateTaskInput, isUpdate = false): string | null {
  if (!isUpdate && (!data.name || data.name.trim().length === 0)) return "任务名称不能为空";
  if (data.name && data.name.length > 128) return "任务名称不能超过 128 字符";
  if (!isUpdate && (!data.url || data.url.trim().length === 0)) return "URL 不能为空";
  if (data.url && !/^https?:\/\//.test(data.url)) return "URL 必须以 http:// 或 https:// 开头";
  if (!isUpdate && (!data.cron || data.cron.trim().length === 0)) return "cron 表达式不能为空";
  if (data.cron) {
    const cronErr = validateCron(data.cron);
    if (cronErr) return cronErr;
  }
  if (data.method && !VALID_METHODS.includes(data.method.toUpperCase())) return "HTTP 方法必须为 GET/POST/PUT/DELETE/PATCH";
  if (data.timeout !== undefined && (data.timeout < 1000 || data.timeout > 300000)) return "超时必须在 1000-300000ms 之间";
  if (data.retryCount !== undefined && (data.retryCount < 0 || data.retryCount > 10)) return "重试次数必须在 0-10 之间";
  if (data.retryInterval !== undefined && (data.retryInterval < 10 || data.retryInterval > 3600)) return "重试间隔必须在 10-3600s 之间";
  return null;
}

export async function createTask(userId: string, data: CreateTaskInput) {
  const validationError = validateTaskInput(data);
  if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

  const id = generateTaskId();
  const now = new Date();
  const headersJson = data.headers ? JSON.stringify(data.headers) : null;

  await db.insert(scheduledTask).values({
    id,
    userId,
    name: data.name.trim(),
    description: data.description?.trim() ?? null,
    cron: data.cron.trim(),
    timezone: data.timezone ?? "UTC",
    enabled: true,
    url: data.url.trim(),
    method: (data.method ?? "GET").toUpperCase(),
    headers: headersJson,
    body: data.body ?? null,
    timeout: data.timeout ?? 30000,
    retryEnabled: data.retryEnabled ?? false,
    retryCount: data.retryCount ?? 3,
    retryInterval: data.retryInterval ?? 60,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await db.select().from(scheduledTask).where(eq(scheduledTask.id, id));
  return { success: true, data: sanitizeTask(row) };
}

export async function listTasks(userId: string) {
  const rows = await db.select().from(scheduledTask)
    .where(eq(scheduledTask.userId, userId))
    .orderBy(desc(scheduledTask.createdAt));
  return { success: true, data: rows.map(sanitizeTask) };
}

export async function getTask(userId: string, taskId: string) {
  const [row] = await db.select().from(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  if (!row) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  return { success: true, data: sanitizeTask(row) };
}

export async function updateTask(userId: string, taskId: string, data: UpdateTaskInput) {
  const [existing] = await db.select().from(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  const validationError = validateTaskInput(data as CreateTaskInput, true);
  if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name.trim();
  if (data.description !== undefined) updates.description = data.description?.trim() ?? null;
  if (data.cron !== undefined) updates.cron = data.cron.trim();
  if (data.timezone !== undefined) updates.timezone = data.timezone;
  if (data.url !== undefined) updates.url = data.url.trim();
  if (data.method !== undefined) updates.method = data.method.toUpperCase();
  if (data.headers !== undefined) updates.headers = data.headers ? JSON.stringify(data.headers) : null;
  if (data.body !== undefined) updates.body = data.body ?? null;
  if (data.timeout !== undefined) updates.timeout = data.timeout;
  if (data.retryEnabled !== undefined) updates.retryEnabled = data.retryEnabled;
  if (data.retryCount !== undefined) updates.retryCount = data.retryCount;
  if (data.retryInterval !== undefined) updates.retryInterval = data.retryInterval;

  await db.update(scheduledTask).set(updates).where(eq(scheduledTask.id, taskId));

  const [row] = await db.select().from(scheduledTask).where(eq(scheduledTask.id, taskId));
  return { success: true, data: sanitizeTask(row) };
}

export async function deleteTask(userId: string, taskId: string) {
  const result = db.delete(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)))
    .run() as any;
  if (result.changes === 0) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  return { success: true };
}

export async function toggleTask(userId: string, taskId: string) {
  const [existing] = await db.select().from(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  const newEnabled = !existing.enabled;
  await db.update(scheduledTask)
    .set({ enabled: newEnabled, updatedAt: new Date() })
    .where(eq(scheduledTask.id, taskId));

  return { success: true, data: { id: taskId, enabled: newEnabled } };
}

export async function triggerTask(userId: string, taskId: string) {
  const [task] = await db.select().from(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  if (!task) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  const logId = generateLogId();
  const startTime = Date.now();
  let status = "success";
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let errorMsg: string | null = null;

  try {
    const headers: Record<string, string> = task.headers ? JSON.parse(task.headers) : {};
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), task.timeout);

    const fetchOptions: RequestInit = {
      method: task.method,
      headers,
      signal: controller.signal,
    };
    if (task.body && ["POST", "PUT", "PATCH"].includes(task.method)) {
      fetchOptions.body = task.body;
    }

    const response = await fetch(task.url, fetchOptions);
    clearTimeout(timeoutId);
    statusCode = response.status;
    const text = await response.text();
    responseBody = text.length > 4096 ? text.slice(0, 4096) : text;
    if (!response.ok) {
      status = "failed";
      errorMsg = `HTTP ${response.status}`;
    }
  } catch (err: any) {
    status = "failed";
    errorMsg = err.message ?? String(err);
  }

  const duration = Date.now() - startTime;
  const now = new Date();

  await db.insert(taskExecutionLog).values({
    id: logId,
    taskId: task.id,
    status,
    statusCode,
    responseBody,
    error: errorMsg,
    duration,
    attempt: 1,
    triggeredBy: "manual",
    createdAt: now,
  });

  await db.update(scheduledTask)
    .set({ lastRunAt: now, lastStatus: status, updatedAt: now })
    .where(eq(scheduledTask.id, task.id));

  return {
    success: true,
    data: {
      id: logId,
      taskId: task.id,
      status,
      statusCode,
      responseBody,
      error: errorMsg,
      duration,
      triggeredBy: "manual",
      createdAt: Math.floor(now.getTime() / 1000),
    },
  };
}

export async function listExecutionLogs(taskId: string, page = 1, pageSize = 20) {
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
      items: rows.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        status: r.status,
        statusCode: r.statusCode,
        responseBody: r.responseBody,
        error: r.error,
        duration: r.duration,
        attempt: r.attempt,
        triggeredBy: r.triggeredBy,
        createdAt: Math.floor(r.createdAt.getTime() / 1000),
      })),
    },
  };
}

export async function clearExecutionLogs(taskId: string) {
  db.delete(taskExecutionLog).where(eq(taskExecutionLog.taskId, taskId)).run();
  return { success: true };
}

export async function getTaskById(taskId: string) {
  const [row] = await db.select().from(scheduledTask).where(eq(scheduledTask.id, taskId));
  return row ?? null;
}

export async function createExecutionLog(params: {
  taskId: string;
  status: string;
  statusCode?: number | null;
  responseBody?: string | null;
  error?: string | null;
  duration?: number | null;
  attempt?: number;
  triggeredBy?: string;
}) {
  const logId = generateLogId();
  const now = new Date();
  await db.insert(taskExecutionLog).values({
    id: logId,
    taskId: params.taskId,
    status: params.status,
    statusCode: params.statusCode ?? null,
    responseBody: params.responseBody ? (params.responseBody.length > 4096 ? params.responseBody.slice(0, 4096) : params.responseBody) : null,
    error: params.error ?? null,
    duration: params.duration ?? null,
    attempt: params.attempt ?? 1,
    triggeredBy: params.triggeredBy ?? "cron",
    createdAt: now,
  });
  return logId;
}
