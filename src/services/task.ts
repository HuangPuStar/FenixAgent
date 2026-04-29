import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db";
import { environment, scheduledTask, taskExecutionLog } from "../db/schema";
import {
  type AgentTaskRunResult,
  type RunAgentTaskInput,
  runAgentTask,
} from "./agent-task-runner";

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
  environmentId: string;
  task: string;
  timeoutMinutes?: number;
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
  environmentId: string;
  environmentName: string | null;
  task: string;
  timeoutMinutes: number;
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
  workspacePath: string | null;
  workspaceName: string | null;
  environmentId: string | null;
  environmentName: string | null;
  taskSnapshot: string | null;
  skipReason: string | null;
  resultSummary: string | null;
  createdAt: number;
}

type OwnedEnvironment = {
  id: string;
  name: string;
  workspacePath: string;
  agentName: string | null;
};

type RunAgentTaskFn = (input: RunAgentTaskInput) => Promise<AgentTaskRunResult>;

let runAgentTaskImpl: RunAgentTaskFn = runAgentTask;

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

function validateTimeoutMinutes(timeoutMinutes: number | undefined): string | null {
  if (timeoutMinutes === undefined) {
    return null;
  }
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 180) {
    return "超时时间必须在 1-180 分钟之间";
  }
  return null;
}

function validateTaskInput(data: CreateTaskInput, isUpdate = false): string | null {
  if (!isUpdate && (!data.name || data.name.trim().length === 0)) return "任务名称不能为空";
  if (data.name !== undefined && data.name.trim().length === 0) return "任务名称不能为空";
  if (data.name && data.name.length > 128) return "任务名称不能超过 128 字符";
  if (!isUpdate && (!data.environmentId || data.environmentId.trim().length === 0)) return "Environment 不能为空";
  if (data.environmentId !== undefined && data.environmentId.trim().length === 0) return "Environment 不能为空";
  if (!isUpdate && (!data.task || data.task.trim().length === 0)) return "任务内容不能为空";
  if (data.task !== undefined && data.task.trim().length === 0) return "任务内容不能为空";
  if (data.task && (data.task.length < 1 || data.task.length > 10000)) return "任务内容长度必须在 1-10000 字符之间";
  if (!isUpdate && (!data.cron || data.cron.trim().length === 0)) return "cron 表达式不能为空";
  if (data.cron) {
    const cronErr = validateCron(data.cron);
    if (cronErr) return cronErr;
  }
  const timeoutError = validateTimeoutMinutes(data.timeoutMinutes);
  if (timeoutError) {
    return timeoutError;
  }
  return null;
}

async function getOwnedEnvironment(userId: string, environmentId: string): Promise<OwnedEnvironment | null> {
  const [row] = await db.select({
    id: environment.id,
    name: environment.name,
    workspacePath: environment.workspacePath,
    agentName: environment.agentName,
  }).from(environment).where(and(eq(environment.id, environmentId), eq(environment.userId, userId)));

  return row ?? null;
}

async function loadEnvironmentMap(environmentIds: string[]): Promise<Map<string, string>> {
  if (environmentIds.length === 0) {
    return new Map();
  }

  const rows = await db.select({
    id: environment.id,
    name: environment.name,
  }).from(environment).where(inArray(environment.id, Array.from(new Set(environmentIds))));

  return new Map(rows.map((row) => [row.id, row.name]));
}

function sanitizeTask(row: typeof scheduledTask.$inferSelect, environmentName: string | null): TaskResponse {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    cron: row.cron,
    timezone: row.timezone ?? null,
    enabled: row.enabled,
    environmentId: row.environmentId,
    environmentName,
    task: row.task,
    timeoutMinutes: row.timeoutMinutes,
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
    workspacePath: row.workspacePath ?? null,
    workspaceName: row.workspaceName ?? null,
    environmentId: row.environmentId ?? null,
    environmentName: row.environmentName ?? null,
    taskSnapshot: row.taskSnapshot ?? null,
    skipReason: row.skipReason ?? null,
    resultSummary: row.resultSummary ?? null,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
  };
}

export async function createTask(userId: string, data: CreateTaskInput): Promise<ServiceResult<TaskResponse>> {
  const validationError = validateTaskInput(data);
  if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

  const ownedEnvironment = await getOwnedEnvironment(userId, data.environmentId);
  if (!ownedEnvironment) {
    return { success: false, error: { code: "VALIDATION_ERROR", message: "Environment 不存在或无权访问" } };
  }

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
    environmentId: ownedEnvironment.id,
    task: data.task.trim(),
    timeoutMinutes: data.timeoutMinutes ?? 30,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await db.select().from(scheduledTask).where(eq(scheduledTask.id, id));
  return { success: true, data: sanitizeTask(row, ownedEnvironment.name) };
}

