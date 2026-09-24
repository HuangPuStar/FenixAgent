/**
 * `DataView` 的纯模型：视图概念的类型、链接归类与统计，以及「表格行 → 可绘制派生数据」的几段扫描。
 *
 * 拆开的理由：这些函数只吃接口数据、吐普通对象，与取数（`use-data-view-data.ts`）和渲染
 * （`data-view-table.tsx` / `data-view-timeline.tsx` / `data-view-control-panel.tsx`）都不耦合；
 * 分开之后「观察类型的节点尺寸怎么分级」「近期度怎么归一」可以单独核对，不必穿过组件的渲染分支。
 */

import { type RecencyLookup, toRecencyLookup } from "../recency";
import type { MemoryTableRow } from "../types";
import { type GraphLink, isCausalLinkType } from "./graph-model";

export type FactType = "world" | "experience" | "observation";
export type ViewMode = "graph" | "table" | "timeline" | "constellation";
/** 近期颜色的时间基准：同一条记忆可以按发生开始 / 发生结束 / 被提及的时间着色。 */
export type RecencyBasis = "mentioned_at" | "occurred_start" | "occurred_end";

/** 链接类型归一化：接口的细分类型落到四类里，未知类型按 semantic 处理（与图谱的归类同一口径）。 */
export function getLinkTypeCategory(type: string | undefined): string {
  if (!type) return "semantic";
  if (type === "semantic" || type === "temporal" || type === "entity") return type;
  if (isCausalLinkType(type)) return "causal";
  return "semantic";
}

export interface LinkStats {
  semantic: number;
  temporal: number;
  entity: number;
  causal: number;
  total: number;
  otherTypes: Record<string, number>;
}

/** 链接统计：面板上四个开关各取一个数（`total` 与 `otherTypes` 供排查未归类类型时用）。 */
export function computeLinkStats(links: GraphLink[]): LinkStats {
  let semantic = 0,
    temporal = 0,
    entity = 0,
    causal = 0,
    total = 0;
  const otherTypes: Record<string, number> = {};
  links.forEach((l) => {
    total++;
    const type = l.type || "unknown";
    if (type === "semantic") semantic++;
    else if (type === "temporal") temporal++;
    else if (type === "entity") entity++;
    else if (isCausalLinkType(type)) causal++;
    else {
      otherTypes[type] = (otherTypes[type] || 0) + 1;
    }
  });
  return { semantic, temporal, entity, causal, total, otherTypes };
}

export interface ObservationSizeLookup {
  counts: Map<string, number>;
  max: number;
}

/**
 * 观察类型专用：按 `proof_count`（支撑这条观察的记忆条数）给节点尺寸分级。
 * 其它视角返回 `null` —— 尺寸此时该由连边数决定（见 `Constellation` 的 `nodeSizeFn` 缺省语义）。
 */
export function buildObservationSizeLookup(
  factType: FactType,
  rows: MemoryTableRow[] | undefined,
): ObservationSizeLookup | null {
  if (factType !== "observation" || !rows) return null;
  const counts = new Map<string, number>();
  let max = 1;
  for (const row of rows as Array<{ id: string; proof_count?: number | null }>) {
    const c = row.proof_count ?? 1;
    counts.set(row.id, c);
    if (c > max) max = c;
  }
  return { counts, max };
}

/**
 * 近期热度查表：按选定的时间基准扫一遍表格行，取时间戳的范围。
 * 「没有可用范围就返回 `null`」的口径在 `recency.ts` 的 `toRecencyLookup` 里（与实体视图共用）。
 */
export function buildRecencyLookup(rows: MemoryTableRow[], recencyBasis: RecencyBasis): RecencyLookup | null {
  if (!rows.length) return null;
  type Row = {
    id: string;
    mentioned_at?: string | null;
    occurred_start?: string | null;
    occurred_end?: string | null;
  };
  const times = new Map<string, number>();
  let minT = Infinity;
  let maxT = -Infinity;
  for (const row of rows as Row[]) {
    const ts = row[recencyBasis];
    if (!ts) continue;
    const tt = Date.parse(ts);
    if (Number.isNaN(tt)) continue;
    times.set(row.id, tt);
    if (tt < minT) minT = tt;
    if (tt > maxT) maxT = tt;
  }
  return toRecencyLookup(times, minT, maxT);
}
