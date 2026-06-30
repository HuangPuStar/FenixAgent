/**
 * SlurmNode — 基于 CustomNode 的 Slurm HPC 作业执行器。
 *
 * 封装 SSH + sbatch + sacct 完整生命周期。
 * 默认 buildScript 从 ctx.script.content 读取已求值的 bash 脚本内容；
 * 子类也可覆写 buildScript(ctx) 返回具体 bash 命令（向后兼容）。
 *
 * 环境变量注入契约（generateHeader 实现）：
 * - 节点级 `inputs:` 字段声明的 K=${{ params.xxx }} 会被 dag-scheduler 求值后
 *   存入 ctx.inputs，本类把它当作 bash 环境变量注入 `#SBATCH --export=ALL,...`。
 *   脚本里可直接用 $K 引用，避免重复声明 script.env。
 * - script.env 字段（显式声明的运行时变量）会与 inputs 合并，同 key 时 env 优先。
 *   适合需要在脚本内重写某 key 的场景（例如 WORK_DIR 派生子目录）。
 */

import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";
import type { JobTransport } from "./job-transport";
import { SshJobTransport } from "./job-transport";
import type { JobResult, SlurmConfig, SshExecutor } from "./slurm-types";
import type { CustomNode, ExecuteContext, InputDef } from "./types";

/**
 * SlurmNode 抽象基类 — 子类至少需声明 name, description, inputs, produces。
 *
 * 默认行为（无需覆写）：
 * - buildScript: 从 ctx.script.content 读取已求值的 bash 脚本内容
 * - slurmConfig: 保守默认值（partition=xahcnormal, cores=1），可被 YAML slurm 字段覆盖
 * - resolveSlurmConfig(ctx): 合并工具默认值 + ctx.slurm（YAML 节点声明优先）
 */
export abstract class SlurmNode implements CustomNode {
  abstract name: string;
  abstract description: string;
  abstract inputs: Record<string, InputDef>;
  abstract produces: string[];

  // 用于 yaml-parser 判断是否是 SlurmNode 子类(决定 script 字段是否必填)
  kind = "slurm" as const;

  /**
   * 工具默认 Slurm 资源。可被 YAML 节点的 `slurm:` 字段覆盖（字段级合并，YAML 优先）。
   * 子类可覆写提供工具特定的默认值。
   */
  slurmConfig: SlurmConfig = {
    partition: "xahcnormal",
    cores: 1,
  };

  pollInterval: number = 15000;
  maxRetries: number = 0;
  retryDelay: number = 30000;
  retryBackoff: "fixed" | "exponential" = "fixed";

  protected transport: JobTransport;

  constructor(transport?: JobTransport) {
    this.transport = transport ?? new SshJobTransport(new BunSshExecutor());
  }