export async function listTasks(userId: string): Promise<ServiceSuccess<TaskResponse[]>> {
  const rows = await db.select().from(scheduledTask)
    .where(eq(scheduledTask.userId, userId))
    .orderBy(desc(scheduledTask.createdAt));
  const environmentMap = await loadEnvironmentMap(rows.map((row) => row.environmentId));
  return {
    success: true,
    data: rows.map((row) => sanitizeTask(row, environmentMap.get(row.environmentId) ?? null)),
  };
}

export async function getTask(userId: string, taskId: string): Promise<ServiceResult<TaskResponse>> {
  const [row] = await db.select().from(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  if (!row) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  const ownedEnvironment = await getOwnedEnvironment(userId, row.environmentId);
  return { success: true, data: sanitizeTask(row, ownedEnvironment?.name ?? null) };
}

export async function updateTask(userId: string, taskId: string, data: UpdateTaskInput): Promise<ServiceResult<TaskResponse>> {
  const [existing] = await db.select().from(scheduledTask)
    .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  const validationError = validateTaskInput(data as CreateTaskInput, true);
  if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

  const targetEnvironmentId = data.environmentId ?? existing.environmentId;
  const ownedEnvironment = await getOwnedEnvironment(userId, targetEnvironmentId);
  if (!ownedEnvironment) {
    return { success: false, error: { code: "VALIDATION_ERROR", message: "Environment 不存在或无权访问" } };
  }

  const updates: Partial<typeof scheduledTask.$inferInsert> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name.trim();
  if (data.description !== undefined) updates.description = data.description?.trim() ?? null;
  if (data.cron !== undefined) updates.cron = data.cron.trim();
  if (data.timezone !== undefined) updates.timezone = normalizeTimezone(data.timezone);
  if (data.environmentId !== undefined) updates.environmentId = ownedEnvironment.id;
  if (data.task !== undefined) updates.task = data.task.trim();
  if (data.timeoutMinutes !== undefined) updates.timeoutMinutes = data.timeoutMinutes;
  if (data.enabled !== undefined) updates.enabled = data.enabled;

  await db.update(scheduledTask).set(updates).where(eq(scheduledTask.id, taskId));

  const [row] = await db.select().from(scheduledTask).where(eq(scheduledTask.id, taskId));
  return { success: true, data: sanitizeTask(row, ownedEnvironment.name) };
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

  const ownedEnvironment = await getOwnedEnvironment(task.userId, task.environmentId);
  if (!ownedEnvironment) {
    return { success: false, error: { code: "VALIDATION_ERROR", message: "Environment 不存在或无权访问" } };
  }

  const logId = generateLogId();
  const now = new Date();

  try {
    const result = await runAgentTaskImpl({
      userId: task.userId,
      environmentId: task.environmentId,
      taskId: task.id,
      taskText: task.task,
      timeoutMinutes: task.timeoutMinutes,
      logId,
    });

    await db.insert(taskExecutionLog).values({
      id: logId,
      taskId: task.id,
      status: result.status,
      error: result.error,
      duration: result.duration,
      triggeredBy,
      workspacePath: result.workspacePath,
      workspaceName: result.workspaceName,
      environmentId: task.environmentId,
      environmentName: ownedEnvironment.name,
      taskSnapshot: task.task,
      skipReason: null,
      resultSummary: truncateSummary(result.resultSummary),
      createdAt: now,
    });

    await db.update(scheduledTask)
      .set({ lastRunAt: now, lastStatus: result.status, updatedAt: now })
      .where(eq(scheduledTask.id, task.id));

    const [logRow] = await db.select().from(taskExecutionLog).where(eq(taskExecutionLog.id, logId));
    return { success: true, data: sanitizeExecutionLog(logRow) };
  } catch (error: any) {
    const message = error?.message ?? String(error);

    await db.insert(taskExecutionLog).values({
      id: logId,
      taskId: task.id,
      status: "failed",
      error: message,
      duration: null,
      triggeredBy,
      workspacePath: null,
      workspaceName: null,
      environmentId: task.environmentId,
      environmentName: ownedEnvironment.name,
      taskSnapshot: task.task,
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
  workspacePath?: string | null;
  workspaceName?: string | null;
  environmentId?: string | null;
  environmentName?: string | null;
  taskSnapshot?: string | null;
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
    workspacePath: params.workspacePath ?? null,
    workspaceName: params.workspaceName ?? null,
    environmentId: params.environmentId ?? null,
    environmentName: params.environmentName ?? null,
    taskSnapshot: params.taskSnapshot ?? null,
    skipReason: params.skipReason ?? null,
    resultSummary: truncateSummary(params.resultSummary),
    createdAt: now,
  });
  return logId;
}

export function setRunAgentTaskForTesting(fn: RunAgentTaskFn | null): void {
  runAgentTaskImpl = fn ?? runAgentTask;
}
