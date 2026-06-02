/**
 * Shell 节点执行器 — 通过 Bun.spawn 执行命令。
 *
 * 职责：
 * - 从 resolvedInputs 读取已解析的命令和 inputs 环境变量
 * - 进程管理：spawn 子进程、收集 stdout/stderr、等待退出
 * - 超时控制：AbortSignal.timeout + ctx.signal 组合
 * - 重试：指数退避 + jitter，发射 node.retrying 事件
 * - 事件发射：node.started / node.completed / node.failed / node.retrying
 */

import { nanoid } from "nanoid";
import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import type { ShellNodeDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";

// ---------- 常量 ----------

const MAX_STDERR_SIZE = 10 * 1024 * 1024; // 10MB
const TRUNCATE_SIZE = 2000;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 分钟
const DEFAULT_RETRY_DELAY_MS = 1000;

// ---------- ProcessExecutor ----------

/** Shell 节点执行器 */
export class ProcessExecutor implements NodeExecutor {
  async execute(node: import("../types/dag").NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== "shell") {
      throw new WorkflowError(
        `ProcessExecutor only handles 'shell' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const shellNode = node as ShellNodeDef;

    // 从 resolvedInputs 获取命令（scheduler 已处理）
    const command = (ctx.resolvedInputs.command as string | string[]) ?? shellNode.command;
    const resolvedCommand = typeof command === "string" ? ["/bin/sh", "-c", command] : command;

    // 合并环境变量：进程环境 + env（静态）+ inputs（动态）+ secrets
    const env: Record<string, string | undefined> = { ...(process.env as Record<string, string>) };

    const nodeEnv = (ctx.resolvedInputs.env as Record<string, string>) ?? shellNode.env;
    if (nodeEnv) {
      for (const [k, v] of Object.entries(nodeEnv)) {
        env[k] = v;
      }
    }

    // inputs 注入为环境变量
    const resolvedInputs = ctx.resolvedInputs.inputs as
      | Record<string, { value: unknown; rawExpression: string }>
      | undefined;
    if (resolvedInputs) {
      for (const [key, { value }] of Object.entries(resolvedInputs)) {
        if (value === null || value === undefined) {
          env[key] = "";
        } else if (typeof value === "object") {
          env[key] = JSON.stringify(value);
        } else {
          env[key] = String(value);
        }
      }
    }

    for (const [k, v] of Object.entries(ctx.secrets)) {
      env[k] = v;
    }

    const cwd = (ctx.resolvedInputs.cwd as string) ?? shellNode.cwd ?? process.cwd();

    // 构建 AbortSignal：超时 + 外部取消
    const timeoutMs = (shellNode.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
    const timeoutController = new AbortController();

    if (ctx.signal.aborted) {
      timeoutController.abort();
    }

    const timer = setTimeout(() => {
      timeoutController.abort();
    }, timeoutMs);

    const onExternalAbort = () => {
      clearTimeout(timer);
      timeoutController.abort();
    };
    ctx.signal.addEventListener("abort", onExternalAbort, { once: true });

    try {
      return await this.executeWithRetry(shellNode, resolvedCommand, env, cwd, ctx, timeoutController.signal);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onExternalAbort);
    }
  }

  /** 带重试的执行 */
  private async executeWithRetry(
    node: ShellNodeDef,
    command: string[],
    env: Record<string, string | undefined>,
    cwd: string,
    ctx: NodeExecutionContext,
    signal: AbortSignal,
  ): Promise<NodeOutput> {
    const retryConfig = node.retry;
    const maxAttempts = (retryConfig?.count ?? 0) + 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 重试时发射 node.retrying 事件（第一次不算重试）
      if (attempt > 0) {
        const baseDelay = retryConfig?.delay ?? DEFAULT_RETRY_DELAY_MS;
        const multiplier = retryConfig?.backoff === "exponential" ? 2 ** (attempt - 1) : 1;
        const jitter = 0.5 + Math.random() * 0.5;
        const delay = Math.round(baseDelay * multiplier * jitter);

        await this.emitEvent(ctx, "node.retrying", node, {
          attempt: attempt + 1,
          max_attempts: maxAttempts,
          next_delay_ms: delay,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        return await this.spawnProcess(node, command, env, cwd, ctx, signal);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // 超时和取消不重试
        if (
          error instanceof WorkflowError &&
          (error.code === WorkflowErrorCode.NODE_TIMEOUT || error.code === WorkflowErrorCode.DAG_CANCELLED)
        ) {
          throw error;
        }
        // 最后一次失败直接抛出
        if (attempt === maxAttempts - 1) throw lastError;
      }
    }

    throw lastError ?? new WorkflowError("All retry attempts exhausted", WorkflowErrorCode.NODE_FAILED);
  }

  /** spawn 子进程并收集输出 */
  private async spawnProcess(
    node: ShellNodeDef,
    command: string[],
    env: Record<string, string | undefined>,
    cwd: string,
    ctx: NodeExecutionContext,
    signal: AbortSignal,
  ): Promise<NodeOutput> {
    // 发射 node.started 事件
    const subprocess = Bun.spawn(command, {
      cwd,
      env: { ...(process.env as Record<string, string>), ...env },
      stdout: "pipe",
      stderr: "pipe",
    });

    // 信号中止时杀掉子进程
    const onAbort = () => subprocess.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });

    await this.emitEvent(ctx, "node.started", node, {
      inputs: ctx.resolvedInputs,
      pid: subprocess.pid,
    });

    // 收集 stdout
    const stdoutChunks: Uint8Array[] = [];
    const stdoutReader = subprocess.stdout.getReader();

    // 收集 stderr（异步，有大小限制）
    const stderrChunks: Uint8Array[] = [];
    let stderrSize = 0;
    let stderrExceeded = false;
    const stderrReader = subprocess.stderr.getReader();

    const stderrPromise = (async () => {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrChunks.push(value);
        stderrSize += value.byteLength;
        if (stderrSize > MAX_STDERR_SIZE) {
          stderrExceeded = true;
          subprocess.kill("SIGKILL");
          break;
        }
      }
    })();

    // 读取 stdout
    while (true) {
      const { done, value } = await stdoutReader.read();
      if (done) break;
      stdoutChunks.push(value);
    }

    // 等待 stderr 收集完成
    await stderrPromise;

    signal.removeEventListener("abort", onAbort);

    // 等待进程退出
    const exitCode = await subprocess.exited;

    // stderr 超限
    if (stderrExceeded) {
      await this.emitEvent(ctx, "node.failed", node, {
        error: `stderr exceeded ${MAX_STDERR_SIZE} bytes`,
        exit_code: exitCode,
      });
      throw new WorkflowError(`stderr exceeded ${MAX_STDERR_SIZE} bytes`, WorkflowErrorCode.NODE_FAILED, {
        node_id: node.id,
        exit_code: exitCode,
      });
    }

    // 检查超时/取消
    if (signal.aborted) {
      await this.emitEvent(ctx, "node.failed", node, {
        error: ctx.signal.aborted ? "cancelled" : "timeout",
        exit_code: exitCode,
      });
      throw new WorkflowError(
        ctx.signal.aborted ? "Node cancelled" : "Node timed out",
        ctx.signal.aborted ? WorkflowErrorCode.DAG_CANCELLED : WorkflowErrorCode.NODE_TIMEOUT,
        { node_id: node.id, exit_code: exitCode },
      );
    }

    const stdoutStr = Buffer.concat(stdoutChunks).toString();
    const stderrStr = Buffer.concat(stderrChunks).toString();
    const outputSize = Buffer.byteLength(stdoutStr);

    // 非零退出码 → 失败
    if (exitCode !== 0) {
      const stderrTruncated = stderrStr.slice(0, TRUNCATE_SIZE);
      const detail = stderrTruncated
        ? `Process exited with code ${exitCode}: ${stderrTruncated}`
        : `Process exited with code ${exitCode}`;
      await this.emitEvent(ctx, "node.failed", node, {
        error: detail,
        exit_code: exitCode,
        stdout: stdoutStr.slice(0, TRUNCATE_SIZE),
        stderr: stderrTruncated,
      });
      throw new WorkflowError(detail, WorkflowErrorCode.NODE_FAILED, {
        node_id: node.id,
        exit_code: exitCode,
        stdout: stdoutStr.slice(0, TRUNCATE_SIZE),
        stderr: stderrTruncated,
      });
    }

    // 成功
    let json: unknown;
    try {
      json = JSON.parse(stdoutStr);
    } catch {
      // stdout 不是合法 JSON，json 留 undefined
    }

    await this.emitEvent(ctx, "node.completed", node, {
      exit_code: exitCode,
      output_size: outputSize,
    });

    return {
      stdout: stdoutStr,
      json,
      exit_code: exitCode,
      size: outputSize,
    };
  }

  /** 发射事件到 storage */
  private async emitEvent(
    ctx: NodeExecutionContext,
    type: import("../types/execution").EventType,
    node: ShellNodeDef,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const event: import("../types/execution").DAGEvent = {
      event_id: `evt_${nanoid(10)}`,
      run_id: ctx.runId,
      node_id: node.id,
      node_type: node.type,
      timestamp: new Date().toISOString(),
      type,
      ...(metadata ? { metadata } : {}),
    };
    await ctx.storage.appendEvent(event);
  }
}
