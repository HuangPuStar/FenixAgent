/**
 * 图模型 → 显示行投影（移植自 langfuse-lite 的
 * `shared/components/observation-trace-graph-display-layout.ts`）。
 *
 * 本次移植未改逻辑，只调整 import 路径与注释语言。
 *
 * 为什么要有这一层：模型层按「事件」排列（一节点一行），显示层再按「屏幕空间」重排——连续工具调用与同级
 * 分支可以合并成一行多列，于是行高、行坐标与连线的起止行都要重算。分层让布局与渲染各自可独立测试。
 */
import type { TraceGraphEdge, TraceGraphModel, TraceGraphNode } from "./trace-graph-layout";

export type TraceGraphDisplayRow = {
  id: string;
  nodes: TraceGraphNode[];
  lane: number;
  top: number;
  height: number;
};

function canGroup(anchor: TraceGraphNode, node: TraceGraphNode): boolean {
  if (anchor.kind === "tool" && node.kind === "tool") {
    return anchor.branchId === node.branchId && anchor.lane === node.lane;
  }
  return anchor.kind === "fork" && node.kind === "fork" && (anchor.parentLane ?? 0) === (node.parentLane ?? 0);
}

function isForkGroup(row: TraceGraphDisplayRow): boolean {
  return row.nodes.length > 1 && row.nodes[0].kind === "fork";
}

/** 合并相邻工具或同级分支 fork；fork 组共享一个发射点。 */
export function buildTraceGraphDisplay(
  model: TraceGraphModel,
  compact: boolean,
  groupColumns = Number.POSITIVE_INFINITY,
) {
  const rows: TraceGraphDisplayRow[] = [];
  const displayIndex: number[] = [];
  for (const node of model.nodes) {
    const previous = rows.at(-1);
    const anchor = previous?.nodes[0];
    if (compact && previous && anchor && canGroup(anchor, node)) {
      previous.nodes.push(node);
    } else {
      rows.push({ id: node.id, nodes: [node], lane: node.lane, top: 0, height: 28 });
    }
    displayIndex.push(rows.length - 1);
  }
  let height = 0;
  for (const row of rows) {
    if (isForkGroup(row)) row.lane = row.nodes[0].parentLane ?? 0;
    if (row.nodes.length > 1) {
      row.height = Math.max(28, Math.ceil(row.nodes.length / Math.max(1, groupColumns)) * 24 + 4);
    }
    row.top = height;
    height += row.height;
  }
  const edges: TraceGraphEdge[] = [];
  for (const edge of model.edges) {
    const sourceRow = rows[displayIndex[edge.from.row]];
    const targetRow = rows[displayIndex[edge.to.row]];
    // 父级连线现在到达的是共享标记；各分支的发射点移到它自己的出边上，从而保留该分支的后台模式。
    if (edge.kind === "fork" && isForkGroup(targetRow)) continue;
    const launchedBranch = isForkGroup(sourceRow)
      ? sourceRow.nodes.find((node) => node.lane === edge.from.lane)
      : undefined;
    const from = { ...edge.from, row: displayIndex[edge.from.row] };
    const to = { ...edge.to, row: displayIndex[edge.to.row] };
    if (launchedBranch) from.lane = sourceRow.lane;
    // 组内的顺序关系由组内卡片从左到右表达，不再画线。
    if (from.row === to.row && from.lane === to.lane) continue;
    edges.push({
      ...edge,
      from,
      to,
      ...(launchedBranch && edge.kind === "sequence" ? { kind: "fork", background: launchedBranch.background } : {}),
    });
  }
  return { rows, edges, height };
}
