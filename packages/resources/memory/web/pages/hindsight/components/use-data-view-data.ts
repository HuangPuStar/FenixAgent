/**
 * `DataView` 的编排层：图谱取数、观察类型的整合状态取数，以及由它们派生出的可绘制数据。
 *
 * 取数一律走 `useRequest`（§3.4）：失败由调用方用 `error` 派生成可见失败块（文案要 `t`），
 * 重试复用 `refresh`。两条口径照抄改造后的现状，不得回退：
 *   ① 图谱「挂载即拉」——`factType` / 检索词的变化由父级 `key`（`MemoriesPage` 的
 *      `perspective:searchQuery`）触发的重挂载表达，故这里不设 `refreshDeps`；
 *   ② 观察类型的整合状态是**辅助信息**：只有图谱先拿到数据才请求（`ready` 的前置数据语义），
 *      失败只记诊断并隐藏该块，不遮盖已经加载好的图数据。
 *
 * 图谱绘制不在这里：本 hook 只产出 `GraphData` 与过滤结果，两套图谱各自的渲染模型分别在
 * `Constellation.tsx` 与 `Graph2d.tsx`（刻意分叉，见前端规范 §4.8）。
 */

import { useRequest } from "ahooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { hindsightApi } from "../../../api/hindsight";
import type { RecencyLookup } from "../recency";
import { recencyHeat } from "../recency";
import type { GraphApiData, MemoryTableRow } from "../types";
import {
  buildObservationSizeLookup,
  buildRecencyLookup,
  computeLinkStats,
  type FactType,
  getLinkTypeCategory,
  type LinkStats,
  type RecencyBasis,
} from "./data-view-model";
import {
  convertHindsightGraphData,
  type GraphData,
  type GraphLink,
  type GraphNode,
  isCausalLinkType,
} from "./graph-model";

export interface UseDataViewDataOptions {
  factType: FactType;
  documentId?: string;
  chunkId?: string;
  initialQuery?: string;
}

export interface DataViewData {
  /** 图谱接口的原始返回（表格视图与时间线视图直接读它的 `table_rows` / `total_units`）。 */
  data: GraphApiData | undefined;
  loading: boolean;
  /** 原始错误：调用方转成 `toHindsightFailure(error, t(...))`，失败块与重试入口都在渲染层。 */
  error: Error | undefined;
  refresh: () => void;
  /** 表格行（服务端已按视角过滤，这里不再二次过滤）。 */
  tableRows: MemoryTableRow[];
  /** 观察类型的整合状态；未取到或失败时为 `null`（该块整体隐藏）。 */
  consolidationStatus: { pending_consolidation: number; last_consolidated_at: string | null } | null;
  /** 已按可见链接类型过滤的图谱数据（两套图谱共用同一份）。 */
  graphData: GraphData;
  linkStats: LinkStats;
  /** 节点上限（防止大图把布局拖死）；由数据规模一次性定档。 */
  maxNodes: number | undefined;
  recencyBasis: RecencyBasis;
  setRecencyBasis: (basis: RecencyBasis) => void;
  recencyLookup: RecencyLookup | null;
  visibleLinkTypes: Set<string>;
  toggleLinkType: (type: string) => void;
  nodeColorFn: (node: GraphNode) => string;
  linkColorFn: (link: GraphLink) => string;
  recencyHeatFn: (node: GraphNode) => number;
  /** 观察类型的节点尺寸：按 `proof_count` 开方缩放（其余视角该函数不参与绘制）。 */
  observationNodeSizeFn: (node: GraphNode) => number;
}

const ALL_LINK_TYPES = ["semantic", "temporal", "entity", "causal"];

