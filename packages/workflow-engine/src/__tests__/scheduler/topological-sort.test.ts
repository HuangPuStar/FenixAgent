import { describe, expect, test } from 'bun:test';
import {
  buildReverseAdjacency,
  identifyParallelGroups,
  topologicalSort,
} from '../../scheduler/topological-sort';
import { WorkflowError, WorkflowErrorCode } from '../../types/errors';
import type { NodeDef, ShellNodeDef } from '../../types/dag';

// 辅助：创建简单的 shell 节点
function shellNode(id: string, dependsOn?: string[]): ShellNodeDef {
  return { id, type: 'shell', command: `echo ${id}`, depends_on: dependsOn };
}

// ---------- topologicalSort ----------

// 线性 DAG：A → B → C
test('线性 DAG 按依赖顺序排序', () => {
  const nodes: NodeDef[] = [
    shellNode('C', ['B']),
    shellNode('A'),
    shellNode('B', ['A']),
  ];
  const order = topologicalSort(nodes);
  expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
  expect(order.indexOf('B')).toBeLessThan(order.indexOf('C'));
});

// 扇出 DAG：A → [B, C] → D
test('扇出 DAG A 在 B/C 之前，B/C 在 D 之前', () => {
  const nodes: NodeDef[] = [
    shellNode('D', ['B', 'C']),
    shellNode('B', ['A']),
    shellNode('A'),
    shellNode('C', ['A']),
  ];
  const order = topologicalSort(nodes);
  expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
  expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'));
  expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
  expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
});

// 复杂 DAG
test('复杂 DAG 保持正确依赖顺序', () => {
  // A → B → D
  // A → C → D
  // E (独立)
  const nodes: NodeDef[] = [
    shellNode('D', ['B', 'C']),
    shellNode('B', ['A']),
    shellNode('C', ['A']),
    shellNode('A'),
    shellNode('E'),
  ];
  const order = topologicalSort(nodes);
  expect(order).toHaveLength(5);
  // A 在 B/C 之前
  expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
  expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'));
  // B/C 在 D 之前
  expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
  expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
});

// 空数组
test('空节点数组返回空', () => {
  expect(topologicalSort([])).toEqual([]);
});

// 单节点
test('单节点返回自身', () => {
  const nodes: NodeDef[] = [shellNode('A')];
  expect(topologicalSort(nodes)).toEqual(['A']);
});

// 环检测
test('环检测抛出 WorkflowError', () => {
  const nodes: NodeDef[] = [
    shellNode('A', ['B']),
    shellNode('B', ['C']),
    shellNode('C', ['A']),
  ];
  expect(() => topologicalSort(nodes)).toThrow(WorkflowError);
  expect(() => topologicalSort(nodes)).toThrow(/Cycle detected/);
});

// 自环
test('自环检测', () => {
  const nodes: NodeDef[] = [
    shellNode('A', ['A']),
  ];
  expect(() => topologicalSort(nodes)).toThrow(WorkflowError);
});

// 未知依赖
test('依赖不存在的节点抛出错误', () => {
  const nodes: NodeDef[] = [
    shellNode('A', ['Z']),
  ];
  expect(() => topologicalSort(nodes)).toThrow(WorkflowError);
  expect(() => topologicalSort(nodes)).toThrow(/unknown node/);
});

// 重复 ID 不报错（由 validator 处理）
test('包含多个无依赖节点时均返回', () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B'),
    shellNode('C'),
  ];
  const order = topologicalSort(nodes);
  expect(order).toHaveLength(3);
  expect(order).toContain('A');
  expect(order).toContain('B');
  expect(order).toContain('C');
});

// ---------- identifyParallelGroups ----------

// 线性 DAG 每层只有一个节点
test('线性 DAG 每组只有一个节点', () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['B']),
  ];
  const groups = identifyParallelGroups(nodes);
  expect(groups).toHaveLength(3);
  expect(groups[0]).toEqual(['A']);
  expect(groups[1]).toEqual(['B']);
  expect(groups[2]).toEqual(['C']);
});

// 扇出 DAG B 和 C 在同一并行组
test('扇出 DAG B 和 C 在同一并行组', () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['A']),
    shellNode('D', ['B', 'C']),
  ];
  const groups = identifyParallelGroups(nodes);
  expect(groups).toHaveLength(3);
  expect(groups[0]).toContain('A');
  // B 和 C 应在同一组
  expect(groups[1]).toContain('B');
  expect(groups[1]).toContain('C');
  expect(groups[1]).toHaveLength(2);
  expect(groups[2]).toContain('D');
});

// 独立节点和依赖节点分在不同组
test('独立节点和依赖节点分在不同组', () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C'), // 独立
  ];
  const groups = identifyParallelGroups(nodes);
  // 第一组包含 A 和 C（都无依赖）
  expect(groups[0]).toContain('A');
  expect(groups[0]).toContain('C');
  // 第二组包含 B
  expect(groups[1]).toContain('B');
});

// 菱形 DAG
test('菱形 DAG 正确分组', () => {
  // A → B → D
  // A → C → D
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['A']),
    shellNode('D', ['B', 'C']),
  ];
  const groups = identifyParallelGroups(nodes);
  expect(groups).toHaveLength(3);
  expect(groups[0]).toEqual(['A']);
  expect(groups[1]).toHaveLength(2);
  expect(groups[1]).toContain('B');
  expect(groups[1]).toContain('C');
  expect(groups[2]).toEqual(['D']);
});

// 环检测
test('identifyParallelGroups 环检测', () => {
  const nodes: NodeDef[] = [
    shellNode('A', ['B']),
    shellNode('B', ['A']),
  ];
  expect(() => identifyParallelGroups(nodes)).toThrow(WorkflowError);
});

// ---------- buildReverseAdjacency ----------

// 扇出 DAG 的反向邻接
test('扇出 DAG 反向邻接表正确', () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['A']),
    shellNode('D', ['B', 'C']),
  ];
  const adj = buildReverseAdjacency(nodes);

  // A 的下游是 B 和 C
  expect(adj.get('A')!.sort()).toEqual(['B', 'C']);
  // B 的下游是 D
  expect(adj.get('B')).toEqual(['D']);
  // C 的下游是 D
  expect(adj.get('C')).toEqual(['D']);
  // D 无下游
  expect(adj.get('D')).toEqual([]);
});

// 线性 DAG 的反向邻接
test('线性 DAG 反向邻接表正确', () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B', ['A']),
    shellNode('C', ['B']),
  ];
  const adj = buildReverseAdjacency(nodes);

  expect(adj.get('A')).toEqual(['B']);
  expect(adj.get('B')).toEqual(['C']);
  expect(adj.get('C')).toEqual([]);
});

// 独立节点
test('独立节点反向邻接表为空', () => {
  const nodes: NodeDef[] = [
    shellNode('A'),
    shellNode('B'),
  ];
  const adj = buildReverseAdjacency(nodes);
  expect(adj.get('A')).toEqual([]);
  expect(adj.get('B')).toEqual([]);
});

// 空数组
test('空节点返回空 Map', () => {
  const adj = buildReverseAdjacency([]);
  expect(adj.size).toBe(0);
});
