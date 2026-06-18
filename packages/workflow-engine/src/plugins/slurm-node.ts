/**
 * SlurmNode — 基于 CustomNode 的 Slurm HPC 作业执行器。
 *
 * 封装 SSH + sbatch + sacct 完整生命周期。
 * 子类只需覆写 buildScript(ctx) 返回具体 bash 命令。
 */

import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";
import type { JobResult, SlurmConfig, SshExecutor } from "./slurm-types";
import type { CustomNode, ExecuteContext, InputDef } from "./types";

/** SlurmNode abstract class — 子类必须实现 name, description, inputs, produces, slurmConfig, buildScript */
export abstract class SlurmNode implements CustomNode {
  abstract name: string;
  abstract description: string;
  abstract inputs: Record<string, InputDef>;
  abstract produces: string[];

  abstract slurmConfig: SlurmConfig;

  pollInterval: number = 15000;
  maxRetries: number = 0;
  retryDelay: number = 30000;
  retryBackoff: "fixed" | "exponential" = "fixed";

  protected sshExecutor: SshExecutor;

  constructor(sshExecutor?: SshExecutor) {
    this.sshExecutor = sshExecutor ?? new BunSshExecutor();
  }

  abstract buildScript(ctx: ExecuteContext): string;

  preCleanup?(ctx: ExecuteContext): string;

  async execute(ctx: ExecuteContext): Promise<NodeOutput> {
    const host = String(ctx.params.cluster_host ?? "localhost");

    // 1. preCleanup（可选，失败不阻塞主流程）
    const cleanupCmd = this.preCleanup?.(ctx);
    if (cleanupCmd) {
      try {
        await this.sshExecutor.exec(host, cleanupCmd);
      } catch (err) {
        console.warn(`[SlurmNode] preCleanup failed for ${this.name}:`, err);
      }
    }

    // 2. 生成 .slurm 脚本
    const userScript = this.buildScript(ctx);
    const header = this.generateHeader(ctx);
    const slurmScript = `${header}\nset -euo pipefail\n${userScript}`;

    // 3. SSH 上传 .slurm
    const remotePath = `${ctx.workDir}/.slurm/${ctx.runId}_${ctx.nodeId}.slurm`;
    await this.sshUpload(host, ctx.workDir, slurmScript, remotePath);

    // 4. sbatch 提交
    let jobId = await this.sbatch(host, remotePath);

    // 5. sacct 轮询（带重试）
    let attempt = 0;
    let result: JobResult;
    while (true) {
      result = await this.pollJob(host, ctx.workDir, jobId);

      if (result.state === "COMPLETED") break;

      if (result.state === "CANCELLED") {
        throw new WorkflowError(`Slurm job ${jobId} was cancelled`, WorkflowErrorCode.NODE_FAILED, {
          node_id: ctx.nodeId,
          slurm_job_id: jobId,
        });
      }

      // OUT_OF_MEMORY 不重试
      if (result.state === "OUT_OF_MEMORY") {
        throw new WorkflowError(`Slurm job ${jobId} ran out of memory`, WorkflowErrorCode.NODE_FAILED, {
          node_id: ctx.nodeId,
          slurm_job_id: jobId,
        });
      }

      // 其他终端失败：按重试策略
      if (result.state === "FAILED" || result.state === "TIMEOUT" || result.state === "NODE_FAIL") {
        if (attempt < this.maxRetries) {
          attempt++;
          const delay = this.computeRetryDelay(attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          jobId = await this.sbatch(host, remotePath);
          continue;
        }
        throw new WorkflowError(
          `Slurm job ${jobId} failed with state ${result.state} (exit ${result.exitCode}) after ${attempt} retries`,
          WorkflowErrorCode.NODE_FAILED,
          { node_id: ctx.nodeId, slurm_job_id: jobId, exit_code: result.exitCode },
        );
      }

      // PENDING / RUNNING → 继续轮询
      await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
    }

    // 6. 收集输出
    return this.collectOutput(result);
  }

  async onCleanup(_ctx: ExecuteContext, _result: NodeOutput | null, _error: Error | null): Promise<void> {
    // 默认无操作，子类可覆写
  }

  // ── Protected（测试可访问） ──

  protected generateHeader(ctx: ExecuteContext): string {
    const config = this.slurmConfig;
    const jobName = config.jobName ?? this.name;
    const outDir = `${ctx.workDir}/.slurm`;

    const lines: string[] = [
      "#!/bin/bash",
      `#SBATCH --job-name=${jobName}`,
      `#SBATCH --partition=${config.partition}`,
      "#SBATCH --ntasks=1",
      `#SBATCH --cpus-per-task=${config.cores}`,
    ];

    if (config.nodes && config.nodes > 1) {
      lines.push(`#SBATCH --nodes=${config.nodes}`);
    }
    if (config.memory) {
      lines.push(`#SBATCH --mem=${config.memory}`);
    }
    if (config.walltime) {
      lines.push(`#SBATCH --time=${config.walltime}`);
    }

    lines.push(`#SBATCH --output=${outDir}/${jobName}_%j.out`);
    lines.push(`#SBATCH --error=${outDir}/${jobName}_%j.err`);

    if (config.extraSBATCH && config.extraSBATCH.length > 0) {
      for (const extra of config.extraSBATCH) {
        lines.push(`#SBATCH ${extra}`);
      }
    }

    // modules 作为 module load 命令放在 shebang 之后
    const moduleCmds =
      config.modules && config.modules.length > 0
        ? `${config.modules.map((m) => `module load ${m}`).join("\n")}\n`
        : "";

    return `${lines.join("\n")}\n${moduleCmds}`;
  }

  protected computeRetryDelay(attempt: number): number {
    if (this.retryBackoff === "exponential") {
      return this.retryDelay * 2 ** (attempt - 1);
    }
    return this.retryDelay;
  }

  // ── Private ──

  private async sshUpload(host: string, workDir: string, script: string, remotePath: string): Promise<void> {
    await this.sshExecutor.exec(host, `mkdir -p ${workDir}/.slurm`);
    // 使用 heredoc 避免特殊字符转义问题
    await this.sshExecutor.exec(host, `cat > ${remotePath} << 'SLURM_EOF'\n${script}\nSLURM_EOF`);
  }

  private async sbatch(host: string, remotePath: string): Promise<string> {
    const { stdout } = await this.sshExecutor.exec(host, `sbatch ${remotePath}`);
    const match = stdout.match(/Submitted batch job (\d+)/);
    if (!match) {
      throw new WorkflowError(`Failed to parse job ID from sbatch output: ${stdout}`, WorkflowErrorCode.NODE_FAILED);
    }
    return match[1];
  }

  private async pollJob(host: string, workDir: string, jobId: string): Promise<JobResult> {
    const jobName = this.slurmConfig.jobName ?? this.name;

    // 1. sacct 查询状态
    const sacctCmd = `sacct -j ${jobId} --format=JobID,State,ExitCode --noheader --parsable2`;
    const { stdout: sacctOut } = await this.sshExecutor.exec(host, sacctCmd);

    const lines = sacctOut
      .trim()
      .split("\n")
      .filter((l) => l);
    const mainJob = lines[0];
    if (!mainJob) {
      return {
        jobId,
        state: "FAILED" as const,
        exitCode: null,
        stdout: "",
        stderr: `sacct returned no data for job ${jobId}`,
      };
    }

    const parts = mainJob.split("|");
    const slurmState = parts[1] ?? "";
    const exitCodeStr = parts[2] ?? "";
    const exitCode = exitCodeStr !== "" ? Number.parseInt(exitCodeStr) : null;

    // 2. 映射状态
    const mappedState = mapSlurmState(slurmState, exitCode);

    // 3. 如果是终态，收集输出文件
    let stdout = "";
    let stderr = "";
    if (mappedState !== null) {
      const outPath = `${workDir}/.slurm/${jobName}_${jobId}`;
      try {
        const outResult = await this.sshExecutor.exec(host, `cat ${outPath}.out`);
        stdout = outResult.stdout;
      } catch {
        stdout = "(failed to read stdout)";
      }
      try {
        const errResult = await this.sshExecutor.exec(host, `cat ${outPath}.err`);
        stderr = errResult.stdout;
      } catch {
        stderr = "(failed to read stderr)";
      }
    }

    return { jobId, state: mappedState ?? "FAILED", exitCode, stdout, stderr };
  }

  /** 将 JobResult 转换为引擎 NodeOutput */
  private collectOutput(result: JobResult): NodeOutput {
    // NodeOutput 无 stderr 字段，非空时拼接到 stdout 末尾
    const combinedStdout =
      result.stderr && result.stderr.trim() ? `${result.stdout}\n[stderr]\n${result.stderr}` : result.stdout;

    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      // not JSON — use raw stdout
    }

    return {
      stdout: combinedStdout,
      json,
      exit_code: result.exitCode ?? 0,
      size: Buffer.byteLength(combinedStdout),
    };
  }
}

