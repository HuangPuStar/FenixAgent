/**
 * 节点执行器注册表 — 按节点类型分发到对应执行器。
 *
 * 实现 NodeExecutor 接口，内部维护 nodeType → NodeExecutor 的映射。
 * 调用 execute() 时根据 node.type 查找执行器，未注册则抛 WorkflowError。
 */

import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import type { NodeDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";

/** 按节点类型分发到对应执行器的注册表 */
export class NodeExecutorRegistry implements NodeExecutor {
  private readonly executors: Map<string, NodeExecutor> = new Map();

  /** 注册指定节点类型的执行器 */
  register(nodeType: string, executor: NodeExecutor): void {
    this.executors.set(nodeType, executor);
  }

  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<import("../types/execution").NodeOutput> {
    const executor = this.executors.get(node.type);
    if (!executor) {
      throw new WorkflowError(`No executor registered for node type '${node.type}'`, WorkflowErrorCode.NODE_FAILED, {
        node_id: node.id,
        node_type: node.type,
      });
    }
    return executor.execute(node, ctx);
  }
}

/** 创建节点执行器注册表 */
export function createNodeExecutorRegistry(): NodeExecutorRegistry {
  return new NodeExecutorRegistry();
}
