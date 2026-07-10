/**
 * Agent 节点执行器 — 通过 Transport 接口与 Environment 的 Agent 通信。
 *
 * 职责：
 * - 类型守卫：仅处理 'agent' 节点
 * - Transport 连接：connect(envName) → execute(prompt) → 收集会话流
 * - 输出：简化 stdout（simplified），messages 仅在 output_messages > 0 时回传
 * - 重试：默认 2 次指数退避
 * - 事件发射：node.started / node.completed / node.failed / node.retrying
 */

import { nanoid } from "nanoid";
import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import type { AgentRequest, Transport } from "../transport/transport";
import type { AgentNodeDef, NodeDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";

// ---------- 常量 ----------

const DEFAULT_RETRY_DELAY_MS = 1000;
/** 节点级默认超时（connect + execute 合计），单位毫秒 */
const DEFAULT_NODE_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

// ---------- AgentExecutor ----------

/** Agent 节点执行器 */
export class AgentExecutor implements NodeExecutor {
  constructor(private transport: Transport) {}

  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== "agent") {
      throw new WorkflowError(
        `AgentExecutor only handles 'agent' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const agentNode = node as AgentNodeDef;
    const resolvedPrompt = (ctx.resolvedInputs.prompt as string) ?? agentNode.prompt;
    const resolvedAgent = (ctx.resolvedInputs.agent as string) ?? agentNode.agent;

    // 节点级 AbortController：隔离 DAG 超时与节点超时
    // 与 ProcessExecutor 同模式 — DAG 取消会传播到节点，但节点有自己的超时
    const timeoutMs = (agentNode.timeout ?? DEFAULT_NODE_TIMEOUT_MS / 1000) * 1000;
    const nodeAbort = new AbortController();

    if (ctx.signal.aborted) {
      nodeAbort.abort();
    }

    const timer = setTimeout(() => {
      nodeAbort.abort();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const onDagCancel = () => {
      clearTimeout(timer);
      nodeAbort.abort();
    };
    ctx.signal.addEventListener("abort", onDagCancel, { once: true });

    try {
      return await this.executeWithRetry(agentNode, ctx, resolvedPrompt, resolvedAgent, nodeAbort.signal);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onDagCancel);
    }
  }

  /** 带重试的执行循环 */
  private async executeWithRetry(
    node: AgentNodeDef,
    ctx: NodeExecutionContext,
    resolvedPrompt: string,
    resolvedAgent: string,
    signal: AbortSignal,
  ): Promise<NodeOutput> {
    const retryConfig = node.retry ?? { count: 2, delay: DEFAULT_RETRY_DELAY_MS, backoff: "exponential" };
    const maxAttempts = (retryConfig.count ?? 2) + 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const baseDelay = retryConfig.delay ?? DEFAULT_RETRY_DELAY_MS;
        const multiplier = retryConfig.backoff === "exponential" ? 2 ** (attempt - 1) : 1;
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
        return await this.executeOnce(node, ctx, resolvedPrompt, resolvedAgent, signal);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        console.error(
          `[workflow] AgentExecutor attempt ${attempt + 1}/${maxAttempts} failed: nodeId=${node.id} error=${lastError.message} errorType=${lastError.constructor.name}`,
        );

        // 节点超时（AbortSignal.timeout 触发的 abort）不重试
        if (signal.aborted && !ctx.signal.aborted) {
          throw new WorkflowError(
            `Agent node timed out after ${((node.timeout ?? DEFAULT_NODE_TIMEOUT_MS / 1000) * 1000) / 1000}s`,
            WorkflowErrorCode.NODE_TIMEOUT,
            { node_id: node.id },
          );
        }

        // DAG 级取消不重试
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new WorkflowError("Node cancelled", WorkflowErrorCode.DAG_CANCELLED, {
            node_id: node.id,
            abort_reason: error.message,
          });
        }

        // WorkflowError 中的 DAG_CANCELLED 也不重试（来自 transport 内部的 abort 处理）
        if (error instanceof WorkflowError && error.code === WorkflowErrorCode.DAG_CANCELLED) {
          throw error;
        }

        if (attempt === maxAttempts - 1) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new WorkflowError("All retry attempts exhausted", WorkflowErrorCode.NODE_FAILED);
  }

  /** 单次执行：connect → execute → 收集会话流 */
  private async executeOnce(
    node: AgentNodeDef,
    ctx: NodeExecutionContext,
    resolvedPrompt: string,
    resolvedAgent: string,
    signal: AbortSignal,
  ): Promise<NodeOutput> {
    console.error(
      `[workflow] AgentExecutor executeOnce start: nodeId=${node.id} agent=${resolvedAgent} signalAborted=${signal.aborted} dagSignalAborted=${ctx.signal.aborted}`,
    );

    await this.emitEvent(ctx, "node.started", node, {
      inputs: ctx.resolvedInputs,
      agent: resolvedAgent,
    });

    // 连接 Transport（resolvedAgent 是环境名称，Transport 层负责解析为 envId）
    console.error(`[workflow] AgentExecutor connecting: nodeId=${node.id} agent=${resolvedAgent}`);
    const session = await this.transport.connect(resolvedAgent, {
      spawnedEnvIds: ctx.spawnedEnvIds,
    });

    console.error(
      `[workflow] AgentExecutor connected: nodeId=${node.id} signalAborted=${signal.aborted} dagSignalAborted=${ctx.signal.aborted}`,
    );

    // 使用节点级信号，而非 DAG 级共享信号
    const request: AgentRequest = {
      prompt: resolvedPrompt,
      signal,
    };

    console.error(`[workflow] AgentExecutor sending prompt: nodeId=${node.id} promptLength=${resolvedPrompt.length}`);

    const response = await session.execute(request);

    const outputSize = Buffer.byteLength(response.stdout);

    if (response.exit_code !== 0) {
      const errorMessage = response.stdout
        ? `Agent exited with code ${response.exit_code}: ${response.stdout.slice(0, 500)}`
        : `Agent exited with code ${response.exit_code}`;
      await this.emitEvent(ctx, "node.failed", node, {
        error: errorMessage,
        exit_code: response.exit_code,
        stdout: response.stdout,
      });
      throw new WorkflowError(errorMessage, WorkflowErrorCode.NODE_FAILED, {
        node_id: node.id,
        exit_code: response.exit_code,
        stdout: response.stdout,
      });
    }

    // 构建 json 输出：simplified 始终存在，messages 仅在 output_messages > 0 时回传最后 N 条
    const outputMessages = node.output_messages ?? 0;
    const json: Record<string, unknown> = {
      simplified: response.stdout,
    };
    if (outputMessages > 0 && response.messages.length > 0) {
      json.messages = response.messages.slice(-outputMessages);
    }

    // 尝试解析 stdout 为 JSON
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(response.stdout);
    } catch {
      // stdout 不是合法 JSON
    }

    await this.emitEvent(ctx, "node.completed", node, {
      exit_code: response.exit_code,
      output_size: outputSize,
      message_count: response.messages.length,
      tokens: response.tokens,
      model: response.model,
      latency_ms: response.latency_ms,
    });

    return {
      stdout: response.stdout,
      json: parsedJson ?? json,
      exit_code: response.exit_code,
      size: outputSize,
    };
  }

  /** 发射事件到 storage */
  private async emitEvent(
    ctx: NodeExecutionContext,
    type: import("../types/execution").EventType,
    node: AgentNodeDef,
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
