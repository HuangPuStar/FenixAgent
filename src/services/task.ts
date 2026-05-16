import { randomBytes } from "node:crypto";
import { scheduledTaskRepo, taskExecutionLogRepo } from "../repositories/task";
import type { ScheduledTaskRow, TaskExecutionLogRow, ScheduledTaskInsert } from "../repositories/task";
import { scheduleTask, rescheduleTask, unscheduleTask } from "./scheduler";
import { parseJsonb } from "./config/jsonb";
import { error as logError } from "../logger";

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

/** 支持的 HTTP 方法白名单 */
const VALID_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

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
type ServiceErrorCode = "VALIDATION_ERROR" | "NOT_FOUND" | "WRITE_ERROR";
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

function validateTaskInput(data: Partial<CreateTaskInput>, isUpdate = false): string | null {
  if (data.name !== undefined) {
    if (data.name.trim().length === 0) return "任务名称不能为空";
    if (data.name.length > 128) return "任务名称不能超过 128 字符";
  }
  if (!isUpdate && !data.name) return "任务名称不能为空";
  if (data.url !== undefined && data.url.trim().length === 0) return "URL 不能为空";
  if (!isUpdate && !data.url) return "URL 不能为空";
  if (!isUpdate && (!data.cron || data.cron.trim().length === 0)) return "cron 表达式不能为空";
  if (data.cron !== undefined && data.cron.trim().length === 0) return "cron 表达式不能为空";
  if (data.cron) {
    const cronErr = validateCron(data.cron);
    if (cronErr) return cronErr;
  }
  if (data.method !== undefined) {
    if (typeof data.method !== "string" || data.method.trim().length === 0) return "HTTP 方法不能为空";
    if (!VALID_HTTP_METHODS.includes(data.method.toUpperCase() as typeof VALID_HTTP_METHODS[number])) {
      return "不支持的 HTTP 方法";
    }
  }
  return null;
}

/** 解析 headers：复用 parseJsonb 兼容旧双重编码数据 */
function parseHeaders(value: unknown): Record<string, string> | null {
  return parseJsonb<Record<string, string>>(value);
}

function sanitizeTask(row: ScheduledTaskRow): TaskResponse {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    cron: row.cron,
    timezone: row.timezone ?? null,
    enabled: row.enabled,
    url: row.url,
    method: row.method ?? "POST",
    headers: parseHeaders(row.headers),
    body: row.body ?? null,
    lastRunAt: toUnixTimestamp(row.lastRunAt),
    nextRunAt: toUnixTimestamp(row.nextRunAt),
    lastStatus: row.lastStatus ?? null,
    createdAt: toUnixTimestamp(row.createdAt) ?? 0,
    updatedAt: toUnixTimestamp(row.updatedAt) ?? 0,
  };
}

function sanitizeExecutionLog(row: TaskExecutionLogRow): TaskExecutionLogResponse {
  return {
    id: row.id,
    taskId: row.taskId,
    status: row.status,
    error: row.error ?? null,
    duration: row.duration ?? null,
    triggeredBy: row.triggeredBy,
    skipReason: row.skipReason ?? null,
    resultSummary: row.resultSummary ?? null,
    createdAt: toUnixTimestamp(row.createdAt) ?? 0,
  };
}

export async function createTask(userId: string, data: CreateTaskInput): Promise<ServiceResult<TaskResponse>> {
  const validationError = validateTaskInput(data);
  if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

  const id = generateTaskId();
  const now = new Date();
  const timezone = normalizeTimezone(data.timezone);

  const row = await scheduledTaskRepo.create({
    id,
    userId,
    name: data.name.trim(),
    description: data.description?.trim() ?? null,
    cron: data.cron.trim(),
    timezone,
    enabled: true,
    url: data.url.trim(),
    method: data.method?.toUpperCase() ?? "POST",
    headers: data.headers ?? null,
    body: data.body ?? null,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    createdAt: now,
    updatedAt: now,
  });

  const result = sanitizeTask(row);
  if (result.enabled) {
    scheduleTask({ id: result.id, cron: result.cron, timezone: result.timezone, enabled: result.enabled });
  }

  return { success: true, data: result };
}

export async function listTasks(userId: string): Promise<ServiceSuccess<TaskResponse[]>> {
  const rows = await scheduledTaskRepo.listByUser(userId);
  return {
    success: true,
    data: rows.map(sanitizeTask),
  };
}

export async function getTask(userId: string, taskId: string): Promise<ServiceResult<TaskResponse>> {
  const row = await scheduledTaskRepo.getByUserAndId(userId, taskId);
  if (!row) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  return { success: true, data: sanitizeTask(row) };
}

export async function updateTask(userId: string, taskId: string, data: UpdateTaskInput): Promise<ServiceResult<TaskResponse>> {
  const existing = await scheduledTaskRepo.getByUserAndId(userId, taskId);
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  const validationError = validateTaskInput(data, true);
  if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

  const updates: Partial<ScheduledTaskInsert> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name.trim();
  if (data.description !== undefined) updates.description = data.description?.trim() ?? null;
  if (data.cron !== undefined) updates.cron = data.cron.trim();
  if (data.timezone !== undefined) updates.timezone = normalizeTimezone(data.timezone);
  if (data.url !== undefined) updates.url = data.url.trim();
  if (data.method !== undefined) updates.method = data.method.toUpperCase();
  if (data.headers !== undefined) updates.headers = data.headers ?? null;
  if (data.body !== undefined) updates.body = data.body;
  if (data.enabled !== undefined) updates.enabled = data.enabled;

  const row = await scheduledTaskRepo.update(taskId, updates);
  if (!row) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在（更新后未找到）" } };
  const result = sanitizeTask(row);
  rescheduleTask({ id: result.id, cron: result.cron, timezone: result.timezone, enabled: result.enabled });

  return { success: true, data: result };
}

