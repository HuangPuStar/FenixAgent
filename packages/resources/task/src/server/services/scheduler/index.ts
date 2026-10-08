import { randomUUID } from "node:crypto";
import { log, error as logError, requestAls } from "@fenix/logger";
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
      // cron 触发没有上游请求，关联 ID 必须在入口自建：node-schedule 的定时器继承**创建 job 时**的
      // 异步上下文，而 job 通常由 HTTP 请求（新建/改 cron/启用任务）建立，触发时 ALS 里残留的是那个
      // 请求的 requestId（2026-09-24 实测 `run` 与 `enterWith` 两种写法皆如此）。沿用会把一次定时执行
      // 关联到创建它的请求上，所以这里显式自建，并用它覆盖继承来的上下文。
      const requestId = randomUUID();
      requestAls.run({ requestId }, () => {
        log(`[SchedulerService] Cron triggered for task ${task.id}`, { requestId, triggeredBy: "cron" });
        this.execute(task.id, "cron", requestId).catch((err) => {
          logError(`[SchedulerService] Error in cron execution for task ${task.id}:`, err);
        });
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

  /**
   * 执行任务。
   *
   * `triggerRequestId` 是触发方显式给出的关联 ID：cron 入口自建后传入（见 `schedule`，那里的值是本次
   * 触发的权威关联 ID，必须优先于继承来的 ALS 上下文）；HTTP/manual 触发不传，由这里从 ALS 取触发请求的
   * `requestId`；两者都缺（非请求上下文直接调用）时自建，保证每条执行都能被关联、不会退化成空值。
   */
  async execute(taskId: string, triggeredBy: "cron" | "manual", triggerRequestId?: string): Promise<TaskExecOutput> {
    const requestId = triggerRequestId ?? requestAls.getStore()?.requestId ?? randomUUID();

    // 首条诊断日志：放在单飞判定之前，被跳过的执行同样留下关联 ID
    log(`[SchedulerService] Task ${taskId} execution triggered`, { requestId, triggeredBy });

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

      const output = await executor.execute({ task, triggeredBy, requestId });

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

      // 执行记录（§7）：状态与耗时随关联 ID 落到日志。失败文本只存 DB（HTTP 执行器会写入外部响应正文），
      // 不在这里重复输出，避免正文进入日志。
      log(`[SchedulerService] Task ${taskId} execution finished`, {
        requestId,
        triggeredBy,
        status: output.status,
        durationMs: output.duration,
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
