/**
 * JobTransport — Slurm 作业传输适配器层。
 *
 * 抽象 SlurmNode 与远程 HPC 集群的交互方式，解耦 SSH/REST/gRPC 等具体传输协议。
 * SlurmNode 通过此接口与集群通信，不直接依赖 SshExecutor。
 *
 * 当前仅实现 SshJobTransport（基于 SSH），未来可扩展 SlurmRestTransport 等。
 */

import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { SshExecutor } from "./slurm-types";

/** Slurm 作业传输适配器 — 封装与远程集群的所有交互 */
export interface JobTransport {
  /** 上传脚本到远程主机（创建目录 + 写入脚本内容） */
  uploadScript(host: string, workDir: string, script: string, remotePath: string): Promise<void>;

  /** 提交 sbatch 作业，返回 Slurm jobId */
  submitJob(host: string, scriptPath: string): Promise<string>;

  /** 查询作业状态（sacct），返回原始 sacct 输出 */
  queryJobStatus(host: string, jobId: string): Promise<string>;

  /** 读取远程文件内容 */
  readFile(host: string, filePath: string): Promise<string>;

  /** 执行远程命令（用于 preCleanup 等不需要 Slurm 上下文的通用操作） */
  execCommand(host: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** 基于 SSH 的 JobTransport 实现 — 通过 SshExecutor 与远程集群交互 */
export class SshJobTransport implements JobTransport {
  constructor(private ssh: SshExecutor) {}

  async uploadScript(host: string, workDir: string, script: string, remotePath: string): Promise<void> {
    // 创建 .slurm 目录，失败时提前报错而非让后续 sbatch 报"Unable to open file"
    const mkdirResult = await this.ssh.exec(host, `mkdir -p ${workDir}/.slurm`);
    if (mkdirResult.exitCode !== 0) {
      throw new WorkflowError(
        `Failed to create directory ${workDir}/.slurm on ${host}: ${mkdirResult.stderr.trim()}`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }
    // 使用 heredoc 避免特殊字符转义问题
    const catResult = await this.ssh.exec(host, `cat > ${remotePath} << 'SLURM_EOF'\n${script}\nSLURM_EOF`);
    if (catResult.exitCode !== 0) {
      throw new WorkflowError(
        `Failed to write script to ${remotePath} on ${host}: ${catResult.stderr.trim()}`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }
  }

  async submitJob(host: string, scriptPath: string): Promise<string> {
    const { stdout, stderr } = await this.ssh.exec(host, `sbatch ${scriptPath}`);
    const match = stdout.match(/Submitted batch job (\d+)/);
    if (!match) {
      throw new WorkflowError(
        `Failed to parse job ID from sbatch output: stdout="${stdout.trim()}", stderr="${stderr.trim()}"`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }
    return match[1];
  }

  async queryJobStatus(host: string, jobId: string): Promise<string> {
    const cmd = `sacct -j ${jobId} --format=JobID,State,ExitCode --noheader --parsable2`;
    const { stdout } = await this.ssh.exec(host, cmd);
    return stdout;
  }

  async readFile(host: string, filePath: string): Promise<string> {
    const { stdout } = await this.ssh.exec(host, `cat ${filePath}`);
    return stdout;
  }

  async execCommand(host: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.ssh.exec(host, command);
  }
}
