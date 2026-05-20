/**
 * Python 节点执行器 — 通过 Bun.spawn 执行 Python 脚本。
 *
 * 职责：
 * - 从 resolvedInputs 读取已解析的 code、inputs 变量注入代码、env
 * - 将 preamble + code 写入临时 .py 文件
 * - 可选安装 pip 依赖（requirements 字段）
 * - 进程管理、超时控制、重试、事件发射（与 ProcessExecutor 一致）
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { PythonNodeDef } from '../types/dag';
import type { NodeExecutor, NodeExecutionContext } from '../scheduler/dag-scheduler';
import type { NodeOutput } from '../types/execution';
import type { ResolvedInput } from '../parser/inputs-resolver';
import { generatePythonPreamble } from '../parser/inputs-resolver';
import { WorkflowError, WorkflowErrorCode } from '../types/errors';

const MAX_STDERR_SIZE = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY_DELAY_MS = 1000;

export class PythonExecutor implements NodeExecutor {
  async execute(node: import('../types/dag').NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== 'python') {
      throw new WorkflowError(
        `PythonExecutor only handles 'python' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const pyNode = node as PythonNodeDef;

    // 从 resolvedInputs 获取 code（scheduler 已处理）
    const code = (ctx.resolvedInputs.code as string) ?? pyNode.code;

    // 生成 inputs 变量注入代码（preamble）
    const resolvedInputs = ctx.resolvedInputs.inputs as Record<string, ResolvedInput> | undefined;
    const preamble = resolvedInputs ? generatePythonPreamble(resolvedInputs) : '';
    const fullCode = preamble ? `${preamble}\n${code}` : code;

    // 合并环境变量：进程环境 + env（静态）+ secrets
    const env: Record<string, string | undefined> = { ...process.env as Record<string, string> };

    const nodeEnv = (ctx.resolvedInputs.env as Record<string, string>) ?? pyNode.env;
    if (nodeEnv) {
      for (const [k, v] of Object.entries(nodeEnv)) {
        env[k] = v;
      }
    }

    for (const [k, v] of Object.entries(ctx.secrets)) {
      env[k] = v;
    }

    const cwd = (ctx.resolvedInputs.cwd as string) ?? pyNode.cwd ?? process.cwd();

    const timeoutMs = (pyNode.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
    const timeoutController = new AbortController();

    if (ctx.signal.aborted) timeoutController.abort();

    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const onExternalAbort = () => { clearTimeout(timer); timeoutController.abort(); };
    ctx.signal.addEventListener('abort', onExternalAbort, { once: true });

    try {
      return await this.executeWithRetry(pyNode, fullCode, env, cwd, ctx, timeoutController.signal);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  private async executeWithRetry(
    node: PythonNodeDef,
    code: string,
    env: Record<string, string | undefined>,
    cwd: string,
    ctx: NodeExecutionContext,
    signal: AbortSignal,
  ): Promise<NodeOutput> {
    const retryConfig = node.retry;
    const maxAttempts = (retryConfig?.count ?? 0) + 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        return await this.spawnPython(node, code, env, cwd, ctx, signal);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (
          error instanceof WorkflowError &&
          (error.code === WorkflowErrorCode.NODE_TIMEOUT || error.code === WorkflowErrorCode.DAG_CANCELLED)
        ) {
          throw error;
        }
        if (attempt === maxAttempts - 1) throw lastError;
      }
    }

    throw lastError ?? new WorkflowError('All retry attempts exhausted', WorkflowErrorCode.NODE_FAILED);
  }

  private async spawnPython(
    node: PythonNodeDef,
    code: string,
    env: Record<string, string | undefined>,
    cwd: string,
    ctx: NodeExecutionContext,
    signal: AbortSignal,
  ): Promise<NodeOutput> {
    // 写入临时脚本文件
    const scriptPath = join(tmpdir(), `wf-python-${randomUUID()}.py`);
    await Bun.write(scriptPath, code);

    try {
      // 可选安装依赖
      if (node.requirements && node.requirements.length > 0) {
        await this.installRequirements(node.requirements, env, cwd, signal);
      }

      const subprocess = Bun.spawn(['python3', scriptPath], {
        cwd,
        env: { ...process.env as Record<string, string>, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const onAbort = () => subprocess.kill('SIGKILL');
      signal.addEventListener('abort', onAbort, { once: true });

      await this.emitEvent(ctx, 'node.started', node, {
        inputs: ctx.resolvedInputs,
        pid: subprocess.pid,
      });

      const stdoutChunks: Uint8Array[] = [];
      const stdoutReader = subprocess.stdout.getReader();

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

      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutChunks.push(value);
      }

      await stderrPromise;
      signal.removeEventListener('abort', onAbort);

      const exitCode = await subprocess.exited;

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

      if (exitCode !== 0) {
        await this.emitEvent(ctx, 'node.failed', node, {
          error: `Python exited with code ${exitCode}`,
          exit_code: exitCode,
        });
        throw new WorkflowError(
          `Python exited with code ${exitCode}`,
          WorkflowErrorCode.NODE_FAILED,
          { node_id: node.id, exit_code: exitCode, stdout: stdoutStr },
        );
      }

      let json: unknown;
      try { json = JSON.parse(stdoutStr); } catch { /* not JSON */ }

      await this.emitEvent(ctx, 'node.completed', node, {
        exit_code: exitCode,
        output_size: outputSize,
      });

      return { stdout: stdoutStr, json, exit_code: exitCode, size: outputSize };
    } finally {
      await unlink(scriptPath).catch(() => {});
    }
  }

  /** 安装 pip 依赖 */
  private async installRequirements(
    requirements: string[],
    env: Record<string, string | undefined>,
    cwd: string,
    signal: AbortSignal,
  ): Promise<void> {
    const pip = Bun.spawn(['pip', 'install', '--quiet', ...requirements], {
      cwd,
      env: { ...process.env as Record<string, string>, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const onAbort = () => pip.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });

    const exitCode = await pip.exited;
    signal.removeEventListener('abort', onAbort);

    if (exitCode !== 0) {
      const stderr = await new Response(pip.stderr).text();
      throw new WorkflowError(
        `pip install failed (exit ${exitCode}): ${stderr.substring(0, 500)}`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }
  }

  private async emitEvent(
    ctx: NodeExecutionContext,
    type: import('../types/execution').EventType,
    node: PythonNodeDef,
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
