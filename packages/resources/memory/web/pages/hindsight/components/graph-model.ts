/**
 * 记忆图谱的**共用数据形状**与「服务端数据 → 视图数据」的转换。
 *
 * 为什么只抽到这一层：`Graph2d`（Cytoscape.js）与 `Constellation`（自绘 canvas）的**图形逻辑刻意分叉**，
 * 不做归一（已裁定，见前端规范 §4.8）——两者的渲染模型不同，抽公共绘图层只会得到一层薄转发。
 * 真正共用的是「节点/边长什么样」这份数据契约，以及「接口返回怎么变成它」这段转换，
 * 所以这里只有类型与纯函数，没有任何绘制、DOM 或组件状态。
 */

import type { GraphApiData } from "../types";

export interface GraphNode {
  id: string;
  label?: string;
  color?: string;
  size?: number;
  group?: string;
  metadata?: Record<string, unknown>;
}

export interface GraphLink {
  source: string;
  target: string;
  color?: string;
  width?: number;
  type?: string;
  entity?: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

/**
 * 因果族链接类型：接口会给出细分类型（`causes` / `caused_by` / `enables` / `prevents`），
 * 界面把它们当作同一族处理——链路归类、链接配色与 tooltip 文案此前各写一份同样的数组，
 * 收在这里（同一份名单，不是图形逻辑）。
 */
export const CAUSAL_LINK_TYPES = ["causes", "caused_by", "enables", "prevents"] as const;

export function isCausalLinkType(type: string | undefined): boolean {
  return type !== undefined && (CAUSAL_LINK_TYPES as readonly string[]).includes(type);
}

/**
 * 转换入参：`nodes` / `edges` 直接取 `types.ts` 的 `GraphApiData`（此前在这里逐字重抄了 11 行同样的
 * 字段表，与共享类型各改各的），只把 `table_rows` 收窄成转换真正读到的字段——API 的
 * `entities` 是 `string | string[]` 而这里只当纯文本用，收窄后调用方仍需显式断言。
 */
type HindsightGraphSource = Pick<GraphApiData, "nodes" | "edges"> & {
  table_rows?: Array<{ id: string; text: string; entities?: string; context?: string }>;
};

export function convertHindsightGraphData(hindsightData: HindsightGraphSource): GraphData {
  const nodes: GraphNode[] = (hindsightData.nodes || []).map((n) => {
    const tableRow = hindsightData.table_rows?.find((r) => r.id === n.data.id);
    // Use memory text as label, truncated to ~40 chars
    let label = n.data.label;
    if (!label && tableRow?.text) {
      label = tableRow.text.length > 40 ? `${tableRow.text.substring(0, 40)}...` : tableRow.text;
    }
    if (!label) {
      label = n.data.id.substring(0, 8);
    }
    return {
      id: n.data.id,
      label,
      color: n.data.color,
      metadata: tableRow,
    };
  });

  const links: GraphLink[] = (hindsightData.edges || []).map((e) => ({
    source: e.data.source,
    target: e.data.target,
    color: e.data.color,
    // Use linkType directly from API, fallback to lineStyle check, default to semantic
    type: e.data.linkType || (e.data.lineStyle === "dashed" ? "temporal" : "semantic"),
    entity: e.data.entityName, // API returns entityName
    weight: e.data.weight ?? e.data.similarity,
  }));

  return { nodes, links };
}
