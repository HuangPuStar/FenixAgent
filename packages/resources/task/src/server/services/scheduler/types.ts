import type { ScheduledTaskV2Row } from "../../repositories/task-v2";

export interface TaskExecInput {
  task: ScheduledTaskV2Row;
  triggeredBy: "cron" | "manual";
  /**
   * 本次执行的关联 ID（§7：异步任务在显式输入与诊断日志中保留触发方的 `requestId`）。
   *
   * 由调度入口 `SchedulerService.execute` 解析后透传：HTTP/manual 触发取触发请求的 `requestId`，
   * cron 等无上游请求的入口自建。可选是为了不破坏既有调用方与既有用例，缺省时入口自行兜底生成。
   */
  requestId?: string;
}

export interface TaskExecOutput {
  status: "success" | "failed" | "timeout";
  error?: string;
  duration: number;
  resultSummary?: string;
}

export interface TaskExecutor {
  readonly type: string;
  execute(input: TaskExecInput): Promise<TaskExecOutput>;
}
