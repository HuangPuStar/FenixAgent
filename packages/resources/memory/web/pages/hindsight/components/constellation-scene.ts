/**
 * `Constellation`（自绘 canvas）的纯模型：星点布局、热度色带、连线索引与绘制用的视觉常量。
 *
 * 拆开的理由：这份「数据 → 可绘制的场景」的准备工作与 canvas 的逐帧绘制、鼠标交互是两件事——
 * 前者输入输出都是普通对象（可单独核对位置与配色口径），后者要挂 canvas 上下文、动画帧与事件。
 * 绘制层（`constellation-paint.ts` / `constellation-labels.ts` / `constellation-legend.ts`）从这里取
 * 字体、配色与场景；图形逻辑不与 `Graph2d`（Cytoscape.js）归一——两套渲染模型不同，
 * 抽公共层只会得到一层薄转发（已裁定，见前端规范 §4.8）。
 */

import { prepare, prepareWithSegments } from "@chenglou/pretext";
import type { GraphData, GraphLink, GraphNode } from "./graph-model";

// ============================================================================
// Types
// ============================================================================

export interface PreparedNode {
  node: GraphNode;
  /** screen x (world coords, before pan/zoom) */
  wx: number;
  wy: number;
  prepared: ReturnType<typeof prepareWithSegments>;
  preparedHeight: ReturnType<typeof prepare>;
  color: string;
  /** Color derived from link count (heat gradient) */
  heatColor: string;
  linkCount: number;
}

/** 连线按节点下标存的两份索引：`a`/`b` 是世界坐标下的两个端点。 */
export interface ConstellationLink {
  a: number;
  b: number;
  color: string;
  type: string;
}

export interface ConstellationScene {
  preparedNodes: PreparedNode[];
  /** 每个节点参与的连线下标（悬停时只画它自己的连线）。 */
  linksByNode: Map<number, number[]>;
  linksWithIndices: ConstellationLink[];
}

// ============================================================================
// Helpers
// ============================================================================

function _hexToRgba(hex: string, alpha: number): string {
  // Handle non-hex formats
  if (!hex.startsWith("#")) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Map a 0..1 value to a perceptually monotonic cool→warm ramp.
 * 0 = cool blue (low / older / few links), 1 = warm orange-red (high / newer / many).
 * Mid passes through a desaturated lavender so brightness stays roughly monotonic
 * — viewers should read the position on the bar at a glance without consulting
 * the legend.
 */
export function heatColor(t: number): string {
  const v = Math.max(0, Math.min(1, t));
  const stops = [
    [56, 130, 220], // cool blue
    [170, 130, 200], // muted lavender bridge
    [240, 100, 60], // warm orange-red
  ];
  const seg = v * (stops.length - 1);
  const i = Math.min(Math.floor(seg), stops.length - 2);
  const frac = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
  return `rgb(${r},${g},${bl})`;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

// ============================================================================
// Constants
// ============================================================================

const _FONT = '12px Inter, -apple-system, "Segoe UI", sans-serif';
export const FONT_SMALL = '11px Inter, -apple-system, "Segoe UI", sans-serif';
export const FONT_BOLD = '600 10px Inter, -apple-system, "Segoe UI", sans-serif';
export const MONO = '11px "SF Mono", "Fira Code", Consolas, monospace';

export const LINK_TYPE_COLORS: Record<string, string> = {
  semantic: "#0074d9",
  temporal: "#009296",
  entity: "#f59e0b",
  causal: "#8b5cf6",
};

const DEFAULT_NODE_COLOR = "#0074d9";

// ============================================================================
// Scene
// ============================================================================

export interface ConstellationSceneOptions {
  nodeColorFn?: (node: GraphNode) => string;
  linkColorFn?: (link: GraphLink) => string;
  nodeHeatFn?: (node: GraphNode) => number;
}

/**
 * 准备场景：为每个节点定世界坐标（按 id 哈希确定性散布在环上，刷新不跳位）、
 * 用 Pretext 预排版标签，并把连线折算成节点下标索引。
 * 热度默认取归一化后的连边数（平方根压一下，避免一片全红），`nodeHeatFn` 可换成别的维度（如近期度）。
 */
export function prepareConstellationScene(data: GraphData, options: ConstellationSceneOptions): ConstellationScene {
  const { nodeColorFn, linkColorFn, nodeHeatFn } = options;
  if (!data.nodes.length) return { preparedNodes: [], linksByNode: new Map(), linksWithIndices: [] };

  const nodeIndexMap = new Map<string, number>();
  data.nodes.forEach((n, i) => {
    nodeIndexMap.set(n.id, i);
  });

  // Count links per node
  const linkCounts = new Map<string, number>();
  for (const link of data.links) {
    linkCounts.set(link.source, (linkCounts.get(link.source) || 0) + 1);
    linkCounts.set(link.target, (linkCounts.get(link.target) || 0) + 1);
  }

  // Find max link count for heat gradient normalization
  let maxLinkCount = 1;
  for (const lc of linkCounts.values()) {
    if (lc > maxLinkCount) maxLinkCount = lc;
  }

  // Prepare nodes: assign world positions + pretext-prepare text
  const nodes: PreparedNode[] = data.nodes.map((node, i) => {
    const text = node.label || node.id.substring(0, 12);
    const color = nodeColorFn?.(node) || node.color || DEFAULT_NODE_COLOR;
    const lc = linkCounts.get(node.id) || 0;
    // Use sqrt for a less aggressive curve — avoids everything being red
    const heat = nodeHeatFn
      ? heatColor(Math.max(0, Math.min(1, nodeHeatFn(node))))
      : heatColor(Math.sqrt(lc / maxLinkCount));

    // Position: use hash of id for deterministic placement, spread in a ring
    const seed = hashStr(node.id);
    const count = data.nodes.length;
    const angle = (i / count) * Math.PI * 2 + ((seed % 100) / 100) * 0.5;
    const baseRadius = Math.sqrt(count) * 30;
    const radius = baseRadius * 0.3 + ((Math.abs(seed) % 1000) / 1000) * baseRadius * 0.7;
    const wx = Math.cos(angle) * radius + ((seed % 200) - 100) * 0.5;
    const wy = Math.sin(angle) * radius + (((seed >> 8) % 200) - 100) * 0.5;

    return {
      node,
      wx,
      wy,
      prepared: prepareWithSegments(text, FONT_SMALL),
      preparedHeight: prepare(text, FONT_SMALL),
      color,
      heatColor: heat,
      linkCount: lc,
    };
  });

  // Build link structures
  const linksIdx: ConstellationLink[] = [];
  const byNode = new Map<number, number[]>();

  for (let li = 0; li < data.links.length; li++) {
    const link = data.links[li];
    const ai = nodeIndexMap.get(link.source);
    const bi = nodeIndexMap.get(link.target);
    if (ai === undefined || bi === undefined) continue;

    const color = linkColorFn?.(link) || link.color || LINK_TYPE_COLORS[link.type || "semantic"] || DEFAULT_NODE_COLOR;

    const idx = linksIdx.length;
    linksIdx.push({ a: ai, b: bi, color, type: link.type || "semantic" });

    if (!byNode.has(ai)) byNode.set(ai, []);
    if (!byNode.has(bi)) byNode.set(bi, []);
    byNode.get(ai)!.push(idx);
    byNode.get(bi)!.push(idx);
  }

  return {
    preparedNodes: nodes,
    linksByNode: byNode,
    linksWithIndices: linksIdx,
  };
}
