/**
 * Transform 节点执行器 — 纯内存 JSON 变换。
 *
 * 职责：
 * - 从 ctx.resolvedInputs 获取已解析的 inputs（通过 resolveInputs 解析的表达式值）
 * - 构建作用域对象：inputs 变量 + params + secrets
 * - 对 output 中每个 key 的 JS 表达式通过 new Function() 求值
 * - 组装结果为 JSON 对象，stdout 为 JSON.stringify(result)
 * - 任一表达式失败 → 整节点失败
 */

import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import type { TransformNodeDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";

/** Transform 节点执行器 */
export class TransformExecutor implements NodeExecutor {
  async execute(node: import("../types/dag").NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== "transform") {
      throw new WorkflowError(
        `TransformExecutor only handles 'transform' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const transformNode = node as TransformNodeDef;

    // 从 resolvedInputs 提取 inputs 变量值（resolveInputs 返回 { key: { value, rawExpression } }）
    const resolvedInputVars: Record<string, unknown> = {};
    const rawInputs = ctx.resolvedInputs.inputs as
      | Record<string, { value: unknown; rawExpression: string }>
      | undefined;
    if (rawInputs) {
      for (const [key, entry] of Object.entries(rawInputs)) {
        resolvedInputVars[key] = entry.value;
      }
    }

    // 构建表达式求值作用域
    const scope: Record<string, unknown> = {
      ...resolvedInputVars,
      params: ctx.params,
      secrets: ctx.secrets,
    };

    const result: Record<string, unknown> = {};

    for (const [key, expr] of Object.entries(transformNode.output)) {
      try {
        const fn = new Function(...Object.keys(scope), `"use strict"; return (${expr})`);
        result[key] = fn(...Object.values(scope));
      } catch (err) {
        throw new WorkflowError(
          `Transform expression '${key}' failed: ${(err as Error).message}`,
          WorkflowErrorCode.NODE_FAILED,
          {
            node_id: transformNode.id,
            output_key: key,
            expression: expr,
          },
        );
      }
    }

    const outputJson = JSON.stringify(result);

    return {
      stdout: outputJson,
      json: result,
      exit_code: 0,
      size: Buffer.byteLength(outputJson, "utf-8"),
    };
  }
}
