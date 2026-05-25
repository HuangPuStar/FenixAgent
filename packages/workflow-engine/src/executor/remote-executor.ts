/**
 * 远程执行器共享基类 — 提供 cancel 逻辑和事件发射。
 *
 * API / Agent 等远程节点执行器的公共抽象基类，
 * 将事件发射、重试退避、AbortSignal 组合等通用逻辑抽取到一处。
 */

import { nanoid } from "nanoid";
import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import type { NodeDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { DAGEvent, EventType, NodeOutput } from "../types/execution";

// ---------- 常量 ----------

const DEFAULT_TIMEOUT_MS = 300_000; // 5 分钟
const DEFAULT_RETRY_DELAY_MS = 1000;
const LARGE_RESPONSE_THRESHOLD = 1024 * 1024; // 1MB

// ---------- RemoteExecutorBase ----------

/** 远程执行器共享基类 */
export abstract class RemoteExecutorBase implements NodeExecutor {
  abstract execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput>;

  // ---------- 事件发射 ----------

  /** 发射 node.started 事件 */
  protected async emitNodeStarted(
    nodeId: string,
    nodeType: NodeDef["type"],
    ctx: NodeExecutionContext,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.emitEvent(ctx, "node.started", nodeId, nodeType, metadata);
  }

  /** 发射 node.completed 事件 */
  protected async emitNodeCompleted(
    nodeId: string,
    nodeType: NodeDef["type"],
    ctx: NodeExecutionContext,
    output: NodeOutput,
  ): Promise<void> {
    await this.emitEvent(ctx, "node.completed", nodeId, nodeType, {
      exit_code: output.exit_code,
      output_size: output.size,
    });
  }

  /** 发射 node.failed 事件 */
  protected async emitNodeFailed(
    nodeId: string,
    nodeType: NodeDef["type"],
    ctx: NodeExecutionContext,
    error: string,
    exitCode?: number,
  ): Promise<void> {
    await this.emitEvent(ctx, "node.failed", nodeId, nodeType, {
      error,
      ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    });
  }

  /** 发射 node.retrying 事件 */
  protected async emitNodeRetrying(
    nodeId: string,
    nodeType: NodeDef["type"],
    ctx: NodeExecutionContext,
    attempt: number,
    maxAttempts: number,
    nextDelayMs: number,
  ): Promise<void> {
    await this.emitEvent(ctx, "node.retrying", nodeId, nodeType, {
      attempt,
      max_attempts: maxAttempts,
      next_delay_ms: nextDelayMs,
    });
  }

  // ---------- 重试辅助 ----------

  /**
   * 带重试的执行循环。
   * 返回 NodeOutput（成功）或抛出 WorkflowError（最终失败）。
   */
  protected async executeWithRetry<T extends NodeDef>(
    node: T,
    ctx: NodeExecutionContext,
    doExecute: (attempt: number, signal: AbortSignal) => Promise<NodeOutput>,
  ): Promise<NodeOutput> {
    const retryConfig = node.retry;
    const maxAttempts = (retryConfig?.count ?? 0) + 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const baseDelay = retryConfig?.delay ?? DEFAULT_RETRY_DELAY_MS;
        const multiplier = retryConfig?.backoff === "exponential" ? 2 ** (attempt - 1) : 1;
        const jitter = 0.5 + Math.random() * 0.5;
        const delay = Math.round(baseDelay * multiplier * jitter);

        await this.emitNodeRetrying(node.id, node.type, ctx, attempt + 1, maxAttempts, delay);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // 为每次尝试创建独立的 AbortSignal（超时 + 外部取消）
      const timeoutMs = (node.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
      const controller = new AbortController();

      if (ctx.signal.aborted) {
        controller.abort();
      }

      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onExternalAbort = () => {
        clearTimeout(timer);
        controller.abort();
      };
      ctx.signal.addEventListener("abort", onExternalAbort, { once: true });

      try {
        return await doExecute(attempt, controller.signal);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (
          error instanceof WorkflowError &&
          (error.code === WorkflowErrorCode.NODE_TIMEOUT || error.code === WorkflowErrorCode.DAG_CANCELLED)
        ) {
          throw error;
        }
        if (attempt === maxAttempts - 1) throw lastError;
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onExternalAbort);
      }
    }

    throw lastError ?? new WorkflowError("All retry attempts exhausted", WorkflowErrorCode.NODE_FAILED);
  }

  // ---------- 响应处理 ----------

  /**
   * 处理 HTTP 响应体：尝试 JSON 解析，超过阈值写入临时文件。
   */
  protected async processResponseBody(
    bodyText: string,
    ctx: NodeExecutionContext,
  ): Promise<{ stdout: string; json?: unknown; size: number; ref?: string }> {
    const size = Buffer.byteLength(bodyText);

    // 大响应写入临时文件
    let ref: string | undefined;
    if (size > LARGE_RESPONSE_THRESHOLD) {
      const tmpPath = `/tmp/wf-api-${ctx.runId}-${nanoid(8)}.txt`;
      await Bun.write(tmpPath, bodyText);
      ref = tmpPath;
    }

    // 尝试 JSON 解析
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      // 非 JSON，json 留 undefined
    }

    return { stdout: bodyText, json, size, ref };
  }

  // ---------- 内部方法 ----------

  private async emitEvent(
    ctx: NodeExecutionContext,
    type: EventType,
    nodeId: string,
    nodeType: NodeDef["type"],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const event: DAGEvent = {
      event_id: `evt_${nanoid(10)}`,
      run_id: ctx.runId,
      node_id: nodeId,
      node_type: nodeType,
      timestamp: new Date().toISOString(),
      type,
      ...(metadata ? { metadata } : {}),
    };
    await ctx.storage.appendEvent(event);
  }
}
