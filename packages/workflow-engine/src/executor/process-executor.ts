/**
 * Shell 节点执行器 — 通过 Bun.spawn 执行命令。
 *
 * 职责：
 * - 模板解析：将 command/env 中的 ${{ }} 替换为实际值
 * - 进程管理：spawn 子进程、收集 stdout/stderr、等待退出
 * - 超时控制：AbortSignal.timeout + ctx.signal 组合
 * - 重试：指数退避 + jitter，发射 node.retrying 事件
 * - 事件发射：node.started / node.completed / node.failed / node.retrying
 */

import { nanoid } from 'nanoid';
import type { ShellNodeDef } from '../types/dag';
import type { NodeExecutor, NodeExecutionContext } from '../scheduler/dag-scheduler';
import type { NodeOutput } from '../types/execution';
import { resolveTemplate } from '../parser/expression-parser';
import type { EvalContext } from '../types/expression';
import { WorkflowError, WorkflowErrorCode } from '../types/errors';

// ---------- 常量 ----------

const MAX_STDERR_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_TIMEOUT_MS = 300_000; // 5 分钟
const DEFAULT_RETRY_DELAY_MS = 1000;

// ---------- ProcessExecutor ----------

/** Shell 节点执行器 */
export class ProcessExecutor implements NodeExecutor {
  async execute(node: import('../types/dag').NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== 'shell') {
      throw new WorkflowError(
        `ProcessExecutor only handles 'shell' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const shellNode = node as ShellNodeDef;
    const evalContext = this.buildEvalContext(ctx);

    // 解析模板
    const command = this.resolveCommand(shellNode.command, evalContext);
    const env = this.resolveEnv(shellNode.env, evalContext, ctx.secrets);
    const cwd = shellNode.cwd ?? process.cwd();

    // 构建 AbortSignal：超时 + 外部取消
    const timeoutMs = (shellNode.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
    const timeoutController = new AbortController();

    // 如果外部信号已经中止，直接标记
    if (ctx.signal.aborted) {
      timeoutController.abort();
    }

    // 超时定时器
    const timer = setTimeout(() => {
      timeoutController.abort();
    }, timeoutMs);

    // 外部取消时同步清理
    const onExternalAbort = () => {
      clearTimeout(timer);
      timeoutController.abort();
    };
    ctx.signal.addEventListener('abort', onExternalAbort, { once: true });

    try {
      return await this.executeWithRetry(
        shellNode,
        command,
        env,
        cwd,
        ctx,
        timeoutController.signal,
        evalContext,
      );
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onExternalAbort);
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
    evalContext: EvalContext,
  ): Promise<NodeOutput> {
    const retryConfig = node.retry;
    const maxAttempts = (retryConfig?.count ?? 0) + 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 重试时发射 node.retrying 事件（第一次不算重试）
      if (attempt > 0) {
        const baseDelay = retryConfig?.delay ?? DEFAULT_RETRY_DELAY_MS;
        const multiplier = retryConfig?.backoff === 'exponential' ? Math.pow(2, attempt - 1) : 1;
        const jitter = 0.5 + Math.random() * 0.5;
        const delay = Math.round(baseDelay * multiplier * jitter);

        await this.emitEvent(ctx, 'node.retrying', node, {
          attempt: attempt + 1,
          max_attempts: maxAttempts,
          next_delay_ms: delay,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        return await this.spawnProcess(node, command, env, cwd, ctx, signal, evalContext);
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

    throw lastError ?? new WorkflowError('All retry attempts exhausted', WorkflowErrorCode.NODE_FAILED);
  }

  /** spawn 子进程并收集输出 */
  private async spawnProcess(
    node: ShellNodeDef,
    command: string[],
    env: Record<string, string | undefined>,
    cwd: string,
    ctx: NodeExecutionContext,
    signal: AbortSignal,
    _evalContext: EvalContext,
  ): Promise<NodeOutput> {
    // 发射 node.started 事件
    const subprocess = Bun.spawn(command, {
      cwd,
      env: { ...process.env as Record<string, string>, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // 信号中止时杀掉子进程
    const onAbort = () => subprocess.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });

    await this.emitEvent(ctx, 'node.started', node, {
      inputs: ctx.resolvedInputs,
      pid: subprocess.pid,
    });

    // 收集 stdout
    const stdoutChunks: Uint8Array[] = [];
    const stdoutReader = subprocess.stdout.getReader();

    // 收集 stderr（异步，有大小限制）
    let stderrSize = 0;
    let stderrExceeded = false;
    const stderrReader = subprocess.stderr.getReader();

    const stderrPromise = (async () => {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrSize += value.byteLength;
        if (stderrSize > MAX_STDERR_SIZE) {
          stderrExceeded = true;
          subprocess.kill('SIGKILL');
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

    signal.removeEventListener('abort', onAbort);

    // 等待进程退出
    const exitCode = await subprocess.exited;

    // stderr 超限
    if (stderrExceeded) {
      await this.emitEvent(ctx, 'node.failed', node, {
        error: `stderr exceeded ${MAX_STDERR_SIZE} bytes`,
        exit_code: exitCode,
      });
      throw new WorkflowError(
        `stderr exceeded ${MAX_STDERR_SIZE} bytes`,
        WorkflowErrorCode.NODE_FAILED,
        { node_id: node.id, exit_code: exitCode },
      );
    }

    // 检查超时/取消
    if (signal.aborted) {
      await this.emitEvent(ctx, 'node.failed', node, {
        error: ctx.signal.aborted ? 'cancelled' : 'timeout',
        exit_code: exitCode,
      });
      throw new WorkflowError(
        ctx.signal.aborted ? 'Node cancelled' : 'Node timed out',
        ctx.signal.aborted ? WorkflowErrorCode.DAG_CANCELLED : WorkflowErrorCode.NODE_TIMEOUT,
        { node_id: node.id, exit_code: exitCode },
      );
    }

    const stdoutStr = Buffer.concat(stdoutChunks).toString();
    const outputSize = Buffer.byteLength(stdoutStr);

    // 非零退出码 → 失败
    if (exitCode !== 0) {
      await this.emitEvent(ctx, 'node.failed', node, {
        error: `Process exited with code ${exitCode}`,
        exit_code: exitCode,
      });
      throw new WorkflowError(
        `Process exited with code ${exitCode}`,
        WorkflowErrorCode.NODE_FAILED,
        { node_id: node.id, exit_code: exitCode, stdout: stdoutStr },
      );
    }

    // 成功
    let json: unknown;
    try {
      json = JSON.parse(stdoutStr);
    } catch {
      // stdout 不是合法 JSON，json 留 undefined
    }

    await this.emitEvent(ctx, 'node.completed', node, {
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

  /** 构建表达式求值上下文 */
  private buildEvalContext(ctx: NodeExecutionContext): EvalContext {
    // 从 storage 读取已完成节点的输出
    // 注意：resolvedInputs 已经由 scheduler 解析过，这里用于 command/env 的模板解析
    return {
      params: ctx.params,
      secrets: ctx.secrets,
    };
  }

  /** 解析命令中的模板 */
  private resolveCommand(command: string | string[], evalContext: EvalContext): string[] {
    if (typeof command === 'string') {
      // 简单按空格分词（shell 风格）
      return ['/bin/sh', '-c', resolveTemplate(command, evalContext)];
    }
    return command.map((c) => resolveTemplate(c, evalContext));
  }

  /** 合并环境变量 */
  private resolveEnv(
    nodeEnv: Record<string, string> | undefined,
    evalContext: EvalContext,
    secrets: Record<string, string>,
  ): Record<string, string | undefined> {
    if (!nodeEnv && Object.keys(secrets).length === 0) return {};
    const resolved: Record<string, string | undefined> = {};
    if (nodeEnv) {
      for (const [k, v] of Object.entries(nodeEnv)) {
        resolved[k] = resolveTemplate(v, evalContext);
      }
    }
    // secrets 也注入为环境变量
    for (const [k, v] of Object.entries(secrets)) {
      resolved[k] = v;
    }
    return resolved;
  }

  /** 发射事件到 storage */
  private async emitEvent(
    ctx: NodeExecutionContext,
    type: import('../types/execution').EventType,
    node: ShellNodeDef,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const event: import('../types/execution').DAGEvent = {
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
