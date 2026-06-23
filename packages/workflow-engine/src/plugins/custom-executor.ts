/**
 * CustomNodeExecutor — 桥接 CustomNodeRegistry 和引擎 NodeExecutor 接口。
 *
 * 按引擎的 NodeExecutor 接口实现 execute()，内部从 registry 查找工具、
 * 校验 inputs（Zod）、构建 ExecuteContext、调用 tool.execute()、确保 onCleanup() 被调用。
 *
 * 输入来源：ctx.resolvedInputs（由调度器 resolveNodeInputs 预先解析）。
 * 不自调用 resolveInputs — 表达式解析是调度器职责。
 *
 * 事件发射契约（与 process-executor 对齐）：执行器内部必须发射
 * node.started / node.completed / node.failed 事件，否则前端"事件流"为空。
 */

import { nanoid } from "nanoid";
import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import type { CustomNodeDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { DAGEvent, EventType, NodeOutput } from "../types/execution";
import type { CustomNodeRegistry } from "./registry";
import type { ExecuteContext } from "./types";

export class CustomNodeExecutor implements NodeExecutor {
  constructor(private readonly registry: CustomNodeRegistry) {}

  async execute(node: Parameters<NodeExecutor["execute"]>[0], ctx: NodeExecutionContext): Promise<NodeOutput> {
    const customDef = node as unknown as CustomNodeDef;

    // 1. 从 registry 查找 tool
    const tool = this.registry.get(customDef.tool);
    if (!tool) {
      // 校验阶段失败也算 node.failed：用户能在事件流看到 "tool not registered"
      await this.emitEvent(ctx, node, "node.failed", {
        error: `Custom tool '${customDef.tool}' not registered`,
        tool: customDef.tool,
      });
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

    // 3. Zod 校验（失败时直接抛，事件流由 catch 块补发 node.failed）
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
      // 透传 YAML 节点声明的 slurm 资源（仅 SlurmNode 子类消费）
      slurm: customDef.slurm,
      // 透传已求值的 script(仅 SlurmNode 子类会有值,由调度器 resolveNodeInputs 求值后注入)
      script: (ctx.resolvedInputs.script as ExecuteContext["script"]) ?? undefined,
      signal: ctx.signal,
      storage: ctx.storage,
      runId: ctx.runId,
      nodeId: node.id,
    };

    // 5. 发射 node.started 事件 — 关键：CustomNode 之前不发任何事件，导致前端"事件流"为空
    await this.emitEvent(ctx, node, "node.started", { tool: tool.name });

    // 6. 调用 tool.execute(ctx) + 确保 onCleanup
    let result: NodeOutput | null = null;
    let error: Error | null = null;
    try {
      result = await tool.execute(execCtx);
      // 成功：发射 node.completed 事件（字段名 output_size 与 process-executor 一致，
      // 前端 formatMeta 对 node.completed 只读 output_size）
      await this.emitEvent(ctx, node, "node.completed", {
        tool: tool.name,
        exit_code: result.exit_code,
        output_size: result.size,
      });
      return result;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));

      // 失败：发射 node.failed 事件，metadata 必须包含 error + stderr + stdout + exit_code，
      // 否则前端只看到 "exit_code: 1 / 0B 输出"，完全不知道失败原因。
      const wfErr = error instanceof WorkflowError ? error : null;
      const details = (wfErr?.details ?? {}) as Record<string, unknown>;
      await this.emitEvent(ctx, node, "node.failed", {
        tool: tool.name,
        error: error.message,
        exit_code: (details.exit_code as number) ?? 1,
        ...(details.stderr ? { stderr: details.stderr } : {}),
        ...(details.stdout ? { stdout: details.stdout } : {}),
        ...(details.slurm_job_id ? { slurm_job_id: details.slurm_job_id } : {}),
      });

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
      // 7. 确保 onCleanup 被调用（无论成功失败）
      if (tool.onCleanup) {
        try {
          await tool.onCleanup(execCtx, result, error);
        } catch (cleanupErr) {
          console.error(`[CustomNodeExecutor] onCleanup failed for tool '${tool.name}':`, cleanupErr);
        }
      }
    }
  }

  /** 发射事件到 storage（与 process-executor 对齐的事件格式） */
  private async emitEvent(
    ctx: NodeExecutionContext,
    node: { id: string; type: string },
    type: EventType,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const event: DAGEvent = {
      event_id: `evt_${nanoid(10)}`,
      run_id: ctx.runId,
      node_id: node.id,
      // node.type 在 CustomNodeExecutor 上下文里一定是 NodeType union 中的合法值（"custom"）；
      // 这里 narrow 到 NodeType 以满足 DAGEvent 类型约束。
      node_type: node.type as DAGEvent["node_type"],
      timestamp: new Date().toISOString(),
      type,
      ...(metadata ? { metadata } : {}),
    };
    await ctx.storage.appendEvent(event);
  }
}
