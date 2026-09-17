/** Scheduler 启动装配依赖，隔离验收开关与具体调度器实现。 */
export interface SchedulerStartupOptions {
  disabled: boolean;
  start: () => Promise<void>;
  onDisabled: () => void;
}

/**
 * 默认启动 Scheduler；仅在显式禁用时跳过，避免只读启动验收更新持久化任务状态。
 */
export async function startSchedulerUnlessDisabled(options: SchedulerStartupOptions): Promise<void> {
  if (options.disabled) {
    options.onDisabled();
    return;
  }
  await options.start();
}
