/**
 * CustomNodeExecutor — 桥接 CustomNodeRegistry 和引擎 NodeExecutor 接口。
 *
 * 按引擎的 NodeExecutor 接口实现 execute()，内部从 registry 查找工具、
 * 校验 inputs（Zod）、构建 ExecuteContext、调用 tool.execute()、确保 onCleanup() 被调用。
 *
 * 输入来源：ctx.resolvedInputs（由调度器 resolveNodeInputs 预先解析）。
 * 不自调用 resolveInputs — 表达式解析是调度器职责。
 */

import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import type { CustomNodeDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";
import { CustomNodeRegistry } from "./registry";
import type { ExecuteContext } from "./types";

export class CustomNodeExecutor implements NodeExecutor {
  constructor(private readonly registry: CustomNodeRegistry) {}

  async execute(node: Parameters<NodeExecutor["execute"]>[0], ctx: NodeExecutionContext): Promise<NodeOutput> {
    const customDef = node as unknown as CustomNodeDef;

    // 1. 从 registry 查找 tool
    const tool = this.registry.get(customDef.tool);
    if (!tool) {
      throw new WorkflowError(`Custom tool '${customDef.tool}' not registered`, WorkflowErrorCode.NODE_FAILED, {
        node_id: node.id,
        tool: customDef.tool,
      });
    }

    // 2. 从调度器预解析的 resolvedInputs 中提取 inputs 值
    // 调度器调用 resolveInputs(customDef.inputs, evalContext) 后存入 resolvedInputs.inputs
    const rawInputs = ctx.resolvedInputs.inputs as
      | Record<string, { value: unknown; rawExpression: string }>
      | undefined;
    const resolvedInputs: Record<string, unknown> = {};
    if (rawInputs) {
      for (const [key, entry] of Object.entries(rawInputs)) {
        resolvedInputs[key] = entry.value;
      }
    }

    // 3. Zod 校验
    for (const [key, def] of Object.entries(tool.inputs)) {
      const value = resolvedInputs[key];
      // 必填校验
      if (def.required !== false && (value === undefined || value === null)) {
        throw new WorkflowError(`Custom tool '${tool.name}' requires input '${key}'`, WorkflowErrorCode.NODE_FAILED, {
          node_id: node.id,
          tool: tool.name,
          input_key: key,
        });
      }
      // Zod schema 校验
      if (def.validate && value !== undefined) {
        try {
          def.validate.parse(value);
        } catch (err) {
          throw new WorkflowError(
            `Custom tool '${tool.name}' input '${key}' validation failed: ${(err as Error).message}`,
            WorkflowErrorCode.NODE_FAILED,
            { node_id: node.id, tool: tool.name, input_key: key },
          );
        }
      }
    }

    // 4. 构建 ExecuteContext
    const execCtx: ExecuteContext = {
      inputs: resolvedInputs,
      params: ctx.params,
      secrets: ctx.secrets,
      workDir: (ctx.params.work_dir as string) ?? "/tmp/workflow",
      signal: ctx.signal,
      storage: ctx.storage,
      runId: ctx.runId,
      nodeId: node.id,
    };

    // 5. 调用 tool.execute(ctx) + 确保 onCleanup
    let result: NodeOutput | null = null;
    let error: Error | null = null;
    try {
      result = await tool.execute(execCtx);
      return result;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      // 已经是 WorkflowError 的直接抛，否则包装
      if (error instanceof WorkflowError) {
        throw error;
      }
      throw new WorkflowError(
        `Custom tool '${tool.name}' execution failed: ${error.message}`,
        WorkflowErrorCode.NODE_FAILED,
        { node_id: node.id, tool: tool.name, cause: error },
      );
    } finally {
      // 6. 确保 onCleanup 被调用（无论成功失败）
      if (tool.onCleanup) {
        try {
          await tool.onCleanup(execCtx, result, error);
        } catch (cleanupErr) {
          console.error(`[CustomNodeExecutor] onCleanup failed for tool '${tool.name}':`, cleanupErr);
        }
      }
    }
  }
}
