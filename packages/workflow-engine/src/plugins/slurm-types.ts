/**
 * SlurmNode 核心类型定义 — SlurmConfig, SshExecutor, JobResult。
 */

/** Slurm 作业资源声明 */
export interface SlurmConfig {
  /** Slurm 队列/分区名 */
  partition: string;
  /** CPU 核数（--cpus-per-task） */
  cores: number;
  /** 计算节点数，默认 1 */
  nodes?: number;
  /** 内存，如 "100G"。不设则用队列默认 */
  memory?: string;
  /** 最大运行时间，如 "04:00:00"。不设则用队列默认 */
  walltime?: string;
  /** module load 列表，如 ["apps/apptainer/1.2.4"] */
  modules?: string[];
  /** 作业名覆盖，默认使用 CustomNode.name */
  jobName?: string;
  /** 额外 #SBATCH 指令（如 --gres=gpu:1），原样追加 */
  extraSBATCH?: string[];
}

/** SSH 执行器接口 — 生产用 BunSshExecutor，测试可注入 fake */
export interface SshExecutor {
  exec(
    host: string,
    command: string,
    opts?: {
      cwd?: string;
      timeout?: number;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** sacct 轮询结果 */
export interface JobResult {
  jobId: string;
  state: "COMPLETED" | "FAILED" | "TIMEOUT" | "NODE_FAIL" | "OUT_OF_MEMORY" | "CANCELLED";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
