import schedule from "node-schedule";
import { scheduledTaskRepo } from "../repositories/task";
import { error, log } from "../logger";
import { createExecutionLog, executeTaskById, getTaskById } from "./task";

interface ScheduledJob {
  taskId: string;
  job: schedule.Job;
}

const runningTasks = new Set<string>();
const activeJobs = new Map<string, ScheduledJob>();

function toInvocationDate(invocation: unknown): Date | null {
  if (!invocation) {
    return null;
  }
  if (invocation instanceof Date) {
    return invocation;
  }
  if (typeof invocation === "object" && invocation !== null) {
    if ("toDate" in invocation && typeof invocation.toDate === "function") {
      return (invocation as { toDate: () => Date }).toDate();
    }
    if ("toJSDate" in invocation && typeof invocation.toJSDate === "function") {
      return (invocation as { toJSDate: () => Date }).toJSDate();
    }
  }
  return null;
}

async function executeTask(taskId: string): Promise<void> {
  if (runningTasks.has(taskId)) {
    try {
      // 并行写入日志和更新状态（两操作无依赖）
      await Promise.all([
        createExecutionLog({
          taskId,
          status: "skipped",
          triggeredBy: "cron",
          skipReason: "previous_run_still_active",
        }),
        scheduledTaskRepo.update(taskId, { lastStatus: "skipped", updatedAt: new Date() }),
      ]);
    } catch (err) {
      error(`[Scheduler] Failed to record skipped execution for task ${taskId}:`, err);
    }

    log(`[Scheduler] Task ${taskId} is already running, skipped`);
    return;
  }

  runningTasks.add(taskId);

  try {
    const task = await getTaskById(taskId);
    if (!task) {
      log(`[Scheduler] Task ${taskId} not found, removing stale job`);
      unscheduleTask(taskId);
      return;
    }
    if (!task.enabled) {
      log(`[Scheduler] Task ${taskId} is disabled, skipping`);
      return;
    }

    await executeTaskById(taskId, "cron", task);
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

  const handler = () => {
    log(`[Scheduler] Cron triggered for task ${task.id}`);
    executeTask(task.id).catch((err) => {
      error(`[Scheduler] Error in cron execution for task ${task.id}:`, err);
    });
  };

  const job = task.timezone
    ? schedule.scheduleJob({ rule: task.cron, tz: task.timezone }, handler)
    : schedule.scheduleJob({ rule: task.cron }, handler);

  if (!job) {
    error(`[Scheduler] Invalid cron expression "${task.cron}" for task ${task.id}, job not created`);
    return;
  }

  activeJobs.set(task.id, { taskId: task.id, job });
  const nextRunAt = toInvocationDate(job.nextInvocation());

  scheduledTaskRepo.update(task.id, { nextRunAt, updatedAt: new Date() })
    .catch((err) => { error(`[Scheduler] Failed to update nextRunAt for task ${task.id}:`, err); });

  log(`[Scheduler] Scheduled task ${task.id} with cron "${task.cron}" (tz: ${task.timezone ?? "server-local"})`);
}

export function unscheduleTask(taskId: string): void {
  const entry = activeJobs.get(taskId);
  if (entry) {
    entry.job.cancel();
    activeJobs.delete(taskId);
    log(`[Scheduler] Unscheduled task ${taskId}`);
  }
  // 清理残留的运行标记（任务可能在执行中被删除）
  runningTasks.delete(taskId);
}

export function rescheduleTask(task: { id: string; cron: string; timezone?: string | null; enabled?: boolean }): void {
  unscheduleTask(task.id);
  scheduleTask(task);
}

export async function startScheduler(): Promise<void> {
  try {
    const tasks = await scheduledTaskRepo.listEnabled();
    log(`[Scheduler] Starting scheduler, found ${tasks.length} enabled tasks`);
    for (const task of tasks) {
      scheduleTask(task);
    }
    log("[Scheduler] Scheduler started successfully");
  } catch (err) {
    error("[Scheduler] Failed to start scheduler:", err);
  }
}

export function stopScheduler(): void {
  const count = activeJobs.size;
  for (const [, entry] of activeJobs) {
    try {
      entry.job.cancel();
    } catch (err) {
      error(`[Scheduler] Failed to cancel job ${entry.taskId}:`, err);
    }
  }
  activeJobs.clear();
  runningTasks.clear();
  log(`[Scheduler] Scheduler stopped, cancelled ${count} jobs`);
}