export function useDataViewData({ factType, documentId, chunkId, initialQuery }: UseDataViewDataOptions): DataViewData {
  const [fetchLimit] = useState(1000);
  const [recencyBasis, setRecencyBasis] = useState<RecencyBasis>("mentioned_at");
  const [maxNodes, setMaxNodes] = useState<number | undefined>(undefined);
  const [visibleLinkTypes, setVisibleLinkTypes] = useState<Set<string>>(new Set(ALL_LINK_TYPES));

  /**
   * 图谱取数：挂载即拉。`factType` / 检索词的变化由父级 `key`（`MemoriesPage` 的
   * `perspective:searchQuery`）触发的重挂载表达，故本 hook 不需要 `refreshDeps`；
   * 失败由调用方的失败块渲染，重试入口重新发起同一次请求。
   */
  const {
    data,
    loading,
    error,
    refresh: refreshData,
  } = useRequest(
    () =>
      hindsightApi.getGraph({
        type: factType,
        limit: fetchLimit,
        q: initialQuery || undefined,
        document_id: documentId,
        chunk_id: chunkId,
      }),
    { onError: (err) => console.error("[DataView] loadData failed:", err) },
  );

  // 表格行数据（已由服务端过滤）
  const tableRows = useMemo(() => data?.table_rows ?? [], [data]);

  /**
   * 观察类型的整合状态是辅助信息：图谱拿到数据后才有意义（`ready` 的前置数据语义），
   * 失败只回落 `console.error` 并隐藏该块，不遮盖已经加载好的图数据——与改造前嵌套 `try/catch` 同形。
   */
  const { data: bankStats, error: bankStatsError } = useRequest(() => hindsightApi.getBankStats(), {
    ready: !!data && factType === "observation",
    onError: (err) => console.error("[DataView] getBankStats failed:", err),
  });
  const consolidationStatus =
    bankStats && !bankStatsError
      ? {
          pending_consolidation: bankStats.pending_consolidation ?? 0,
          last_consolidated_at: bankStats.last_consolidated_at ?? null,
        }
      : null;

  // 转换 Graph2D 数据
  const graphData = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    const fullData = convertHindsightGraphData(data as Parameters<typeof convertHindsightGraphData>[0]);

    // 根据可见链接类型过滤
    const links = fullData.links.filter((link) => {
      const category = getLinkTypeCategory(link.type);
      return visibleLinkTypes.has(category);
    });

    return { nodes: fullData.nodes, links };
  }, [data, visibleLinkTypes]);

  // 链接统计
  const linkStats = useMemo(() => computeLinkStats(graphData.links), [graphData]);

  // 颜色和尺寸回调
  const nodeColorFn = useCallback((node: GraphNode) => node.color || "var(--color-primary)", []);

  // 近期热度映射
  const recencyLookup = useMemo(() => buildRecencyLookup(tableRows, recencyBasis), [tableRows, recencyBasis]);

  const recencyHeatFn = useCallback((node: GraphNode) => recencyHeat(recencyLookup, node.id), [recencyLookup]);

  // 观察类型：按 proof_count 调整节点尺寸
  const observationSizeLookup = useMemo(() => buildObservationSizeLookup(factType, data?.table_rows), [factType, data]);

  const observationNodeSizeFn = useCallback(
    (node: GraphNode) => {
      if (!observationSizeLookup) return 3;
      const c = observationSizeLookup.counts.get(node.id) ?? 1;
      return 3 + Math.min(Math.sqrt(c - 1) * 2, 11);
    },
    [observationSizeLookup],
  );

  const linkColorFn = useCallback((link: GraphLink) => {
    if (link.type === "temporal") return "var(--color-cyan)";
    if (link.type === "entity") return "var(--color-status-warning)";
    if (isCausalLinkType(link.type)) {
      return "var(--color-accent-pink)";
    }
    return "var(--color-primary)";
  }, []);

  // 节点数量限制（防止 UI 不稳定）
  useEffect(() => {
    if (data && maxNodes === undefined) {
      if (graphData.nodes.length > 50) {
        setMaxNodes(20);
      } else if (graphData.nodes.length > 20) {
        setMaxNodes(20);
      }
    }
  }, [data, graphData.nodes.length, maxNodes]);

  const toggleLinkType = useCallback((type: string) => {
    setVisibleLinkTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  return {
    data,
    loading,
    error,
    refresh: refreshData,
    tableRows,
    consolidationStatus,
    graphData,
    linkStats,
    maxNodes,
    recencyBasis,
    setRecencyBasis,
    recencyLookup,
    visibleLinkTypes,
    toggleLinkType,
    nodeColorFn,
    linkColorFn,
    recencyHeatFn,
    observationNodeSizeFn,
  };
}
