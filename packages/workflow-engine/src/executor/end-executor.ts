/**
 * End 节点执行器 — 声明式最终输出收集器。
 *
 * 职责：
 * - 不执行任何外部操作（无子进程、无网络请求）。
 * - 从 ctx.resolvedInputs 收集所有上游节点的输出值。
 * - 发射 node.started / node.completed 事件（与其他执行器一致）。
 * - 结果的 stdout 为 JSON.stringify(output)，json 为原始对象。
 */

import { nanoid } from "nanoid";
import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";

/** End 节点执行器 */
export class EndExecutor implements NodeExecutor {
  async execute(node: import("../types/dag").NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== "end") {
      throw new WorkflowError(
        `EndExecutor only handles 'end' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    // 发射 node.started 事件
    await ctx.storage.appendEvent({
      event_id: `evt_${nanoid(10)}`,
      run_id: ctx.runId,
      node_id: node.id,
      node_type: "end",
      timestamp: new Date().toISOString(),
      type: "node.started",
    });

    // 从 resolvedInputs 收集所有上游输出
    const allResolvedInputs = ctx.resolvedInputs.inputs as
      | Record<string, { value: unknown; rawExpression: string }>
      | Record<string, unknown>
      | undefined;

    // 提取纯值（兼容 ResolvedInput 包装格式和原始格式）
    const resolvedValues: Record<string, unknown> = {};
    if (allResolvedInputs) {
      for (const [key, entry] of Object.entries(allResolvedInputs)) {
        if (entry !== null && typeof entry === "object" && "value" in entry) {
          resolvedValues[key] = (entry as { value: unknown }).value;
        } else {
          resolvedValues[key] = entry;
        }
      }
    }

    const outputJson = JSON.stringify(resolvedValues);
    const outputSize = Buffer.byteLength(outputJson, "utf-8");

    // 发射 node.completed 事件
    await ctx.storage.appendEvent({
      event_id: `evt_${nanoid(10)}`,
      run_id: ctx.runId,
      node_id: node.id,
      node_type: "end",
      timestamp: new Date().toISOString(),
      type: "node.completed",
      metadata: {
        exit_code: 0,
        output_size: outputSize,
      },
    });

    return {
      stdout: outputJson,
      json: resolvedValues,
      exit_code: 0,
      size: outputSize,
    };
  }
}
