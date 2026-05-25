/**
 * 循环节点执行器 — 实现 do-while 语义的子 DAG 循环执行。
 *
 * 职责：
 * - 每次迭代创建独立子 DAG（节点 ID 带前缀避免冲突）
 * - do-while 语义：先执行一次，再求值条件决定是否继续
 * - max_iterations 保护：达到上限时强制退出并抛 LOOP_MAX_ITERATIONS
 * - 子 DAG 失败时循环节点整体失败
 * - 发射 loop.iteration_started / loop.iteration_completed 事件
 */

import { nanoid } from "nanoid";
import type { NodeExecutorRegistry } from "../executor/node-executor";
import { evaluateExpression, parseExpression } from "../parser/expression-parser";
import { CancellationManager } from "../scheduler/cancellation";
import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import { DAGScheduler } from "../scheduler/dag-scheduler";
import type { LoopNodeDef, NodeDef, WorkflowDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";
import type { EvalContext } from "../types/expression";

// ---------- 常量 ----------

/** 条件表达式 `${{ }}` 包装模式 */
const EXPRESSION_WRAPPER = /^\$\{\{\s*(.+?)\s*\}\}$/;

// ---------- LoopExecutor ----------

/** 循环节点执行器 — do-while 语义 */
export class LoopExecutor implements NodeExecutor {
  constructor(
    private readonly parentRunId: string,
    private readonly registry: NodeExecutorRegistry,
  ) {}

  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== "loop") {
      throw new WorkflowError(
        `LoopExecutor only handles 'loop' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const loopNode = node as LoopNodeDef;
    const { condition, max_iterations, body } = loopNode;
    const loopNodeId = node.id;

    // 解析条件表达式（剥离 ${{ }} 包装）
    const rawCondition = this.stripExpressionWrapper(condition);
    const conditionAst = parseExpression(rawCondition);

    let lastOutput: NodeOutput | null = null;
    let exitedViaBreak = false;

    for (let i = 0; i < max_iterations; i++) {
      // 检查父级取消信号
      if (ctx.signal.aborted) {
        throw new WorkflowError("Loop cancelled", WorkflowErrorCode.DAG_CANCELLED, {
          node_id: loopNodeId,
          iteration: i,
        });
      }

      // 发射 loop.iteration_started 事件
      await this.emitLoopEvent(ctx, "loop.iteration_started", loopNodeId, {
        iteration: i,
        max_iterations,
      });

      // 创建子 DAG（带命名空间前缀）
      const subRunId = `${this.parentRunId}_${loopNodeId}_iter${i}`;
      const prefix = `${loopNodeId}.iter${i}.`;
      const prefixedNodes = this.prefixNodeIds(body.nodes, prefix);
      const subWorkflowDef: WorkflowDef = {
        schema_version: "1.0",
        name: `${loopNodeId}-iteration-${i}`,
        nodes: prefixedNodes,
      };

      // 创建迭代级别的 CancellationManager，与父信号联动
      const iterCancellation = new CancellationManager();
      if (ctx.signal.aborted) {
        iterCancellation.cancel();
      }
      const onParentAbort = () => iterCancellation.cancel();
      ctx.signal.addEventListener("abort", onParentAbort, { once: true });

      try {
        // 创建子 DAG 调度器并执行
        const scheduler = new DAGScheduler({
          runId: subRunId,
          workflowDef: subWorkflowDef,
          storage: ctx.storage,
          params: ctx.params,
          secrets: ctx.secrets,
          nodeExecutor: this.registry,
          cancellation: iterCancellation,
        });

        const result = await scheduler.run();

        if (result.status === "FAILED" || result.status === "ERROR") {
          throw new WorkflowError(`Loop iteration ${i} failed`, WorkflowErrorCode.NODE_FAILED, {
            node_id: loopNodeId,
            iteration: i,
            sub_status: result.status,
          });
        }

        if (result.status === "CANCELLED") {
          throw new WorkflowError("Loop cancelled during iteration", WorkflowErrorCode.DAG_CANCELLED, {
            node_id: loopNodeId,
            iteration: i,
          });
        }

        // 构建迭代输出映射（使用原始节点 ID，不带前缀）
        const iterOutputs = await this.buildIterationOutputs(subRunId, ctx, body.nodes, prefix);

        // 求值条件（使用原始节点 ID）
        const evalCtx: EvalContext = {
          nodes: iterOutputs,
          params: ctx.params,
          secrets: ctx.secrets,
        };
        const condResult = evaluateExpression(conditionAst, evalCtx);
        const willContinue = !!condResult;

        // 发射 loop.iteration_completed 事件
        await this.emitLoopEvent(ctx, "loop.iteration_completed", loopNodeId, {
          iteration: i,
          will_continue: willContinue,
        });

        // 获取最后一次迭代的最终节点输出（拓扑序最后一个节点）
        lastOutput = this.getLastNodeOutput(body.nodes, iterOutputs);

        if (!willContinue) {
          exitedViaBreak = true;
          break;
        }
      } finally {
        ctx.signal.removeEventListener("abort", onParentAbort);
      }
    }

    // for 循环正常结束（未 break）意味着条件始终为 true，达到 max_iterations
    if (!exitedViaBreak) {
      throw new WorkflowError(
        `Loop exceeded max_iterations (${max_iterations})`,
        WorkflowErrorCode.LOOP_MAX_ITERATIONS,
        { node_id: loopNodeId, max_iterations },
      );
    }

    return (
      lastOutput ?? {
        stdout: "",
        json: { iterations: 0 },
        exit_code: 0,
      }
    );
  }

  // ---------- 私有方法 ----------

  /** 剥离 ${{ }} 包装，返回内部表达式 */
  private stripExpressionWrapper(expr: string): string {
    const match = expr.match(EXPRESSION_WRAPPER);
    return match ? match[1] : expr;
  }

  /** 为子 DAG 节点 ID 添加命名空间前缀，同步更新 depends_on */
  private prefixNodeIds(nodes: NodeDef[], prefix: string): NodeDef[] {
    return nodes.map((node) => ({
      ...node,
      id: `${prefix}${node.id}`,
      depends_on: node.depends_on?.map((dep) => `${prefix}${dep}`),
    }));
  }

  /** 从子 DAG 执行结果中提取节点输出，映射回原始节点 ID */
  private async buildIterationOutputs(
    subRunId: string,
    ctx: NodeExecutionContext,
    bodyNodes: NodeDef[],
    prefix: string,
  ): Promise<Record<string, { output: Record<string, unknown>; status: string }>> {
    const result: Record<string, { output: Record<string, unknown>; status: string }> = {};

    for (const node of bodyNodes) {
      const prefixedId = `${prefix}${node.id}`;
      const output = await ctx.storage.getOutput(subRunId, prefixedId);
      result[node.id] = {
        output: (output?.json ?? { stdout: output?.stdout ?? "" }) as Record<string, unknown>,
        status: output ? "COMPLETED" : "PENDING",
      };
    }

    return result;
  }

  /** 获取子 DAG 中拓扑序最后一个节点的输出 */
  private getLastNodeOutput(
    bodyNodes: NodeDef[],
    iterOutputs: Record<string, { output: Record<string, unknown>; status: string }>,
  ): NodeOutput {
    // 按依赖排序：没有下游依赖的节点是"最后"的节点
    // 简单策略：取 depends_on 最多或最后一个定义的节点
    // 更精确：拓扑排序后取最后一个
    const lastNode = bodyNodes[bodyNodes.length - 1];
    const lastOutput = iterOutputs[lastNode.id];
    return {
      stdout: typeof lastOutput?.output?.stdout === "string" ? lastOutput.output.stdout : "",
      json: lastOutput?.output,
      exit_code: 0,
    };
  }

  /** 发射循环节点事件 */
  private async emitLoopEvent(
    ctx: NodeExecutionContext,
    type: "loop.iteration_started" | "loop.iteration_completed",
    nodeId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const event: import("../types/execution").DAGEvent = {
      event_id: `evt_${nanoid(10)}`,
      run_id: ctx.runId,
      node_id: nodeId,
      node_type: "loop",
      timestamp: new Date().toISOString(),
      type,
      metadata,
    };
    await ctx.storage.appendEvent(event);
  }
}
