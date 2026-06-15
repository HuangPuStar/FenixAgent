import {
  Calendar,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  List,
  Network,
  RefreshCw,
  ScatterChart,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { hindsightApi } from "@/src/api/hindsight";
import { NS } from "@/src/i18n";
// 空状态插图
import emptyMemoriesImg from "/images/memories-empty.webp";
import type { BankStats, GraphApiData, MemoryTableRow } from "../types";
import { Constellation } from "./Constellation";
import { convertHindsightGraphData, Graph2D, type GraphNode } from "./Graph2d";
import { MemoryDetailModal } from "./MemoryDetailModal";
import { MemoryDetailPanel } from "./MemoryDetailPanel";

type FactType = "world" | "experience" | "observation";
type ViewMode = "graph" | "table" | "timeline" | "constellation";

interface DataViewProps {
  factType: FactType;
  documentId?: string;
  chunkId?: string;
  compact?: boolean;
  onExpandToggle?: () => void;
}

export function DataView({ factType, documentId, chunkId, compact = false, onExpandToggle }: DataViewProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [viewMode, setViewMode] = useState<ViewMode>("constellation");
  const [compactMode, setCompactMode] = useState(compact);
  const [data, setData] = useState<GraphApiData | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedGraphNode, setSelectedGraphNode] = useState<MemoryTableRow | null>(null);
  const [modalMemoryId, setModalMemoryId] = useState<string | null>(null);
  const itemsPerPage = 100;

  // 获取数量限制
  const [fetchLimit, _setFetchLimit] = useState(1000);

  // Constellation 近期颜色的时间基准
  type RecencyBasis = "mentioned_at" | "occurred_start" | "occurred_end";
  const RECENCY_BASIS_LABEL: Record<RecencyBasis, string> = {
    mentioned_at: t("dataView.recencyBasisMentioned"),
    occurred_start: t("dataView.recencyBasisOccurredStart"),
    occurred_end: t("dataView.recencyBasisOccurredEnd"),
  };
  const [recencyBasis, setRecencyBasis] = useState<RecencyBasis>("mentioned_at");

  // 整合状态（观察类型）
  const [consolidationStatus, setConsolidationStatus] = useState<{
    pending_consolidation: number;
    last_consolidated_at: string | null;
  } | null>(null);

  // 图谱控制状态
  const [showLabels, setShowLabels] = useState(true);
  const [maxNodes, setMaxNodes] = useState<number | undefined>(undefined);
  const [showControlPanel, setShowControlPanel] = useState(true);
  const [visibleLinkTypes, setVisibleLinkTypes] = useState<Set<string>>(
    new Set(["semantic", "temporal", "entity", "causal"]),
  );

  const toggleLinkType = (type: string) => {
    setVisibleLinkTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  // Esc 键取消选中
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedGraphNode) {
        setSelectedGraphNode(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedGraphNode]);

  const loadData = async (limit?: number, q?: string, tags?: string[]) => {
    setLoading(true);
    try {
      const graphData = (await hindsightApi.getGraph({
        type: factType,
        limit: limit ?? fetchLimit,
        q,
        tags,
        document_id: documentId,
        chunk_id: chunkId,
      })) as GraphApiData;
      setData(graphData);

      // 观察类型：获取整合状态
      if (factType === "observation") {
        const stats = (await hindsightApi.getBankStats()) as BankStats;
        setConsolidationStatus({
          pending_consolidation: stats.pending_consolidation || 0,
          last_consolidated_at: stats.last_consolidated_at || null,
        });
      }
    } catch (error) {
      // 调试：打印 loadData 错误以便排查数据加载失败
      console.error("[DataView] loadData failed:", error);
    } finally {
      setLoading(false);
    }
  };

  // 表格行数据（已由服务端过滤）
  const filteredTableRows = useMemo(() => {
    return data?.table_rows ?? [];
  }, [data]);

  // 链接类型归一化
  const getLinkTypeCategory = (type: string | undefined): string => {
    if (!type) return "semantic";
    if (type === "semantic" || type === "temporal" || type === "entity") return type;
    if (["causes", "caused_by", "enables", "prevents"].includes(type)) return "causal";
    return "semantic";
  };

  // 转换 Graph2D 数据
  const graph2DData = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    const fullData = convertHindsightGraphData(data as Parameters<typeof convertHindsightGraphData>[0]);

    // 根据可见链接类型过滤
    const links = fullData.links.filter((link) => {
      const category = getLinkTypeCategory(link.type);
      return visibleLinkTypes.has(category);
    });

    return { nodes: fullData.nodes, links };
  }, [data, visibleLinkTypes, getLinkTypeCategory]);

  // 链接统计
  const linkStats = useMemo(() => {
    let semantic = 0,
      temporal = 0,
      entity = 0,
      causal = 0,
      total = 0;
    const otherTypes: Record<string, number> = {};
    graph2DData.links.forEach((l) => {
      total++;
      const type = l.type || "unknown";
      if (type === "semantic") semantic++;
      else if (type === "temporal") temporal++;
      else if (type === "entity") entity++;
      else if (type === "causes" || type === "caused_by" || type === "enables" || type === "prevents") causal++;
      else {
        otherTypes[type] = (otherTypes[type] || 0) + 1;
      }
    });
    return { semantic, temporal, entity, causal, total, otherTypes };
  }, [graph2DData]);

  // 节点点击回调
  const handleGraphNodeClick = useCallback(
    (node: GraphNode) => {
      const nodeData = data?.table_rows?.find((row: MemoryTableRow) => row.id === node.id);
      if (nodeData) {
        setSelectedGraphNode(nodeData);
      }
    },
    [data],
  );

  // 颜色和尺寸回调
  const nodeColorFn = useCallback((node: GraphNode) => node.color || "#0074d9", []);

  // 观察类型：按 proof_count 调整节点尺寸
  const observationSizeLookup = useMemo(() => {
    if (factType !== "observation" || !data?.table_rows) return null;
    const counts = new Map<string, number>();
    let max = 1;
    for (const row of data.table_rows as Array<{ id: string; proof_count?: number | null }>) {
      const c = row.proof_count ?? 1;
      counts.set(row.id, c);
      if (c > max) max = c;
    }
    return { counts, max };
  }, [factType, data]);

  // 近期热度映射
  const recencyLookup = useMemo(() => {
    if (!data?.table_rows?.length) return null;
    type Row = {
      id: string;
      mentioned_at?: string | null;
      occurred_start?: string | null;
      occurred_end?: string | null;
    };
    const times = new Map<string, number>();
    let minT = Infinity;
    let maxT = -Infinity;
    for (const row of data.table_rows as Row[]) {
      const ts = row[recencyBasis];
      if (!ts) continue;
      const tt = Date.parse(ts);
      if (Number.isNaN(tt)) continue;
      times.set(row.id, tt);
      if (tt < minT) minT = tt;
      if (tt > maxT) maxT = tt;
    }
    if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT === minT) {
      return null;
    }
    return { times, minT, maxT };
  }, [data, recencyBasis]);

  const recencyHeatFn = useCallback(
    (node: GraphNode) => {
      if (!recencyLookup) return 0.5;
      const tt = recencyLookup.times.get(node.id);
      if (tt === undefined) return 0;
      return (tt - recencyLookup.minT) / (recencyLookup.maxT - recencyLookup.minT);
    },
    [recencyLookup],
  );

  const observationNodeSizeFn = useCallback(
    (node: GraphNode) => {
      if (!observationSizeLookup) return 3;
      const c = observationSizeLookup.counts.get(node.id) ?? 1;
      return 3 + Math.min(Math.sqrt(c - 1) * 2, 11);
    },
    [observationSizeLookup],
  );

  const linkColorFn = useCallback((link: { type?: string }) => {
    if (link.type === "temporal") return "#009296";
    if (link.type === "entity") return "#f59e0b";
    if (link.type === "causes" || link.type === "caused_by" || link.type === "enables" || link.type === "prevents") {
      return "#8b5cf6";
    }
    return "#0074d9";
  }, []);

  // 组件挂载或 factType 变化时自动加载数据
  useEffect(() => {
    loadData();
  }, []);

  // 节点数量限制（防止 UI 不稳定）
  useEffect(() => {
    if (data && maxNodes === undefined) {
      if (graph2DData.nodes.length > 50) {
        setMaxNodes(20);
      } else if (graph2DData.nodes.length > 20) {
        setMaxNodes(20);
      }
    }
  }, [data, graph2DData.nodes.length, maxNodes]);

  return (
    <div>
      {loading && !data ? (
        <div className="text-center py-12">
          <RefreshCw className="w-8 h-8 mx-auto mb-3 text-muted-foreground animate-spin" />
          <p className="text-muted-foreground">{t("dataView.loadingMemories")}</p>
        </div>
      ) : !data ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <div className="text-sm text-muted-foreground">{t("dataView.noDataAvailable")}</div>
          </div>
        </div>
      ) : data.table_rows?.length === 0 ? (
        /* 空状态 */
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-[15px] font-semibold text-[#56667d]">{t("dataView.emptyTitle")}</p>
          <p className="mt-1 text-[13px] text-[#8a9ab0]">{t("dataView.emptyHint")}</p>
          <img
            src={emptyMemoriesImg}
            alt={t("dataView.emptyTitle")}
            className="w-[70%] max-w-full mt-6 mb-4 opacity-80"
          />
          <p className="text-[13px] text-[#8a9ab0]">{t("dataView.emptyFooter")}</p>
        </div>
      ) : (
        <>
          {compactMode ? (
            <div className="flex items-center justify-between mb-2 px-1">
              <div className="text-xs text-muted-foreground">
                {t("dataView.totalMemories", { count: data.total_units })}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (onExpandToggle) {
                    onExpandToggle();
                  } else {
                    setCompactMode(false);
                  }
                }}
                className="h-6 px-2 text-xs gap-1"
              >
                {t("dataView.expand", { defaultValue: "Expand" })}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-4">
                {compact && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (onExpandToggle) {
                        onExpandToggle();
                      } else {
                        setCompactMode(true);
                      }
                    }}
                    className="h-7 px-2 text-xs gap-1"
                  >
                    {t("dataView.compact", { defaultValue: "Compact" })}
                  </Button>
                )}
                <div className="text-sm text-muted-foreground">
                  {(data.table_rows?.length ?? 0) < (data.total_units ?? 0)
                    ? t("dataView.showingMemories", {
                        shown: data.table_rows?.length ?? 0,
                        total: data.total_units ?? 0,
                      })
                    : t("dataView.totalMemories", { count: data.total_units ?? 0 })}
                </div>

                {/* 观察类型整合状态 */}
                {factType === "observation" && consolidationStatus && (
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border ${
                      consolidationStatus.pending_consolidation === 0
                        ? "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20"
                        : "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20"
                    }`}
                  >
                    {consolidationStatus.pending_consolidation === 0 ? (
                      <>
                        <CheckCircle className="w-3 h-3" />
                        {t("dataView.inSync")}
                      </>
                    ) : (
                      <>
                        <Clock className="w-3 h-3" />
                        {t("dataView.pendingCount", { count: consolidationStatus.pending_consolidation })}
                      </>
                    )}
                  </span>
                )}
              </div>

              {/* 视图模式切换 */}
              <div className="flex items-center gap-2 bg-muted rounded-lg p-1">
                <button
                  onClick={() => setViewMode("constellation")}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${
                    viewMode === "constellation"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <ScatterChart className="w-4 h-4" />
                  {t("dataView.constellation")}
                </button>
                <button
                  onClick={() => setViewMode("graph")}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${
                    viewMode === "graph"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Network className="w-4 h-4" />
                  {t("dataView.graph")}
                </button>
                <button
                  onClick={() => setViewMode("table")}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${
                    viewMode === "table"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <List className="w-4 h-4" />
                  {t("dataView.table")}
                </button>
                <button
                  onClick={() => setViewMode("timeline")}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${
                    viewMode === "timeline"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Calendar className="w-4 h-4" />
                  {t("dataView.timeline")}
                </button>
              </div>
            </div>
          )}

          {/* ── Graph 视图 ── */}
          {!compactMode && viewMode === "graph" && (
            <div className="flex gap-0">
              <div className="flex-1 min-w-0">
                <Graph2D
                  data={graph2DData}
                  height={700}
                  showLabels={showLabels}
                  onNodeClick={handleGraphNodeClick}
                  maxNodes={maxNodes}
                  nodeColorFn={nodeColorFn}
                  linkColorFn={linkColorFn}
                />
              </div>

              <button
                onClick={() => setShowControlPanel(!showControlPanel)}
                className="flex-shrink-0 w-5 h-[700px] bg-transparent hover:bg-muted/50 flex items-center justify-center transition-colors"
                title={showControlPanel ? t("dataView.hidePanel") : t("dataView.showPanel")}
              >
                {showControlPanel ? (
                  <ChevronRight className="w-3 h-3 text-muted-foreground/60" />
                ) : (
                  <ChevronLeft className="w-3 h-3 text-muted-foreground/60" />
                )}
              </button>

              <div
                className={`${showControlPanel ? "w-80" : "w-0"} transition-all duration-300 overflow-hidden flex-shrink-0`}
              >
                <div className="w-80 h-[700px] bg-card border-l border-border overflow-y-auto">
                  {selectedGraphNode ? (
                    <MemoryDetailPanel memory={selectedGraphNode} onClose={() => setSelectedGraphNode(null)} inPanel />
                  ) : (
                    <div className="p-4 space-y-5">
                      {/* 图例和统计 */}
                      <div>
                        <h3 className="text-sm font-semibold mb-3 text-foreground">{t("dataView.graphTitle")}</h3>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: "#0074d9" }} />
                              <span className="text-foreground">{t("dataView.nodes")}</span>
                            </div>
                            <span className="font-mono text-foreground">
                              {Math.min(maxNodes ?? graph2DData.nodes.length, graph2DData.nodes.length)}/
                              {graph2DData.nodes.length}
                            </span>
                          </div>

                          {/* 链接类型过滤 */}
                          <div className="text-xs font-medium text-muted-foreground mt-2 mb-1">
                            {t("dataView.linksWithCount", { count: linkStats.total })}{" "}
                            <span className="text-muted-foreground/60">{t("dataView.clickToFilter")}</span>
                          </div>
                          {(["semantic", "temporal", "entity", "causal"] as const).map((type) => {
                            const colors: Record<string, string> = {
                              semantic: "#0074d9",
                              temporal: "#009296",
                              entity: "#f59e0b",
                              causal: "#8b5cf6",
                            };
                            return (
                              <button
                                key={type}
                                onClick={() => toggleLinkType(type)}
                                className={`w-full flex items-center justify-between text-sm px-2 py-1 rounded transition-all ${
                                  visibleLinkTypes.has(type) ? "hover:bg-muted" : "opacity-40 hover:opacity-60"
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <div className="w-4 h-0.5" style={{ backgroundColor: colors[type] }} />
                                  <span className="text-foreground">{t(`dataView.${type}`)}</span>
                                </div>
                                <span className="font-mono text-foreground">
                                  {linkStats[type as keyof typeof linkStats] as number}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="border-t border-border" />

                      {/* 显示控制 */}
                      <div>
                        <h3 className="text-sm font-semibold mb-3 text-foreground">{t("dataView.displayTitle")}</h3>
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <Label htmlFor="show-labels" className="text-sm text-foreground">
                              {t("dataView.showLabels")}
                            </Label>
                            <Switch id="show-labels" checked={showLabels} onCheckedChange={setShowLabels} />
                          </div>
                        </div>
                      </div>

                      <div className="border-t border-border" />

                      {/* 性能控制 */}
                      <div>
                        <h3 className="text-sm font-semibold mb-3 text-foreground">{t("dataView.performanceTitle")}</h3>
                        <div className="space-y-4">
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <Label className="text-sm text-foreground">{t("dataView.maxNodes")}</Label>
                              <span className="text-xs text-muted-foreground">
                                {graph2DData.nodes.length > 50
                                  ? `${maxNodes ?? 50} / ${graph2DData.nodes.length}`
                                  : `${maxNodes ?? t("dataView.all")} / ${graph2DData.nodes.length}`}
                              </span>
                            </div>
                            <input
                              type="range"
                              value={
                                graph2DData.nodes.length > 50
                                  ? maxNodes || 20
                                  : maxNodes || Math.min(graph2DData.nodes.length, 20)
                              }
                              min={10}
                              max={Math.min(Math.max(graph2DData.nodes.length, 10), 50)}
                              step={10}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                const effectiveMax = Math.min(graph2DData.nodes.length, 50);
                                if (graph2DData.nodes.length > 50) {
                                  setMaxNodes(v);
                                } else {
                                  setMaxNodes(v >= effectiveMax ? undefined : v);
                                }
                              }}
                              className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                            />
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {t("dataView.allLinksVisible")}
                            {graph2DData.nodes.length > 50 && (
                              <span className="block text-amber-600 dark:text-amber-400 mt-1">
                                {t("dataView.limitedTo50Nodes", { count: graph2DData.nodes.length })}
                              </span>
                            )}
                          </p>
                        </div>
                      </div>

                      <div className="border-t border-border" />
                      <div className="text-xs text-muted-foreground/60 text-center pt-2">
                        {t("dataView.clickNodeForDetails")}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Constellation 视图 ── */}
          {(compactMode || viewMode === "constellation") && (
            <div className="flex gap-0">
              <div className="flex-1 min-w-0 border border-border rounded-lg overflow-hidden">
                <Constellation
                  key={compactMode ? "compact" : "full"}
                  data={graph2DData}
                  height={compactMode ? 300 : 700}
                  onNodeClick={handleGraphNodeClick}
                  nodeColorFn={nodeColorFn}
                  linkColorFn={linkColorFn}
                  nodeSizeFn={factType === "observation" ? observationNodeSizeFn : undefined}
                  sizeLegendLabel={factType === "observation" ? t("dataView.sourceFactsLabel") : undefined}
                  nodeHeatFn={recencyLookup ? recencyHeatFn : undefined}
                  heatLegendLabel={
                    recencyLookup ? t("dataView.recencyLabel", { basis: RECENCY_BASIS_LABEL[recencyBasis] }) : undefined
                  }
                  heatLegendEndpoints={
                    recencyLookup
                      ? [
                          new Date(recencyLookup.minT).toISOString().slice(0, 10),
                          new Date(recencyLookup.maxT).toISOString().slice(0, 10),
                        ]
                      : undefined
                  }
                />
              </div>

              {/* 右侧面板（非紧凑模式） */}
              {!compactMode && (
                <>
                  <button
                    onClick={() => setShowControlPanel(!showControlPanel)}
                    className="flex-shrink-0 w-5 h-[700px] bg-transparent hover:bg-muted/50 flex items-center justify-center transition-colors"
                    title={showControlPanel ? t("dataView.hidePanel") : t("dataView.showPanel")}
                  >
                    {showControlPanel ? (
                      <ChevronRight className="w-3 h-3 text-muted-foreground" />
                    ) : (
                      <ChevronLeft className="w-3 h-3 text-muted-foreground" />
                    )}
                  </button>

                  {showControlPanel && (
                    <div className="w-72 flex-shrink-0 border border-border rounded-lg bg-muted/20 overflow-y-auto h-[700px]">
                      {selectedGraphNode ? (
                        <MemoryDetailPanel
                          memory={selectedGraphNode}
                          onClose={() => setSelectedGraphNode(null)}
                          inPanel
                        />
                      ) : (
                        <div className="p-4 space-y-4">
                          <h3 className="text-sm font-semibold text-foreground">
                            {t("dataView.constellationViewTitle")}
                          </h3>
                          <p className="text-xs text-muted-foreground">{t("dataView.constellationViewDescription")}</p>
                          {/* 近期颜色基准选择 */}
                          <div className="space-y-2 pt-2">
                            <h4 className="text-xs font-medium text-muted-foreground">{t("dataView.colorBy")}</h4>
                            <Select value={recencyBasis} onValueChange={(v) => setRecencyBasis(v as RecencyBasis)}>
                              <SelectTrigger className="h-8 w-full text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="mentioned_at">{t("dataView.mentioned")}</SelectItem>
                                <SelectItem value="occurred_start">{t("dataView.occurredStart")}</SelectItem>
                                <SelectItem value="occurred_end">{t("dataView.occurredEnd")}</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {/* 链接类型 */}
                          <div className="space-y-2 pt-2">
                            <h4 className="text-xs font-medium text-muted-foreground">{t("dataView.linkTypes")}</h4>
                            {Object.entries({
                              semantic: "#0074d9",
                              temporal: "#009296",
                              entity: "#f59e0b",
                              causal: "#8b5cf6",
                            }).map(([type, color]) => (
                              <div
                                key={type}
                                className="flex items-center gap-2 cursor-pointer"
                                onClick={() => toggleLinkType(type)}
                              >
                                <div
                                  className="w-3 h-3 rounded-full"
                                  style={{
                                    backgroundColor: color,
                                    opacity: visibleLinkTypes.has(type) ? 1 : 0.2,
                                  }}
                                />
                                <span
                                  className={`text-xs capitalize ${visibleLinkTypes.has(type) ? "text-foreground" : "text-muted-foreground line-through"}`}
                                >
                                  {t(`dataView.${type}`)}
                                </span>
                              </div>
                            ))}
                          </div>
                          <div className="text-xs text-muted-foreground space-y-1 pt-2">
                            <div>
                              {t("dataView.nodes")}: <span className="text-foreground">{graph2DData.nodes.length}</span>
                            </div>
                            <div>
                              {t("dataView.links")}: <span className="text-foreground">{graph2DData.links.length}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Table 视图 ── */}
          {!compactMode && viewMode === "table" && (
            <div>
              <div className="w-full">
                <div className="pb-4">
                  {filteredTableRows.length > 0 ? (
                    (() => {
                      const totalPages = Math.ceil(filteredTableRows.length / itemsPerPage);
                      const startIndex = (currentPage - 1) * itemsPerPage;
                      const endIndex = startIndex + itemsPerPage;
                      const paginatedRows = filteredTableRows.slice(startIndex, endIndex);

                      return (
                        <>
                          <Table className="table-fixed">
                            <TableHeader>
                              <TableRow>
                                <TableHead className={factType === "observation" ? "w-[35%]" : "w-[38%]"}>
                                  {factType === "observation"
                                    ? t("dataView.columnObservation")
                                    : t("dataView.columnMemory")}
                                </TableHead>
                                <TableHead className="w-[15%]">{t("dataView.columnEntities")}</TableHead>
                                <TableHead className="w-[15%]">{t("dataView.columnTags")}</TableHead>
                                {factType === "observation" && (
                                  <TableHead className="w-[10%]">{t("dataView.columnSources")}</TableHead>
                                )}
                                <TableHead className={factType === "observation" ? "w-[12%]" : "w-[16%]"}>
                                  {t("dataView.columnOccurred")}
                                </TableHead>
                                <TableHead className={factType === "observation" ? "w-[13%]" : "w-[16%]"}>
                                  {t("dataView.columnMentioned")}
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {paginatedRows.map((row: MemoryTableRow, idx: number) => {
                                const occurredDisplay = row.occurred_start
                                  ? new Date(row.occurred_start).toLocaleDateString(undefined, {
                                      month: "short",
                                      day: "numeric",
                                      year: "numeric",
                                    })
                                  : null;
                                const mentionedDisplay = row.mentioned_at
                                  ? new Date(row.mentioned_at).toLocaleDateString(undefined, {
                                      month: "short",
                                      day: "numeric",
                                      year: "numeric",
                                    })
                                  : null;

                                return (
                                  <TableRow
                                    key={row.id || idx}
                                    onClick={() => setModalMemoryId(row.id)}
                                    className="cursor-pointer hover:bg-muted/50"
                                  >
                                    <TableCell className="py-2">
                                      <div className="line-clamp-2 text-sm leading-snug text-foreground">
                                        {row.text}
                                      </div>
                                      {row.context && factType !== "observation" && (
                                        <div className="text-xs text-muted-foreground mt-0.5 truncate">
                                          {row.context}
                                        </div>
                                      )}
                                    </TableCell>
                                    <TableCell className="py-2">
                                      {row.entities ? (
                                        <div className="flex gap-1 flex-wrap">
                                          {(typeof row.entities === "string" ? row.entities.split(", ") : row.entities)
                                            .slice(0, 2)
                                            .map((entity: string, _i: number) => (
                                              <span
                                                key={entity}
                                                className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium"
                                              >
                                                {entity}
                                              </span>
                                            ))}
                                          {(typeof row.entities === "string" ? row.entities.split(", ") : row.entities)
                                            .length > 2 && (
                                            <span className="text-[10px] text-muted-foreground">
                                              +
                                              {(typeof row.entities === "string"
                                                ? row.entities.split(", ")
                                                : row.entities
                                              ).length - 2}
                                            </span>
                                          )}
                                        </div>
                                      ) : (
                                        <span className="text-xs text-muted-foreground">-</span>
                                      )}
                                    </TableCell>
                                    <TableCell className="py-2">
                                      {row.tags && row.tags.length > 0 ? (
                                        <div className="flex gap-1 flex-wrap">
                                          {(row.tags as string[]).slice(0, 2).map((tag: string, _i: number) => (
                                            <span
                                              key={tag}
                                              className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-700 border border-amber-500/20 font-medium font-mono"
                                            >
                                              #{tag}
                                            </span>
                                          ))}
                                          {row.tags.length > 2 && (
                                            <span className="text-[10px] text-muted-foreground">
                                              +{row.tags.length - 2}
                                            </span>
                                          )}
                                        </div>
                                      ) : (
                                        <span className="text-xs text-muted-foreground">-</span>
                                      )}
                                    </TableCell>
                                    {factType === "observation" && (
                                      <TableCell className="text-xs py-2 text-foreground">
                                        {row.proof_count ?? 1}
                                      </TableCell>
                                    )}
                                    <TableCell className="text-xs py-2 text-foreground">
                                      {occurredDisplay || <span className="text-muted-foreground">-</span>}
                                    </TableCell>
                                    <TableCell className="text-xs py-2 text-foreground">
                                      {mentionedDisplay || <span className="text-muted-foreground">-</span>}
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>

                          {/* 分页 */}
                          {totalPages > 1 && (
                            <div className="flex items-center justify-between mt-3 pt-3 border-t">
                              <div className="text-xs text-muted-foreground">
                                {startIndex + 1}-{Math.min(endIndex, filteredTableRows.length)} {t("dataView.of")}{" "}
                                {filteredTableRows.length}
                              </div>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setCurrentPage(1)}
                                  disabled={currentPage === 1}
                                  className="h-7 w-7 p-0"
                                >
                                  <ChevronsLeft className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                                  disabled={currentPage === 1}
                                  className="h-7 w-7 p-0"
                                >
                                  <ChevronLeft className="h-3 w-3" />
                                </Button>
                                <span className="text-xs px-2">
                                  {currentPage} / {totalPages}
                                </span>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                                  disabled={currentPage === totalPages}
                                  className="h-7 w-7 p-0"
                                >
                                  <ChevronRight className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setCurrentPage(totalPages)}
                                  disabled={currentPage === totalPages}
                                  className="h-7 w-7 p-0"
                                >
                                  <ChevronsRight className="h-3 w-3" />
                                </Button>
                              </div>
                            </div>
                          )}
                        </>
                      );
                    })()
                  ) : (
                    <div className="text-center py-12 text-muted-foreground">
                      {(data.table_rows?.length ?? 0) > 0
                        ? t("dataView.noMemoriesMatchFilter")
                        : t("dataView.noMemoriesFound")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Timeline 视图 ── */}
          {!compactMode && viewMode === "timeline" && (
            <TimelineView data={data} filteredRows={filteredTableRows} onMemoryClick={(id) => setModalMemoryId(id)} />
          )}
        </>
      )}

      {/* 内存详情弹窗 */}
      <MemoryDetailModal memoryId={modalMemoryId} onClose={() => setModalMemoryId(null)} />
    </div>
  );
}

// ── Timeline 视图组件 ──
type Granularity = "year" | "month" | "week" | "day";

function TimelineView({
  data,
  filteredRows,
  onMemoryClick,
}: {
  data: GraphApiData;
  filteredRows: MemoryTableRow[];
  onMemoryClick: (id: string) => void;
}) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [currentIndex, setCurrentIndex] = useState(0);

  // 过滤并按日期排序
  const { sortedItems, itemsWithoutDates } = useMemo(() => {
    if (!filteredRows || filteredRows.length === 0) return { sortedItems: [], itemsWithoutDates: [] };
    const withDates = filteredRows
      .filter((row) => row.occurred_start)
      .sort((a, b) => new Date(a.occurred_start!).getTime() - new Date(b.occurred_start!).getTime());
    const withoutDates = filteredRows.filter((row) => !row.occurred_start);
    return { sortedItems: withDates, itemsWithoutDates: withoutDates };
  }, [filteredRows]);

  // 按粒度分组
  const timelineGroups = useMemo(() => {
    if (sortedItems.length === 0) return [];

    const getGroupKey = (date: Date): string => {
      const year = date.getFullYear();
      const month = date.getMonth();
      const day = date.getDate();
      switch (granularity) {
        case "year":
          return `${year}`;
        case "month":
          return `${year}-${String(month + 1).padStart(2, "0")}`;
        case "week": {
          const startOfWeek = new Date(date);
          startOfWeek.setDate(day - date.getDay());
          return `${startOfWeek.getFullYear()}-W${String(Math.ceil(startOfWeek.getDate() / 7)).padStart(2, "0")}-${String(startOfWeek.getMonth() + 1).padStart(2, "0")}-${String(startOfWeek.getDate()).padStart(2, "0")}`;
        }
        case "day":
          return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    };

    const getGroupLabel = (key: string, date: Date): string => {
      switch (granularity) {
        case "year":
          return key;
        case "month":
          return date.toLocaleDateString(undefined, { year: "numeric", month: "short" });
        case "week": {
          const endOfWeek = new Date(date);
          endOfWeek.setDate(date.getDate() + 6);
          return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${endOfWeek.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
        }
        case "day":
          return date.toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
          });
      }
    };

    const groups: { [key: string]: { items: MemoryTableRow[]; date: Date } } = {};
    sortedItems.forEach((row) => {
      const date = new Date(row.occurred_start!);
      const key = getGroupKey(date);
      if (!groups[key]) {
        let groupDate = date;
        if (granularity === "week") {
          const parts = key.split("-");
          groupDate = new Date(parseInt(parts[0], 10), parseInt(parts[2], 10) - 1, parseInt(parts[3], 10));
        }
        groups[key] = { items: [], date: groupDate };
      }
      groups[key].items.push(row);
    });

    return Object.entries(groups)
      .sort(([, a], [, b]) => a.date.getTime() - b.date.getTime())
      .map(([key, { items, date }]) => ({ key, label: getGroupLabel(key, date), items, date }));
  }, [sortedItems, granularity]);

  const scrollToGroup = (index: number) => {
    const clampedIndex = Math.max(0, Math.min(index, timelineGroups.length - 1));
    setCurrentIndex(clampedIndex);
    const element = document.getElementById(`timeline-group-${clampedIndex}`);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const zoomIn = () => {
    const levels: Granularity[] = ["year", "month", "week", "day"];
    const currentIdx = levels.indexOf(granularity);
    if (currentIdx < levels.length - 1) {
      setGranularity(levels[currentIdx + 1]);
    }
  };

  const zoomOut = () => {
    const levels: Granularity[] = ["year", "month", "week", "day"];
    const currentIdx = levels.indexOf(granularity);
    if (currentIdx > 0) {
      setGranularity(levels[currentIdx - 1]);
    }
  };

  if (sortedItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Calendar className="w-12 h-12 text-muted-foreground mb-3" />
        <div className="text-base font-medium text-foreground mb-1">{t("dataView.noTimelineData")}</div>
        <div className="text-xs text-muted-foreground text-center max-w-md">
          {t("dataView.noTimelineDataDescription")}
        </div>
      </div>
    );
  }

  const granularityLabels: Record<Granularity, string> = {
    year: t("dataView.granularityYear"),
    month: t("dataView.granularityMonth"),
    week: t("dataView.granularityWeek"),
    day: t("dataView.granularityDay"),
  };

  return (
    <div className="px-4">
      {/* 控制栏 */}
      <div className="flex items-center justify-between mb-3 gap-4">
        <div className="text-xs text-muted-foreground">
          {t("dataView.timelineMemoriesCount", { count: sortedItems.length })}
          {itemsWithoutDates.length > 0 &&
            ` ${t("dataView.timelineWithoutDates", { count: itemsWithoutDates.length })}`}
        </div>

        <div className="flex items-center gap-1">
          {/* 缩放 */}
          <div className="flex items-center border border-border rounded mr-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={zoomOut}
              disabled={granularity === "year"}
              className="h-7 w-7 p-0"
              title={t("dataView.zoomOut")}
            >
              <ZoomOut className="h-3 w-3" />
            </Button>
            <span className="text-[10px] px-2 min-w-[50px] text-center border-x border-border text-foreground">
              {granularityLabels[granularity]}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={zoomIn}
              disabled={granularity === "day"}
              className="h-7 w-7 p-0"
              title={t("dataView.zoomIn")}
            >
              <ZoomIn className="h-3 w-3" />
            </Button>
          </div>

          {/* 导航 */}
          <div className="flex items-center border border-border rounded">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(0)}
              disabled={timelineGroups.length <= 1}
              className="h-7 w-7 p-0"
            >
              <ChevronsLeft className="h-3 w-3" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(currentIndex - 1)}
              disabled={currentIndex === 0}
              className="h-7 w-7 p-0"
            >
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <span className="text-[10px] px-2 min-w-[60px] text-center border-x border-border text-foreground">
              {currentIndex + 1} / {timelineGroups.length}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(currentIndex + 1)}
              disabled={currentIndex >= timelineGroups.length - 1}
              className="h-7 w-7 p-0"
            >
              <ChevronRight className="h-3 w-3" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(timelineGroups.length - 1)}
              disabled={timelineGroups.length <= 1}
              className="h-7 w-7 p-0"
            >
              <ChevronsRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      {/* 时间线条目 */}
      <div className="relative max-h-[550px] overflow-y-auto pr-2">
        <div className="absolute left-[60px] top-0 bottom-0 w-0.5 bg-border" />
        {timelineGroups.map((group, groupIdx) => (
          <div key={group.key} id={`timeline-group-${groupIdx}`} className="mb-4">
            {/* 分组头 */}
            <div
              className="flex items-center mb-2 cursor-pointer hover:opacity-80"
              onClick={() => setCurrentIndex(groupIdx)}
            >
              <div className="w-[60px] text-right pr-3">
                <span className="text-xs font-semibold text-primary">{group.label}</span>
              </div>
              <div className="w-2 h-2 rounded-full bg-primary z-10" />
              <span className="ml-2 text-[10px] text-muted-foreground">
                {group.items.length}{" "}
                {group.items.length === 1 ? t("dataView.timelineItem") : t("dataView.timelineItems")}
              </span>
            </div>

            {/* 条目列表 */}
            <div className="space-y-1">
              {group.items.map((item: MemoryTableRow, idx: number) => (
                <div
                  key={item.id || idx}
                  onClick={() => onMemoryClick(item.id)}
                  className="flex items-start cursor-pointer group hover:opacity-80"
                >
                  <div className="w-[60px] text-right pr-3 pt-1 flex-shrink-0">
                    <div className="text-[10px] text-muted-foreground">
                      {new Date(item.occurred_start!).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </div>
                    <div className="text-[9px] text-muted-foreground/70">
                      {new Date(item.occurred_start!).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </div>
                  </div>
                  <div className="flex-shrink-0 pt-2">
                    <div className="w-1.5 h-1.5 rounded-full z-10 bg-muted-foreground/50 group-hover:bg-primary" />
                  </div>
                  <div className="ml-3 flex-1 p-2 rounded border transition-colors bg-card border-border hover:border-primary/50">
                    <p className="text-xs text-foreground line-clamp-2 leading-relaxed">{item.text}</p>
                    {item.entities && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {(typeof item.entities === "string" ? item.entities.split(", ") : item.entities)
                          .slice(0, 3)
                          .map((entity: string, _i: number) => (
                            <span
                              key={entity}
                              className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium"
                            >
                              {entity}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
