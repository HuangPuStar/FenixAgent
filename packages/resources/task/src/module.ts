import type { ITaskExecutionLogRepo } from "./server/repositories/task";
import { taskExecutionLogRepo } from "./server/repositories/task";
import type { IScheduledTaskV2Repo } from "./server/repositories/task-v2";
import { scheduledTaskV2Repo } from "./server/repositories/task-v2";
import type { SchedulerService } from "./server/services/scheduler";
import { schedulerService } from "./server/services/scheduler";

/**
 * Task 模块的运行时表面。
 *
 * 只暴露需要「对象身份」的能力：`schedulerService` 持有进程内的 `node-schedule` job 表与 running 单飞
 * 标记——同一份 DB 记录只允许有一个调度 owner，再构造一个实例等于给同一批任务开两条调度路径（重复执行
 * 与重复写执行日志）。因此组合根返回的是包内既有单例，而不是新建一套。
 *
 * 路由工厂、任务领域服务（`listTasksV2` 等纯函数）由宿主直接按需调用，不经过模块实例即可使用，
 * 故不在这里重复包装；等 §1.5 的 `mountContribution` 需要统一拿到它们时再按需扩展。
 */
export interface TaskModule {
  readonly id: "task";
  /** 调度器单例：宿主在生命周期里 `start()` / `stop()`。 */
  readonly scheduler: SchedulerService;
  /** 定时任务仓储（数据访问的唯一入口）。 */
  readonly tasks: IScheduledTaskV2Repo;
  /** 执行日志仓储（数据访问的唯一入口）。 */
  readonly executionLogs: ITaskExecutionLogRepo;
}

/** 创建 Task 模块实例。 */
export function createTaskModule(): TaskModule {
  return {
    id: "task",
    scheduler: schedulerService,
    tasks: scheduledTaskV2Repo,
    executionLogs: taskExecutionLogRepo,
  };
}
