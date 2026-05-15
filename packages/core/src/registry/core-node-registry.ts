import {
  createCoreRuntimeError,
} from "../errors/core-runtime-error";
import type {
  CoreNode,
  CoreNodeStatus,
  CreateCoreNodeInput,
} from "../types/core-node";

/**
 * Core node 注册表的只读访问面。
 */
export interface ReadonlyCoreNodeRegistry {
  /** 按 node ID 查询 node；不存在时返回 `null`。 */
  get(nodeId: string): CoreNode | null;
  /** 按 node ID 查询 node；不存在时抛出具名错误。 */
  require(nodeId: string): CoreNode;
  /** 返回全部 node 的副本列表。 */
  list(): CoreNode[];
  /** 更新指定 node 的在线状态。 */
  setStatus(nodeId: string, status: CoreNodeStatus): CoreNode;
  /** 判断指定 node 是否声明支持某个 engine。 */
  supportsEngine(nodeId: string, engineType: string): boolean;
}

/**
 * 复制 node 记录，避免把内部可变对象直接暴露出去。
 */
function cloneNode(node: CoreNode): CoreNode {
  return {
    ...node,
    engineTypes: [...node.engineTypes],
    metadata: node.metadata ? { ...node.metadata } : undefined,
  };
}

/**
 * 维护 core 侧可调度 node 的能力与在线状态。
 */
export class CoreNodeRegistry implements ReadonlyCoreNodeRegistry {
  private readonly nodes = new Map<string, CoreNode>();

  /**
   * 注册一个新的 core node。
   */
  register(input: CreateCoreNodeInput): CoreNode {
    if (this.nodes.has(input.id)) {
      throw createCoreRuntimeError(
        "DUPLICATE_CORE_NODE",
        `Core node already registered: ${input.id}`,
        { nodeId: input.id },
      );
    }

    const node: CoreNode = {
      id: input.id,
      mode: input.mode,
      engineTypes: [...new Set(input.engineTypes)],
      status: input.status,
      metadata: input.metadata ? { ...input.metadata } : undefined,
    };

    this.nodes.set(node.id, node);
    return cloneNode(node);
  }

  /**
   * 查询指定 node。
   */
  get(nodeId: string): CoreNode | null {
    const node = this.nodes.get(nodeId);
    return node ? cloneNode(node) : null;
  }

  /**
   * 查询指定 node，不存在则抛错。
   */
  require(nodeId: string): CoreNode {
    const node = this.get(nodeId);

    if (!node) {
      throw createCoreRuntimeError("NODE_NOT_FOUND", `Core node not found: ${nodeId}`, {
        nodeId,
      });
    }

    return node;
  }

  /**
   * 返回所有 node 的副本列表。
   */
  list(): CoreNode[] {
    return [...this.nodes.values()].map(cloneNode);
  }

  /**
   * 更新 node 在线状态。
   */
  setStatus(nodeId: string, status: CoreNodeStatus): CoreNode {
    const current = this.require(nodeId);
    const nextNode: CoreNode = {
      ...current,
      status,
      engineTypes: [...current.engineTypes],
      metadata: current.metadata ? { ...current.metadata } : undefined,
    };

    this.nodes.set(nodeId, nextNode);
    return cloneNode(nextNode);
  }

  /**
   * 判断 node 是否声明支持给定 engine。
   */
  supportsEngine(nodeId: string, engineType: string): boolean {
    const node = this.require(nodeId);
    return node.engineTypes.includes(engineType);
  }
}
