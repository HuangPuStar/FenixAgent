/**
 * `Graph2d`（Cytoscape.js）的纯整形：限量、cytoscape 元素表、初始化签名。
 *
 * 与 `use-cytoscape-graph.ts` 的分工：这里全是普通对象的入出（可单独核对接线、无 DOM、无副作用），
 * hook 那边才是容器挂载、cy 实例生命周期与事件。共用数据形状与 API 转换见 `graph-model.ts`。
 * 图形逻辑与 `Constellation` 刻意分叉（见前端规范 §4.8），此处不试图与自绘那套统一。
 */

import type cytoscape from "cytoscape";
import type { GraphData, GraphLink, GraphNode } from "./graph-model";

// Brand colors
const BRAND_PRIMARY = "#0074d9";
const LINK_SEMANTIC = "#0074d9"; // Primary blue for semantic

const DEFAULT_NODE_COLOR = BRAND_PRIMARY;
const DEFAULT_LINK_COLOR = LINK_SEMANTIC;
const DEFAULT_LINK_WIDTH = 1;

/**
 * 只限制节点，节点之间可见的连边全部保留（迁移前的口径，逐字保留）：
 * 裁掉一部分节点后若连带删边，图会比数据实际稀疏，反而看不出结构。
 */
export function limitGraphData(data: GraphData, maxNodes?: number): GraphData {
  let nodes = [...data.nodes];

  // Limit nodes if needed
  if (maxNodes && nodes.length > maxNodes) {
    nodes = nodes.slice(0, maxNodes);
  }

  // Show ALL links between visible nodes (no random link limiting)
  const nodeIds = new Set(nodes.map((n) => n.id));
  const links = data.links.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target));

  return { nodes, links };
}

export interface GraphElementOptions {
  nodeColorFn?: (node: GraphNode) => string;
  nodeSizeFn?: (node: GraphNode) => number;
  linkColorFn?: (link: GraphLink) => string;
  linkWidthFn?: (link: GraphLink) => number;
}

/**
 * 视图数据 → cytoscape 元素表。节点默认按连边数分级尺寸（16–40px），
 * 边把 `type` / `entity` / `weight` 一并带上，供 tooltip 读取；`originalNode` / `originalLink`
 * 留一份原对象引用，点击与悬停回调要把它交回调用方。
 */
export function buildCytoscapeElements(graph: GraphData, options: GraphElementOptions): cytoscape.ElementDefinition[] {
  // Calculate node importance based on connections
  const nodeConnections = new Map<string, number>();
  graph.links.forEach((link) => {
    nodeConnections.set(link.source, (nodeConnections.get(link.source) || 0) + 1);
    nodeConnections.set(link.target, (nodeConnections.get(link.target) || 0) + 1);
  });

  const nodes = graph.nodes.map((node) => {
    const connections = nodeConnections.get(node.id) || 0;
    const dynamicSize = options.nodeSizeFn
      ? options.nodeSizeFn(node)
      : Math.max(16, Math.min(40, 16 + connections * 4)); // Smaller, more subtle sizing

    return {
      data: {
        id: node.id,
        label: node.label || node.id.substring(0, 8),
        color: options.nodeColorFn ? options.nodeColorFn(node) : node.color || DEFAULT_NODE_COLOR,
        size: node.size || dynamicSize,
        originalNode: node,
        connections: connections,
      },
    };
  });

  const edges = graph.links.map((link, idx) => ({
    data: {
      id: `edge-${idx}`,
      source: link.source,
      target: link.target,
      color: options.linkColorFn ? options.linkColorFn(link) : link.color || DEFAULT_LINK_COLOR,
      width: options.linkWidthFn ? options.linkWidthFn(link) : link.width || DEFAULT_LINK_WIDTH,
      type: link.type,
      entity: link.entity,
      weight: link.weight,
      originalLink: link,
    },
  }));

  return [...nodes, ...edges];
}

/** 元素表里的节点/边计数：初始化时用它判断「这份数据是否已经画过」，口径与上面的构造绑在一起。 */
export function countCytoscapeElements(elements: cytoscape.ElementDefinition[]): { nodes: number; edges: number } {
  const isEdge = (element: cytoscape.ElementDefinition) => "source" in (element.data as Record<string, unknown>);
  return {
    nodes: elements.filter((element) => !isEdge(element)).length,
    edges: elements.filter(isEdge).length,
  };
}

export interface GraphSignatureOptions {
  showLabels: boolean;
  isDarkMode: boolean;
  maxNodes?: number;
}

/**
 * 初始化签名：数据规模 + 节点 id 集 + 会影响首帧绘制的外观入参（标签开关、暗色、限量）。
 * 初始化 effect 用它跳过重复初始化，所以**凡是改变首帧外观的入参都必须进签名**——
 * 少一项就会出现「切了主题但图不重画」。
 * 节点与边分开传入（而不是整个 `GraphData`）：调用方的 `useMemo` 依赖就是这两个字段，
 * 传对象会让依赖表与实际读取对不上。
 */
export function graphDataSignature(nodes: GraphNode[], links: GraphLink[], options: GraphSignatureOptions): string {
  return JSON.stringify({
    nodeCount: nodes.length,
    linkCount: links.length,
    nodeIds: nodes
      .map((n) => n.id)
      .sort()
      .join(","),
    showLabels: options.showLabels,
    isDarkMode: options.isDarkMode,
    maxNodes: options.maxNodes,
  });
}
