/**
 * 拓扑排序与 DAG 结构分析工具。
 *
 * 基于 Kahn's algorithm 实现拓扑排序，BFS 层级遍历识别可并行节点组，
 * 并构建反向邻接表用于错误传播。
 */

import { WorkflowError, WorkflowErrorCode } from '../types/errors';
import type { NodeDef } from '../types/dag';

/**
 * 拓扑排序 — 返回按依赖层级排列的节点 ID 数组。
 * 使用 Kahn's algorithm，入度为零的节点优先出队。
 *
 * @throws WorkflowError(CYCLE_DETECTED) 当 DAG 中存在环时
 */
export function topologicalSort(nodes: NodeDef[]): string[] {
  const idSet = new Set(nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // 初始化
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  // 构建邻接表和入度
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!idSet.has(dep)) {
        throw new WorkflowError(
          `Node '${node.id}' depends on unknown node '${dep}'`,
          WorkflowErrorCode.MISSING_DEPENDENCY,
        );
      }
      adjacency.get(dep)!.push(node.id);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  // 入度为零的节点入队
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const neighbor of adjacency.get(id) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (result.length !== nodes.length) {
    throw new WorkflowError('Cycle detected in DAG', WorkflowErrorCode.CYCLE_DETECTED);
  }

  return result;
}

/**
 * 识别可并行的节点组 — 返回二维数组，每组内节点可并行执行。
 * 基于 BFS 层级遍历：同一层级的节点（入度在同一轮减至零）可以并行。
 *
 * @throws WorkflowError(CYCLE_DETECTED) 当 DAG 中存在环时
 */
export function identifyParallelGroups(nodes: NodeDef[]): string[][] {
  const idSet = new Set(nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!idSet.has(dep)) {
        throw new WorkflowError(
          `Node '${node.id}' depends on unknown node '${dep}'`,
          WorkflowErrorCode.MISSING_DEPENDENCY,
        );
      }
      adjacency.get(dep)!.push(node.id);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  let currentLevel: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) currentLevel.push(id);
  }

  const groups: string[][] = [];

  while (currentLevel.length > 0) {
    groups.push(currentLevel);
    const nextLevel: string[] = [];
    for (const id of currentLevel) {
      for (const neighbor of adjacency.get(id) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) nextLevel.push(neighbor);
      }
    }
    currentLevel = nextLevel;
  }

  if (groups.flat().length !== nodes.length) {
    throw new WorkflowError('Cycle detected in DAG', WorkflowErrorCode.CYCLE_DETECTED);
  }

  return groups;
}

/**
 * 构建反向邻接表 — key 是节点 ID，value 是依赖它的下游节点。
 * 用于错误传播：节点失败时 BFS 遍历下游节点标记为 SKIPPED。
 */
export function buildReverseAdjacency(nodes: NodeDef[]): Map<string, string[]> {
  const reverseAdj = new Map<string, string[]>();

  for (const node of nodes) {
    reverseAdj.set(node.id, []);
  }

  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!reverseAdj.has(dep)) {
        reverseAdj.set(dep, []);
      }
      reverseAdj.get(dep)!.push(node.id);
    }
  }

  return reverseAdj;
}