  /**
   * 生成 sbatch 脚本正文。默认实现:从 ctx.script.content 读取(已求值的 bash 字符串)。
   * 子类可覆写以实现命令组装逻辑(向后兼容场景:子类内部自己拼命令,不依赖 ctx.script)。
   *
   * 默认实现要求 ctx.script.content 存在且非空,否则抛 NODE_FAILED。
   */
  buildScript(ctx: ExecuteContext): string {
    const content = ctx.script?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new WorkflowError(
        `Slurm tool '${this.name}' requires 'script.content' (bash script content). ` +
          `Either declare script.content in YAML or override buildScript() in the tool class.`,
        WorkflowErrorCode.NODE_FAILED,
        { node_id: ctx.nodeId, tool: this.name },
      );
    }
    return content;
  }

  /**
   * 合并工具默认 slurmConfig 与 YAML 节点声明的 ctx.slurm。
   * YAML 声明优先（字段级浅合并），未声明的字段回退到工具默认值。
   */
  protected resolveSlurmConfig(ctx: ExecuteContext): SlurmConfig {
    return { ...this.slurmConfig, ...(ctx.slurm ?? {}) };
  }

  preCleanup?(ctx: ExecuteContext): string;

  async execute(ctx: ExecuteContext): Promise<NodeOutput> {
    const host = String(ctx.params.cluster_host ?? "localhost");

    // 1. preCleanup（可选，失败不阻塞主流程）
    const cleanupCmd = this.preCleanup?.(ctx);
    if (cleanupCmd) {
      try {
        await this.transport.execCommand(host, cleanupCmd);
      } catch (err) {
        console.warn(`[SlurmNode] preCleanup failed for ${this.name}:`, err);
      }
    }

    // 2. 生成 .slurm 脚本（header 使用合并后的资源配置）
    const userScript = this.buildScript(ctx);
    const header = this.generateHeader(ctx);
    const slurmScript = `${header}\nset -euo pipefail\n${userScript}`;

    // 3. 上传 .slurm 到远程
    const remotePath = `${ctx.workDir}/.slurm/${ctx.runId}_${ctx.nodeId}.slurm`;
    await this.transport.uploadScript(host, ctx.workDir, slurmScript, remotePath);

    // 4. sbatch 提交
    let jobId = await this.transport.submitJob(host, remotePath);

    // 5. sacct 轮询（带重试）
    let attempt = 0;
    // sacct 连续返回空数据的次数：slurmdbd 提交后 1-3 秒延迟，前几次拿不到数据正常；
    // 但若作业真的不存在（如 sbatch 解析失败但 stdout 形似合法），需在阈值后放弃避免无限轮询。
    // 默认 20 次 × pollInterval(15s) = 5 分钟，足够覆盖 slurmdbd 最坏延迟。
    let noDataCount = 0;
    const maxNoData = 20;
    let result: JobResult;
    while (true) {
      result = await this.pollJob(ctx, host, jobId);

      // 成功：跳出循环进入输出收集
      if (result.state === "COMPLETED") break;

      // sacct 暂无数据（slurmdbd 延迟）：累加计数，达上限才判 FAILED
      if (result.sacctEmpty) {
        noDataCount++;
        if (noDataCount >= maxNoData) {
          throw new WorkflowError(
            `Slurm job ${jobId} not found in sacct after ${maxNoData} polls (~${Math.round((maxNoData * this.pollInterval) / 1000)}s). ` +
              `Possible causes: sbatch output mis-parsed, job purged from slurmdbd, or sacct permission issue.`,
            WorkflowErrorCode.NODE_FAILED,
            { node_id: ctx.nodeId, slurm_job_id: jobId },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
        continue;
      }
      // 拿到真实状态后重置 noDataCount（防御性，理论上不需要）
      noDataCount = 0;

      // 取消：不重试，直接抛错（带 stderr 用于诊断）
      if (result.state === "CANCELLED") {
        throw new WorkflowError(`Slurm job ${jobId} was cancelled`, WorkflowErrorCode.NODE_FAILED, {
          node_id: ctx.nodeId,
          slurm_job_id: jobId,
          stderr: result.stderr,
          stdout: result.stdout,
        });
      }

      // OUT_OF_MEMORY 不重试（重试也是 OOM）
      if (result.state === "OUT_OF_MEMORY") {
        throw new WorkflowError(`Slurm job ${jobId} ran out of memory`, WorkflowErrorCode.NODE_FAILED, {
          node_id: ctx.nodeId,
          slurm_job_id: jobId,
          stderr: result.stderr,
          stdout: result.stdout,
        });
      }

      // 其他终端失败：按重试策略
      if (result.state === "FAILED" || result.state === "TIMEOUT" || result.state === "NODE_FAIL") {
        if (attempt < this.maxRetries) {
          attempt++;
          const delay = this.computeRetryDelay(attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          jobId = await this.transport.submitJob(host, remotePath);
          continue;
        }
        // 关键：把 sacct 收集到的 stderr/stdout 带进 context，否则前端只能看到
        // "failed with state FAILED (exit null)" 而不知道脚本里哪条命令挂了。
        throw new WorkflowError(
          `Slurm job ${jobId} failed with state ${result.state} (exit ${result.exitCode}) after ${attempt} retries`,
          WorkflowErrorCode.NODE_FAILED,
          {
            node_id: ctx.nodeId,
            slurm_job_id: jobId,
            exit_code: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
          },
        );
      }

      // PENDING / RUNNING / CONFIGURING 等非终态：等待下一轮轮询。
      // 此前这里走不到（pollJob 把非终态映射成 FAILED），修复后才会正常进入此分支。
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
    const config = this.resolveSlurmConfig(ctx);
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

    // 注入环境变量到 #SBATCH --export — 来源 1: 节点级 inputs 字段（求值后）。
    // SlurmToolNode.inputs = {}（tools/slurm.ts），不约束 key；YAML 用户在节点
    // `inputs:` 块声明的 K=表达式 由 dag-scheduler 求值后存入 ctx.inputs，
    // 这里全部转为环境变量，让 bash 脚本能用 $K 直接引用，省去 script.env 重复声明。
    // 类型约束：bash env 只接受字符串；对象/数组等复杂类型跳过（用户应改走 params/secrets）。
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.inputs ?? {})) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        mergedEnv[k] = String(v);
      }
    }
    // 来源 2: script.env（显式声明的"脚本内变量"）。同 key 时 env 优先，
    // 因为它是用户特意在 script 块声明的运行时变量，应覆盖 inputs 的同名字段。
    const scriptEnv = ctx.script?.env ?? {};
    for (const [k, v] of Object.entries(scriptEnv)) {
      mergedEnv[k] = v;
    }
    // 关键：必须以 ALL 开头，否则 Slurm 不会继承默认环境（PATH/HOME/SLURM_* 等），
    // 会导致脚本里 module load / apptainer 等命令找不到。
    // 值中换行符替换为空格，含逗号/空格的值用双引号包裹，避免 sbatch 解析错位。
    if (Object.keys(mergedEnv).length > 0) {
      const entries = Object.entries(mergedEnv)
        .map(([k, v]) => {
          // 换行符会直接破坏 #SBATCH 行结构，替换为空格
          const sanitized = v.replace(/[\r\n]+/g, " ").trim();
          // 含逗号或空格的值必须用双引号包裹（Slurm --export 规范）
          const needsQuote = sanitized.includes(",") || sanitized.includes(" ");
          return needsQuote ? `${k}="${sanitized}"` : `${k}=${sanitized}`;
        })
        .join(",");
      lines.push(`#SBATCH --export=ALL,${entries}`);
    }

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

  private async pollJob(ctx: ExecuteContext, host: string, jobId: string): Promise<JobResult> {
    // jobName 取合并后的 slurmConfig（YAML 声明优先），与 generateHeader 保持一致，
    // 否则 YAML 覆盖了 jobName 但 pollJob 仍用默认值，会导致找不到 .out/.err 日志文件
    const jobName = this.resolveSlurmConfig(ctx).jobName ?? this.name;

    // 1. sacct 查询状态
    const sacctOut = await this.transport.queryJobStatus(host, jobId);

    const lines = sacctOut
      .trim()
      .split("\n")
      .filter((l) => l);
    const mainJob = lines[0];
    if (!mainJob) {
      // sbatch 提交后 slurmdbd 有 1-3 秒延迟才记录作业，首次（甚至前几次）sacct 拿不到数据是正常的。
      // 此前这里直接判 FAILED，导致用户看到 "sacct returned no data for job xxx" 而 sacct 实际能查到 COMPLETED。
      // 改为返回 PENDING + sacctEmpty 标记，让 execute() 区分"无数据"和"真实 PENDING"，
      // 维护 noDataCount 防止作业真的不存在时无限轮询。
      return {
        jobId,
        state: "PENDING" as const,
        exitCode: null,
        stdout: "",
        stderr: "",
        sacctEmpty: true,
      };
    }

    const parts = mainJob.split("|");
    const slurmState = parts[1] ?? "";
    const exitCodeStr = parts[2] ?? "";
    const exitCode = exitCodeStr !== "" ? Number.parseInt(exitCodeStr, 10) : null;

    // 2. 映射状态
    const mappedState = mapSlurmState(slurmState, exitCode);

    // 3. 如果是终态，收集输出文件
    let stdout = "";
    let stderr = "";
    if (mappedState !== null) {
      const outPath = `${ctx.workDir}/.slurm/${jobName}_${jobId}`;
      try {
        stdout = await this.transport.readFile(host, `${outPath}.out`);
      } catch {
        stdout = "(failed to read stdout)";
      }
      try {
        stderr = await this.transport.readFile(host, `${outPath}.err`);
      } catch {
        stderr = "(failed to read stderr)";
      }
    }

    // mappedState === null 表示 mapSlurmState 判定为非终态（PENDING/RUNNING/CONFIGURING 等）。
    // 关键：不能用 "FAILED" 作为默认值——否则任何还在运行/排队的作业都会被立即当作失败抛错，
    // 表现为前端看到 "Slurm job xxx failed with state FAILED (exit null)" 而 sacct 实际是 RUNNING。
    // 用 "PENDING" 让调用方继续轮询；exit/stderr 在非终态时保持空，避免 cat 不存在的 .out/.err。
    return { jobId, state: mappedState ?? "PENDING", exitCode, stdout, stderr };
  }

  /** 将 JobResult 转换为引擎 NodeOutput */
  private collectOutput(result: JobResult): NodeOutput {
    // NodeOutput 无 stderr 字段，非空时拼接到 stdout 末尾
    const combinedStdout = result.stderr?.trim() ? `${result.stdout}\n[stderr]\n${result.stderr}` : result.stdout;

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
