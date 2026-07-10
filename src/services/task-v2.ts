import { randomUUID } from "node:crypto";
import { log as logInfo } from "@fenix/logger";
import { taskExecutionLogRepo } from "../repositories/task";
import type { ScheduledTaskV2Insert, ScheduledTaskV2Row } from "../repositories/task-v2";
import { scheduledTaskV2Repo } from "../repositories/task-v2";
import { schedulerService } from "./scheduler/index";
import type { TaskExecOutput } from "./scheduler/types";

// ── 类型 ──

export interface CreateTaskV2Input {
  name: string;
  description?: string;
  cron: string;
  timezone?: string | null;
  timeoutSeconds?: number;
  type: "http" | "agent";
  agentId?: string | null;
  definition: Record<string, unknown>;
}

export type UpdateTaskV2Input = Partial<CreateTaskV2Input> & { enabled?: boolean };

type ServiceErrorCode = "VALIDATION_ERROR" | "NOT_FOUND" | "WRITE_ERROR";
type ServiceError = { code: ServiceErrorCode; message: string };
type ServiceSuccess<T> = { success: true; data: T };
type ServiceFailure = { success: false; error: ServiceError };
type ServiceResult<T> = ServiceSuccess<T> | ServiceFailure;

interface TaskV2Response {
  id: string;
  name: string;
  description: string | null;
  cron: string;
  timezone: string | null;
  enabled: boolean;
  timeoutSeconds: number;
  type: string;
  agentId: string | null;
  definition: unknown;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ExecutionLogResponse {
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

// ── 工具 ──

function toUnixTimestamp(value: Date | null | undefined): number | null {
  return value ? Math.floor(value.getTime() / 1000) : null;
}

function normalizeTimezone(timezone: string | null | undefined): string | null {
  if (timezone === undefined || timezone === null) return null;
  const trimmed = timezone.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function sanitizeTask(row: ScheduledTaskV2Row): TaskV2Response {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    cron: row.cron,
    timezone: row.timezone ?? null,
    enabled: row.enabled,
    timeoutSeconds: row.timeoutSeconds,
    type: row.type,
    agentId: row.agentId ?? null,
    definition: row.definition as unknown,
    lastRunAt: toUnixTimestamp(row.lastRunAt),
    nextRunAt: toUnixTimestamp(row.nextRunAt),
    lastStatus: row.lastStatus ?? null,
    createdAt: toUnixTimestamp(row.createdAt) ?? 0,
    updatedAt: toUnixTimestamp(row.updatedAt) ?? 0,
  };
}

// ── 校验 ──

/** 仅校验 Zod schema 无法覆盖的跨字段约束和 cron 语义 */
function validateTaskInput(data: Partial<CreateTaskV2Input>, isUpdate = false): string | null {
  // cron 语义格式校验（5 字段 + 合法字符，Zod 只校验非空）
  if (data.cron) {
    const parts = data.cron.trim().split(/\s+/);
    if (parts.length !== 5) return "cron 表达式必须为 5 字段（分 时 日 月 周）";
    const validPattern = /^[\d*/?\-,LW#]+$/;
    for (const part of parts) {
      if (!validPattern.test(part)) return `cron 字段 "${part}" 包含非法字符`;
    }
  }

  // 跨字段约束：agent 类型必须绑定 agentId（Zod schema 中 agentId 为 optional/nullable）
  if (!isUpdate && data.type === "agent" && !data.agentId) return "Agent 任务必须指定 agentId";

  return null;
}

// ── CRUD ──

export async function createTaskV2(
  organizationId: string,
  data: CreateTaskV2Input,
  userId?: string,
): Promise<ServiceResult<TaskV2Response>> {
  const validationError = validateTaskInput(data);
  if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

  const id = randomUUID();
  const now = new Date();
  const timezone = normalizeTimezone(data.timezone);

  const insertData: ScheduledTaskV2Insert = {
    id,
    userId: userId ?? organizationId,
    organizationId,
    name: data.name.trim(),
    description: data.description?.trim() ?? null,
    cron: data.cron.trim(),
    timezone,
    enabled: true,
    timeoutSeconds: data.timeoutSeconds ?? 300,
    type: data.type,
    agentId: data.agentId ?? null,
    definition: data.definition as unknown,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    createdAt: now,
    updatedAt: now,
  };

  const row = await scheduledTaskV2Repo.create(insertData);
  const result = sanitizeTask(row);

  if (result.enabled) {
    const scheduled = schedulerService.schedule(row);
    if (!scheduled) {
      logInfo(`[TaskV2] Task ${result.id} created but cron job not scheduled (invalid cron expression)`);
    }
  }

  return { success: true, data: result };
}

export async function listTasksV2(
  organizationId: string,
  page = 1,
  pageSize = 20,
  opts?: { keyword?: string; type?: string; agentId?: string },
): Promise<ServiceSuccess<{ items: TaskV2Response[]; total: number; page: number; pageSize: number }>> {
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const { rows, total } = await scheduledTaskV2Repo.listByOrganizationPaged(
    organizationId,
    safePage,
    safePageSize,
    opts,
  );
  return {
    success: true,
    data: { items: rows.map(sanitizeTask), total: Number(total), page: safePage, pageSize: safePageSize },
  };
}

export async function getTaskV2(organizationId: string, taskId: string): Promise<ServiceResult<TaskV2Response>> {
  const row = await scheduledTaskV2Repo.getByOrgAndId(organizationId, taskId);
  if (!row) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  return { success: true, data: sanitizeTask(row) };
}

export async function updateTaskV2(
  organizationId: string,
  taskId: string,
  data: UpdateTaskV2Input,
): Promise<ServiceResult<TaskV2Response>> {
  const existing = await scheduledTaskV2Repo.getByOrgAndId(organizationId, taskId);
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  // type 不可修改
  if (data.type !== undefined && data.type !== existing.type) {
    return { success: false, error: { code: "VALIDATION_ERROR", message: "任务类型不可修改" } };
  }

  const validationError = validateTaskInput({ ...data, type: existing.type as "http" | "agent" }, true);
  if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

  const updates: Partial<ScheduledTaskV2Insert> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name.trim();
  if (data.description !== undefined) updates.description = data.description?.trim() ?? null;
  if (data.cron !== undefined) updates.cron = data.cron.trim();
  if (data.timezone !== undefined) updates.timezone = normalizeTimezone(data.timezone);
  if (data.timeoutSeconds !== undefined) updates.timeoutSeconds = data.timeoutSeconds;
  if (data.agentId !== undefined) {
    if (existing.type !== "agent") {
      return { success: false, error: { code: "VALIDATION_ERROR", message: "HTTP 任务不能指定 agentId" } };
    }
    updates.agentId = data.agentId;
  }
  if (data.definition !== undefined) updates.definition = data.definition as unknown;
  if (data.enabled !== undefined) updates.enabled = data.enabled;

  const row = await scheduledTaskV2Repo.update(taskId, updates);
  if (!row) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在（更新后未找到）" } };

  const result = sanitizeTask(row);

  const schedulingChanged = data.cron !== undefined || data.timezone !== undefined || data.enabled !== undefined;
  if (schedulingChanged) {
    schedulerService.reschedule(row);
  }

  return { success: true, data: result };
}

export async function deleteTaskV2(organizationId: string, taskId: string): Promise<ServiceResult<undefined>> {
  const deleted = await scheduledTaskV2Repo.deleteByOrgAndId(organizationId, taskId);
  if (!deleted) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  schedulerService.unschedule(taskId);
  return { success: true, data: undefined };
}

export async function toggleTaskV2(
  organizationId: string,
  taskId: string,
): Promise<ServiceResult<{ id: string; enabled: boolean }>> {
  const existing = await scheduledTaskV2Repo.getByOrgAndId(organizationId, taskId);
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  const newEnabled = !existing.enabled;
  const updated = await scheduledTaskV2Repo.update(taskId, { enabled: newEnabled, updatedAt: new Date() });
  if (!updated) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在（更新失败）" } };

  if (newEnabled) {
    schedulerService.schedule(updated);
  } else {
    schedulerService.unschedule(taskId);
  }

  return { success: true, data: { id: taskId, enabled: newEnabled } };
}

export async function triggerTaskV2(organizationId: string, taskId: string): Promise<ServiceResult<TaskExecOutput>> {
  const task = await scheduledTaskV2Repo.getByOrgAndId(organizationId, taskId);
  if (!task) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

  const output = await schedulerService.execute(taskId, "manual");
  return { success: true, data: output };
}

export async function listExecutionLogsV2(
  taskId: string,
  page = 1,
  pageSize = 20,
): Promise<ServiceSuccess<{ total: number; items: ExecutionLogResponse[] }>> {
  const safePage = Math.max(1, Math.floor(page));
  const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const { rows, total } = await taskExecutionLogRepo.listByTaskPaged(taskId, safePage, safePageSize);

  return {
    success: true,
    data: {
      total: Number(total),
      items: rows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        status: row.status,
        error: row.error ?? null,
        duration: row.duration ?? null,
        triggeredBy: row.triggeredBy,
        skipReason: row.skipReason ?? null,
        resultSummary: row.resultSummary ?? null,
        createdAt: toUnixTimestamp(row.createdAt) ?? 0,
      })),
    },
  };
}

export async function clearExecutionLogsV2(organizationId: string, taskId: string): Promise<ServiceResult<undefined>> {
  const task = await scheduledTaskV2Repo.getByOrgAndId(organizationId, taskId);
  if (!task) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
  await taskExecutionLogRepo.deleteByTask(taskId);
  return { success: true, data: undefined };
}