// ── 辅助函数 ──

/**
 * 将 sacct State 映射到 JobResult.state。
 * 返回 null 表示非终态（PENDING/RUNNING），调用方应继续轮询。
 */
export function mapSlurmState(slurmState: string, exitCode: number | null): JobResult["state"] | null {
  const upper = slurmState.toUpperCase();

  // 非终态 — 继续轮询
  if (upper === "PENDING" || upper === "CONFIGURING" || upper === "REQUEUED") {
    return null;
  }
  if (upper === "RUNNING" || upper === "COMPLETING" || upper === "SUSPENDED") {
    return null;
  }

  // COMPLETED — 按 exitCode 区分成功/失败
  if (upper === "COMPLETED") {
    return exitCode === 0 ? "COMPLETED" : "FAILED";
  }

  // 明确映射
  if (upper === "TIMEOUT" || upper === "DEADLINE") return "TIMEOUT";
  if (upper === "NODE_FAIL") return "NODE_FAIL";
  if (upper === "OUT_OF_MEMORY" || upper === "OUT_OF_ME+") return "OUT_OF_MEMORY";
  if (upper === "CANCELLED" || upper === "CANCELLED+") return "CANCELLED";

  // 其他失败状态
  if (upper === "FAILED" || upper === "BOOT_FAIL" || upper === "PREEMPTED" || upper === "REVOKED") {
    return "FAILED";
  }

  // 兜底：未知终态 → FAILED
  return "FAILED";
}

// ── BunSshExecutor ──

/** 基于 Bun.spawn 的 SSH 执行器生产实现 */
export class BunSshExecutor implements SshExecutor {
  async exec(
    host: string,
    command: string,
    _opts?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["/usr/bin/ssh", "-o", "BatchMode=yes", host, command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode };
  }
}
