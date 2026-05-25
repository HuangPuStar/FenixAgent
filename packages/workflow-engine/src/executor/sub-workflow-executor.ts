/**
 * 子流程节点执行器 — 解析并执行子工作流 YAML。
 *
 * 职责：
 * - 读取子工作流 YAML 文件（通过 node.ref 路径）
 * - 解析 + 校验子工作流定义
 * - 创建独立 DAGScheduler 执行子工作流
 * - 参数传递：父级 params 通过 resolvedInputs 传入子工作流
 * - 错误传播：子工作流失败时根据 ignore_errors 决定父节点状态
 * - 事件发射：sub_workflow.started / sub_workflow.completed
 */

import { join } from "node:path";
import { nanoid } from "nanoid";
import { validateDAG } from "../parser/dag-validator";
import { parseWorkflowYaml } from "../parser/yaml-parser";
import { CancellationManager } from "../scheduler/cancellation";
import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import { DAGScheduler } from "../scheduler/dag-scheduler";
import type { NodeDef, SubWorkflowNodeDef, WorkflowDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";
import type { NodeExecutorRegistry } from "./node-executor";

// ---------- SubWorkflowExecutor ----------

/** 子流程节点执行器 */
export class SubWorkflowExecutor implements NodeExecutor {
  private readonly parentRunId: string;
  private readonly parentBaseDir: string;
  private readonly registry: NodeExecutorRegistry;

  constructor(parentRunId: string, registry: NodeExecutorRegistry, parentBaseDir?: string) {
    this.parentRunId = parentRunId;
    this.parentBaseDir = parentBaseDir ?? process.cwd();
    this.registry = registry;
  }

  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== "workflow") {
      throw new WorkflowError(
        `SubWorkflowExecutor only handles 'workflow' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const wfNode = node as SubWorkflowNodeDef;

    // 解析子工作流 YAML 路径（模板已由 scheduler 解析）
    const refPath = String(ctx.resolvedInputs.ref ?? wfNode.ref);
    const absRefPath = join(this.parentBaseDir, refPath);

    // 读取 YAML 文件
    let source: string;
    try {
      source = await Bun.file(absRefPath).text();
    } catch {
      throw new WorkflowError(`Sub-workflow file not found: ${absRefPath}`, WorkflowErrorCode.SUB_WORKFLOW_ERROR, {
        node_id: node.id,
        ref: absRefPath,
      });
    }

    // 解析 + 校验
    const parsed = parseWorkflowYaml(source, absRefPath);
    const validation = validateDAG(parsed);
    if (!validation.valid) {
      const issues = validation.issues
        .filter((i) => i.type === "error")
        .map((i) => i.message)
        .join("; ");
      throw new WorkflowError(`Sub-workflow validation failed: ${issues}`, WorkflowErrorCode.SUB_WORKFLOW_ERROR, {
        node_id: node.id,
        ref: absRefPath,
      });
    }

    const subDef = validation.def;

    // 生成子工作流 run_id
    const subRunId = `${this.parentRunId}_${node.id}_${nanoid(6)}`;

    // 参数传递：resolvedInputs.params 已由 scheduler 模板解析
    const subParams = (ctx.resolvedInputs.params as Record<string, unknown>) ?? wfNode.params ?? {};

    // 发射 sub_workflow.started 事件
    await this.emitEvent(ctx, "sub_workflow.started", node, {
      sub_run_id: subRunId,
      ref: absRefPath,
    });

    // 创建子工作流的 CancellationManager（组合父级 signal）
    const subCancellation = new CancellationManager();
    const abortController = new AbortController();

    const onParentAbort = () => {
      subCancellation.cancel();
      abortController.abort();
    };
    if (ctx.signal.aborted) {
      onParentAbort();
    } else {
      ctx.signal.addEventListener("abort", onParentAbort, { once: true });
    }

    try {
      // 创建 SchedulerContext 并执行子工作流
      const scheduler = new DAGScheduler({
        runId: subRunId,
        workflowDef: subDef,
        storage: ctx.storage,
        params: subParams,
        secrets: ctx.secrets,
        nodeExecutor: this.registry,
        cancellation: subCancellation,
      });

      const result = await scheduler.run();

      // 获取子工作流最后一个节点的输出（按拓扑序取最后一个节点）
      const lastNodeId = this.getLastNodeId(subDef);
      const lastOutput = lastNodeId ? await ctx.storage.getOutput(subRunId, lastNodeId) : null;

      if (result.status === "SUCCESS") {
        // 子工作流成功
        await this.emitEvent(ctx, "sub_workflow.completed", node, {
          sub_run_id: subRunId,
          outputs: lastOutput,
        });

        return (
          lastOutput ?? {
            stdout: "",
            exit_code: 0,
          }
        );
      }

      if (result.status === "SUSPENDED") {
        // 传播 SUSPENDED 状态
        await this.emitEvent(ctx, "sub_workflow.completed", node, {
          sub_run_id: subRunId,
          status: "SUSPENDED",
        });
        throw new WorkflowError("Sub-workflow suspended", WorkflowErrorCode.RECOVERY_ERROR, {
          node_id: node.id,
          sub_run_id: subRunId,
        });
      }

      if (result.status === "CANCELLED") {
        // 传播 CANCELLED 状态
        throw new WorkflowError("Sub-workflow cancelled", WorkflowErrorCode.DAG_CANCELLED, {
          node_id: node.id,
          sub_run_id: subRunId,
        });
      }

      // 子工作流失败
      if (wfNode.ignore_errors) {
        // ignore_errors: 父节点仍然 COMPLETED
        await this.emitEvent(ctx, "sub_workflow.completed", node, {
          sub_run_id: subRunId,
          status: "FAILED",
          ignore_errors: true,
          outputs: lastOutput,
        });

        return {
          stdout: lastOutput?.stdout ?? "",
          exit_code: 0,
          json: { _sub_workflow_failed: true, _sub_run_id: subRunId },
        };
      }

      // 默认：传播失败
      await this.emitEvent(ctx, "sub_workflow.completed", node, {
        sub_run_id: subRunId,
        status: "FAILED",
      });

      throw new WorkflowError(
        `Sub-workflow failed with status: ${result.status}`,
        WorkflowErrorCode.SUB_WORKFLOW_ERROR,
        { node_id: node.id, sub_run_id: subRunId },
      );
    } finally {
      ctx.signal.removeEventListener("abort", onParentAbort);
    }
  }

  // ---------- 私有方法 ----------

  /** 获取子工作流最后一个节点的 ID（按拓扑序） */
  private getLastNodeId(def: WorkflowDef): string | null {
    if (def.nodes.length === 0) return null;
    // 简单策略：拓扑序最后一个节点
    // 无依赖的节点排前面，有依赖的排后面
    const withDeps = def.nodes.filter((n) => n.depends_on && n.depends_on.length > 0);
    const withoutDeps = def.nodes.filter((n) => !n.depends_on || n.depends_on.length === 0);
    // 取有依赖的最后一个（叶子节点）
    if (withDeps.length > 0) return withDeps[withDeps.length - 1].id;
    return withoutDeps[withoutDeps.length - 1]?.id ?? null;
  }

  /** 发射事件到 storage */
  private async emitEvent(
    ctx: NodeExecutionContext,
    type: import("../types/execution").EventType,
    node: NodeDef,
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
