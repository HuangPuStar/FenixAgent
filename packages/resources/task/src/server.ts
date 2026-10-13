/**
 * Task 资源包服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server` 是合法消费者；路由一律以工厂形式导出，守卫由宿主注入
 * （理由见 `./server/routes/dependencies`）。本入口不导出浏览器代码——浏览器面走 `./web`。
 *
 * 数据访问只经本包仓储（`scheduledTaskV2Repo` / `taskExecutionLogRepo`）：宿主 `main.ts` 需要调度器单例
 * 完成 `start()` / `stop()`，测试需要仓储完成隔离断言，都属于稳定契约；迁移期宿主测试若直连表定义，
 * 应改为经这里的仓储。
 */

export type { TaskModule } from "./module";
export { createTaskModule } from "./module";
export { taskExecutionLogRepo } from "./server/repositories/task";
export { scheduledTaskV2Repo } from "./server/repositories/task-v2";
export type { WebTaskRouteDependencies } from "./server/routes/dependencies";
export { createWebTasksV2Routes } from "./server/routes/web/tasks-v2";
export { SchedulerService, schedulerService } from "./server/services/scheduler";
export { toInvocationDate } from "./server/services/scheduler/utils";
export * from "./server/services/task-v2";