export async function deleteTask(userId: string, taskId: string): Promise<ServiceResult<undefined>> {
  const deleted = await scheduledTaskRepo.deleteByUserAndId(userId, taskId);
  if (!deleted) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  unscheduleTask(taskId);
  return { success: true, data: undefined };
}

export async function toggleTask(userId: string, taskId: string): Promise<ServiceResult<{ id: string; enabled: boolean }>> {
  const existing = await scheduledTaskRepo.getByUserAndId(userId, taskId);
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  const newEnabled = !existing.enabled;
  await scheduledTaskRepo.update(taskId, { enabled: newEnabled, updatedAt: new Date() });

  if (newEnabled) {
    scheduleTask({ id: taskId, cron: existing.cron, timezone: existing.timezone, enabled: true });
  } else {
    unscheduleTask(taskId);
  }

  return { success: true, data: { id: taskId, enabled: newEnabled } };
}

/** 写入执行日志 + 更新任务状态 + 返回规范化结果（成功/错误路径��用） */
async function writeLogAndReturn(
  logId: string,
  taskId: string,
  status: string,
  errorMsg: string | null,
  duration: number,
  triggeredBy: "cron" | "manual",
  resultSummary: string | null,
  now: Date,
): Promise<ServiceResult<TaskExecutionLogResponse>> {
  try {
    await taskExecutionLogRepo.create({
      id: logId,
      taskId,
      status,
      error: errorMsg,
      duration,
      triggeredBy,
      skipReason: null,
      resultSummary,
      createdAt: now,
    });
  } catch (err) {
    logError("[Task] Failed to write execution log for task", taskId, err);
    return { success: false, error: { code: "WRITE_ERROR", message: "执行日志写入失败" } };
  }

  // 尽力而为更新任务状态（不阻塞返回，失败仅记日志）
  scheduledTaskRepo.update(taskId, { lastRunAt: now, lastStatus: status, updatedAt: now })
    .catch((err) => { logError("[Task] Failed to update task status for", taskId, err); });

  return {
    success: true,
    data: {
      id: logId,
      taskId,
      status,
      error: errorMsg,
      duration,
      triggeredBy,
      skipReason: null,
      resultSummary,
      createdAt: Math.floor(now.getTime() / 1000),
    },
  };
}

export async function executeTaskById(
  taskId: string,
  triggeredBy: "cron" | "manual",
  prefetchedTask?: ScheduledTaskRow,
): Promise<ServiceResult<TaskExecutionLogResponse>> {
  const task = prefetchedTask ?? await getTaskById(taskId);
  if (!task) {
    return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  }

  const logId = generateLogId();
  const now = new Date();
  const startTime = Date.now();
  const method = (task.method ?? "POST").toUpperCase();

  try {
    const headers: Record<string, string> = parseHeaders(task.headers) ?? {};
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
    if (!hasContentType && method !== "GET") {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(task.url, {
      method,
      headers,
      body: method === "GET" ? undefined : (task.body ?? undefined),
      signal: AbortSignal.timeout(30_000),
    });

    const duration = Date.now() - startTime;
    const responseText = await response.text().catch(() => "");
    const status = response.ok ? "success" : "failed";
    const resultSummary = truncateSummary(responseText || `HTTP ${response.status}`);

    // HTTP 错误时构建有意义的 error message（空 body 时不留尾部冒号）
    const errorMsg = response.ok
      ? null
      : responseText
        ? `HTTP ${response.status}: ${responseText.slice(0, 500)}`
        : `HTTP ${response.status}`;

    return writeLogAndReturn(
      logId, task.id, status,
      errorMsg,
      duration, triggeredBy, resultSummary, now,
    );
  } catch (err: unknown) {
    logError("[Task] Execution failed for task", taskId, err);
    // 区分超时和其他错误：AbortSignal.timeout 触发 AbortError 或 TimeoutError（Bun）
    const isTimeout = err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
    const message = err instanceof Error ? err.message : String(err);
    const duration = Date.now() - startTime;

    return writeLogAndReturn(
      logId, task.id, isTimeout ? "timeout" : "failed",
      message, duration, triggeredBy, truncateSummary(message), now,
    );
  }
}

export async function triggerTask(userId: string, taskId: string): Promise<ServiceResult<TaskExecutionLogResponse>> {
  const task = await scheduledTaskRepo.getByUserAndId(userId, taskId);
  if (!task) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  return executeTaskById(taskId, "manual", task);
}

export async function listExecutionLogs(
  taskId: string,
  page = 1,
  pageSize = 20,
): Promise<ServiceSuccess<{ total: number; items: TaskExecutionLogResponse[] }>> {
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const { rows, total } = await taskExecutionLogRepo.listByTaskPaged(taskId, safePage, safePageSize);

  return {
    success: true,
    data: {
      total,
      items: rows.map(sanitizeExecutionLog),
    },
  };
}

export async function clearExecutionLogs(taskId: string): Promise<ServiceSuccess<undefined>> {
  await taskExecutionLogRepo.deleteByTask(taskId);
  return { success: true, data: undefined };
}

export async function getTaskById(taskId: string): Promise<ScheduledTaskRow | null> {
  return scheduledTaskRepo.getById(taskId);
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
  await taskExecutionLogRepo.create({
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
