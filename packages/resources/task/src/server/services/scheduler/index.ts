import { randomUUID } from "node:crypto";
import { log, error as logError } from "@fenix/logger";
import schedule from "node-schedule";
import { taskExecutionLogRepo } from "../../repositories/task";
import type { ScheduledTaskV2Row } from "../../repositories/task-v2";
import { scheduledTaskV2Repo } from "../../repositories/task-v2";
import { agentExecutor } from "./agent-executor";
import { httpExecutor } from "./http-executor";
import type { TaskExecInput, TaskExecOutput, TaskExecutor } from "./types";
import { toInvocationDate } from "./utils";

export type { TaskExecInput, TaskExecOutput, TaskExecutor };

export class SchedulerService {
  private executors = new Map<string, TaskExecutor>();
  private activeJobs = new Map<string, schedule.Job>();
  private runningTasks = new Set<string>();

  constructor() {
    this.register(httpExecutor);
    this.register(agentExecutor);
  }

  register(executor: TaskExecutor): void {
    this.executors.set(executor.type, executor);
    log(`[SchedulerService] Registered executor: type=${executor.type}`);
  }

  async start(): Promise<void> {
    const tasks = await scheduledTaskV2Repo.listEnabled();
    log(`[SchedulerService] Starting, found ${tasks.length} enabled tasks`);

    let failed = 0;
    for (const task of tasks) {
      const ok = this.schedule(task);
      if (!ok) failed++;
    }
    if (failed > 0) {
      log(`[SchedulerService] Started with ${failed} failed job(s) (invalid cron expression)`);
    } else {
      log("[SchedulerService] Started successfully");
    }
  }

  stop(): void {
    const count = this.activeJobs.size;
    for (const [taskId, job] of this.activeJobs) {
      try {
        job.cancel();
      } catch (err) {
        logError(`[SchedulerService] Failed to cancel job ${taskId}:`, err);
      }
    }
    this.activeJobs.clear();
    this.runningTasks.clear();
    log(`[SchedulerService] Stopped, cancelled ${count} jobs`);
  }

  schedule(task: ScheduledTaskV2Row): boolean {
    this.unschedule(task.id);

    if (!task.enabled) {
      return true;
    }

    const handler = () => {
      log(`[SchedulerService] Cron triggered for task ${task.id}`);
      this.execute(task.id, "cron").catch((err) => {
        logError(`[SchedulerService] Error in cron execution for task ${task.id}:`, err);
      });
    };

    const config = task.timezone ? { rule: task.cron, tz: task.timezone } : { rule: task.cron };

    const job = schedule.scheduleJob(config as schedule.RecurrenceSpecObjLit, handler);

    if (!job) {
      logError(`[SchedulerService] Invalid cron expression "${task.cron}" for task ${task.id}`);
      return false;
    }

    this.activeJobs.set(task.id, job);
    const nextRunAt = toInvocationDate(job.nextInvocation());

    scheduledTaskV2Repo.update(task.id, { nextRunAt, updatedAt: new Date() }).catch((err) => {
      logError(`[SchedulerService] Failed to update nextRunAt for task ${task.id}:`, err);
    });

    return true;
  }

  unschedule(taskId: string): void {
    const job = this.activeJobs.get(taskId);
    if (job) {
      job.cancel();
      this.activeJobs.delete(taskId);
    }
    this.runningTasks.delete(taskId);
  }

  reschedule(task: ScheduledTaskV2Row): boolean {
    this.unschedule(task.id);
    return this.schedule(task);
  }

  async execute(taskId: string, triggeredBy: "cron" | "manual"): Promise<TaskExecOutput> {
    if (this.runningTasks.has(taskId)) {
      await taskExecutionLogRepo.create({
        id: randomUUID(),
        taskId,
        status: "skipped",
        error: null,
        duration: null,
        triggeredBy,
        skipReason: "previous_run_still_active",
        resultSummary: null,
        createdAt: new Date(),
      });

      scheduledTaskV2Repo
        .update(taskId, { lastStatus: "skipped", updatedAt: new Date() })
        .catch((err) => logError(`[SchedulerService] Failed to update failed status for ${taskId}:`, err));
      return { status: "failed", error: "previous_run_still_active", duration: 0, resultSummary: "skipped" };
    }

    this.runningTasks.add(taskId);

    try {
      const task = await scheduledTaskV2Repo.getById(taskId);
      if (!task) {
        this.unschedule(taskId);
        return { status: "failed", error: "task not found", duration: 0 };
      }
      if (!task.enabled) {
        this.unschedule(taskId);
        return { status: "failed", error: "task disabled", duration: 0 };
      }

      const executor = this.executors.get(task.type);
      if (!executor) {
        const msg = `No executor found for type "${task.type}"`;
        logError(`[SchedulerService] ${msg}`);

        await taskExecutionLogRepo.create({
          id: randomUUID(),
          taskId,
          status: "failed",
          error: msg,
          duration: 0,
          triggeredBy,
          skipReason: null,
          resultSummary: msg,
          createdAt: new Date(),
        });

        scheduledTaskV2Repo
          .update(taskId, { lastRunAt: new Date(), lastStatus: "failed", updatedAt: new Date() })
          .catch((err) => logError(`[SchedulerService] Failed to update failed status for ${taskId}:`, err));
        return { status: "failed", error: msg, duration: 0 };
      }

      const output = await executor.execute({ task, triggeredBy });

      await taskExecutionLogRepo.create({
        id: randomUUID(),
        taskId,
        status: output.status,
        error: output.error ?? null,
        duration: output.duration,
        triggeredBy,
        skipReason: null,
        resultSummary: output.resultSummary ?? null,
        createdAt: new Date(),
      });

      scheduledTaskV2Repo
        .update(taskId, { lastRunAt: new Date(), lastStatus: output.status, updatedAt: new Date() })
        .catch((err) => {
          logError(`[SchedulerService] Failed to update lastStatus for ${taskId}:`, err);
        });

      return output;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[SchedulerService] Unexpected error executing task ${taskId}:`, msg);

      await taskExecutionLogRepo.create({
        id: randomUUID(),
        taskId,
        status: "failed",
        error: msg,
        duration: 0,
        triggeredBy,
        skipReason: null,
        resultSummary: msg.slice(0, 2000),
        createdAt: new Date(),
      });

      return { status: "failed", error: msg, duration: 0 };
    } finally {
      this.runningTasks.delete(taskId);
    }
  }
}

export const schedulerService = new SchedulerService();
