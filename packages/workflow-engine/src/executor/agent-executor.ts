/**
 * Agent 节点执行器 — 通过 Transport 接口与 AI Agent 通信。
 *
 * 职责：
 * - 类型守卫：仅处理 'agent' 节点
 * - 从 resolvedInputs 读取已解析的 prompt/agent/skill/model/temperature/steps
 * - Transport 连接：connect → execute → 收集响应
 * - 重试：默认 2 次指数退避（不同于 ShellNode 的 0 次）
 * - 事件发射：node.started / node.completed / node.failed / node.retrying
 */

import { nanoid } from 'nanoid';
import type { AgentNodeDef, NodeDef } from '../types/dag';
import type { NodeExecutor, NodeExecutionContext } from '../scheduler/dag-scheduler';
import type { NodeOutput } from '../types/execution';
import type { Transport, AgentRequest } from '../transport/transport';
import { WorkflowError, WorkflowErrorCode } from '../types/errors';

/** 从宿主层获取的 agent 配置 */
export interface AgentResolvedConfig {
  model: string | null;
  steps: number | null;
  temperature: number | null;
  permission: unknown;
  knowledge: unknown;
}

/** AgentExecutor 构造选项 */
export interface AgentExecutorOptions {
  /** 注入的 agent 配置解析回调（方案 A） */
  resolveAgentConfig?: (agentName: string) => Promise<AgentResolvedConfig | null>;
}

// ---------- 常量 ----------

const DEFAULT_RETRY_DELAY_MS = 1000;

// ---------- AgentExecutor ----------

/** Agent 节点执行器 */
export class AgentExecutor implements NodeExecutor {
  constructor(
    private transport: Transport,
    private options?: AgentExecutorOptions,
  ) {}

  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== 'agent') {
      throw new WorkflowError(
        `AgentExecutor only handles 'agent' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const agentNode = node as AgentNodeDef;

    // 从 resolvedInputs 读取已解析的模板值（scheduler 已处理）
    const resolvedPrompt = (ctx.resolvedInputs.prompt as string) ?? agentNode.prompt;
    const resolvedAgent = (ctx.resolvedInputs.agent as string | undefined) ?? agentNode.agent;
    const resolvedSkill = (ctx.resolvedInputs.skill as string | undefined) ?? agentNode.skill;

    // 合并 agent config + 节点级覆盖
    const mergedConfig = await this.resolveAndMergeConfig(agentNode);

    // 重试配置：默认 2 次（ShellNode 默认 0 次）
    const retryConfig = agentNode.retry ?? { count: 2, delay: DEFAULT_RETRY_DELAY_MS, backoff: 'exponential' };
    const maxAttempts = (retryConfig.count ?? 2) + 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 重试时发射 node.retrying 事件
      if (attempt > 0) {
        const baseDelay = retryConfig.delay ?? DEFAULT_RETRY_DELAY_MS;
        const multiplier = retryConfig.backoff === 'exponential' ? Math.pow(2, attempt - 1) : 1;
        const jitter = 0.5 + Math.random() * 0.5;
        const delay = Math.round(baseDelay * multiplier * jitter);

        await this.emitEvent(ctx, 'node.retrying', agentNode, {
          attempt: attempt + 1,
          max_attempts: maxAttempts,
          next_delay_ms: delay,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        return await this.executeOnce(agentNode, ctx, resolvedPrompt, resolvedAgent, resolvedSkill, mergedConfig);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // AbortError（取消）不重试
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new WorkflowError(
            'Node cancelled',
            WorkflowErrorCode.DAG_CANCELLED,
            { node_id: node.id },
          );
        }

        // 最后一次失败直接抛出
        if (attempt === maxAttempts - 1) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new WorkflowError('All retry attempts exhausted', WorkflowErrorCode.NODE_FAILED);
  }

  /** 单次执行：connect → execute → 收集输出 */
  private async executeOnce(
    node: AgentNodeDef,
    ctx: NodeExecutionContext,
    resolvedPrompt: string,
    resolvedAgent: string | undefined,
    resolvedSkill: string | undefined,
    mergedConfig: Partial<AgentResolvedConfig>,
  ): Promise<NodeOutput> {
    // 发射 node.started 事件
    await this.emitEvent(ctx, 'node.started', node, {
      inputs: ctx.resolvedInputs,
      agent: resolvedAgent,
      skill: resolvedSkill,
    });

    // 连接 Transport
    const session = await this.transport.connect(resolvedAgent ?? 'default', {
      cwd: node.cwd,
    });

    // 构建请求
    const request: AgentRequest = {
      prompt: resolvedPrompt,
      agent: resolvedAgent,
      skill: resolvedSkill,
      cwd: node.cwd,
      signal: ctx.signal,
      model: mergedConfig.model ?? undefined,
      temperature: mergedConfig.temperature ?? undefined,
      steps: mergedConfig.steps ?? undefined,
      permission: mergedConfig.permission ?? undefined,
      knowledge: mergedConfig.knowledge ?? undefined,
    };

    // 执行请求
    const response = await session.execute(request);

    const outputSize = Buffer.byteLength(response.stdout);

    // 非零退出码 → 失败
    if (response.exit_code !== 0) {
      await this.emitEvent(ctx, 'node.failed', node, {
        error: `Agent exited with code ${response.exit_code}`,
        exit_code: response.exit_code,
      });
      throw new WorkflowError(
        `Agent exited with code ${response.exit_code}`,
        WorkflowErrorCode.NODE_FAILED,
        { node_id: node.id, exit_code: response.exit_code, stdout: response.stdout },
      );
    }

    // 尝试解析 JSON
    let json: unknown;
    try {
      json = JSON.parse(response.stdout);
    } catch {
      // stdout 不是合法 JSON，json 留 undefined
    }

    // 发射 node.completed 事件（含 token 统计）
    await this.emitEvent(ctx, 'node.completed', node, {
      exit_code: response.exit_code,
      output_size: outputSize,
      tokens: response.tokens,
      model: response.model,
      latency_ms: response.latency_ms,
    });

    return {
      stdout: response.stdout,
      json,
      exit_code: response.exit_code,
      size: outputSize,
    };
  }

  /** 解析 agent config 并合并节点级覆盖 */
  private async resolveAndMergeConfig(node: AgentNodeDef): Promise<Partial<AgentResolvedConfig>> {
    if (!node.agent || !this.options?.resolveAgentConfig) {
      return {
        model: node.model ?? null,
        temperature: node.temperature ?? null,
        steps: node.steps ?? null,
        permission: null,
        knowledge: null,
      };
    }

    const config = await this.options.resolveAgentConfig(node.agent);

    if (!config) {
      return {
        model: node.model ?? null,
        temperature: node.temperature ?? null,
        steps: node.steps ?? null,
        permission: null,
        knowledge: null,
      };
    }

    return {
      model: node.model ?? config.model,
      temperature: node.temperature ?? config.temperature,
      steps: node.steps ?? config.steps,
      permission: config.permission,
      knowledge: config.knowledge,
    };
  }

  /** 发射事件到 storage */
  private async emitEvent(
    ctx: NodeExecutionContext,
    type: import('../types/execution').EventType,
    node: AgentNodeDef,
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
