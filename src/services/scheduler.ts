import schedule from "node-schedule";
import { db } from "../db";
import { scheduledTask } from "../db/schema";
import { eq } from "drizzle-orm";
import { getTaskById, createExecutionLog } from "./task";
import { log, error } from "../logger";

interface ScheduledJob {
  taskId: string;
  job: schedule.Job;
}

/** 正在执行中的任务集合（用于并发控制） */
const runningTasks = new Set<string>();

/** 内存中所有活跃的 cron Job */
const activeJobs = new Map<string, ScheduledJob>();

async function executeTask(taskId: string, triggeredBy: string = "cron", attempt: number = 1): Promise<void> {
  if (runningTasks.has(taskId)) {
    log(`[Scheduler] Task ${taskId} is already running, skipping`);
    return;
  }
  runningTasks.add(taskId);

  try {
    const task = await getTaskById(taskId);
    if (!task) {
      log(`[Scheduler] Task ${taskId} not found, skipping`);
      return;
    }
    if (!task.enabled) {
      log(`[Scheduler] Task ${taskId} is disabled, skipping`);
      return;
    }

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

    await createExecutionLog({
      taskId: task.id,
      status,
      statusCode,
      responseBody,
      error: errorMsg,
      duration,
      attempt,
      triggeredBy,
    });

    const job = activeJobs.get(taskId);
    const nextInvocation = job?.job?.nextInvocation();
    const nextRunAt = nextInvocation ?? null;

    await db.update(scheduledTask)
      .set({ lastRunAt: now, lastStatus: status, nextRunAt, updatedAt: now })
      .where(eq(scheduledTask.id, task.id));

    if (
      status === "failed" &&
      task.retryEnabled &&
      attempt < task.retryCount
    ) {
      const retryAttempt = attempt + 1;
      const retryDelayMs = task.retryInterval * 1000;
      log(`[Scheduler] Task ${taskId} failed (attempt ${attempt}/${task.retryCount}), retrying in ${task.retryInterval}s`);
      setTimeout(() => {
        executeTask(taskId, "retry", retryAttempt);
      }, retryDelayMs);
    }
  } catch (err) {
    error(`[Scheduler] Unexpected error executing task ${taskId}:`, err);
  } finally {
    runningTasks.delete(taskId);
  }
}

export function scheduleTask(task: { id: string; cron: string; timezone?: string | null; enabled?: boolean }): void {
  if (activeJobs.has(task.id)) {
    unscheduleTask(task.id);
  }

  if (!task.enabled) {
    log(`[Scheduler] Task ${task.id} is disabled, not scheduling`);
    return;
  }

  const job = schedule.scheduleJob(
    { rule: task.cron, tz: task.timezone ?? "UTC" },
    () => {
      log(`[Scheduler] Cron triggered for task ${task.id}`);
      executeTask(task.id).catch((err) => {
        error(`[Scheduler] Error in cron execution for task ${task.id}:`, err);
      });
    }
  );

  if (job) {
    activeJobs.set(task.id, { taskId: task.id, job });
    const nextInvocation = job.nextInvocation();
    if (nextInvocation) {
      const nextRunAt = nextInvocation instanceof Date ? nextInvocation : new Date(nextInvocation);
      db.update(scheduledTask)
        .set({ nextRunAt, updatedAt: new Date() })
        .where(eq(scheduledTask.id, task.id))
        .then(() => {})
        .catch(() => {});
    }
    log(`[Scheduler] Scheduled task ${task.id} with cron "${task.cron}" (tz: ${task.timezone ?? "UTC"})`);
  } else {
    error(`[Scheduler] Invalid cron expression "${task.cron}" for task ${task.id}, job not created`);
  }
}

export function unscheduleTask(taskId: string): void {
  const entry = activeJobs.get(taskId);
  if (entry) {
    entry.job.cancel();
    activeJobs.delete(taskId);
    log(`[Scheduler] Unscheduled task ${taskId}`);
  }
}

export function rescheduleTask(task: { id: string; cron: string; timezone?: string | null; enabled?: boolean }): void {
  unscheduleTask(task.id);
  scheduleTask(task);
  log(`[Scheduler] Rescheduled task ${task.id}`);
}

export async function startScheduler(): Promise<void> {
  try {
    const tasks = await db.select().from(scheduledTask)
      .where(eq(scheduledTask.enabled, true));
    log(`[Scheduler] Starting scheduler, found ${tasks.length} enabled tasks`);
    for (const task of tasks) {
      scheduleTask(task);
    }
    log(`[Scheduler] Scheduler started successfully`);
  } catch (err) {
    error("[Scheduler] Failed to start scheduler:", err);
  }
}

export function stopScheduler(): void {
  const count = activeJobs.size;
  for (const [, entry] of activeJobs) {
    entry.job.cancel();
  }
  activeJobs.clear();
  runningTasks.clear();
  log(`[Scheduler] Scheduler stopped, cancelled ${count} jobs`);
}
