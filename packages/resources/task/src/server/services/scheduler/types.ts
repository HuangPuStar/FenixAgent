import type { ScheduledTaskV2Row } from "../../repositories/task-v2";

export interface TaskExecInput {
  task: ScheduledTaskV2Row;
  triggeredBy: "cron" | "manual";
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
