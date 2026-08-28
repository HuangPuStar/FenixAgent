import {
  AlertCircle,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { hindsightApi } from "@/src/api/hindsight";
import { NS } from "@/src/i18n";
import type { GraphApiData, MemoryTableRow } from "../types";
import { Constellation } from "./Constellation";
import { convertHindsightGraphData, Graph2D, type GraphNode } from "./Graph2d";
import { MemoryDetailModal } from "./MemoryDetailModal";
import { MemoryDetailPanel } from "./MemoryDetailPanel";
import { MemoryViewSwitcher } from "./MemoryViewSwitcher";
import { MemoryVisualizationShell } from "./MemoryVisualizationShell";

type FactType = "world" | "experience" | "observation";
type ViewMode = "graph" | "table" | "timeline" | "constellation";

interface DataViewProps {
  factType: FactType;
  documentId?: string;
  chunkId?: string;
  initialQuery?: string;
  compact?: boolean;
  onExpandToggle?: () => void;
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: 组件命名为视图概念 DataView
export function DataView({
  factType,
  documentId,
  chunkId,
  initialQuery,
  compact = false,
  onExpandToggle,
}: DataViewProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [viewMode, setViewMode] = useState<ViewMode>("constellation");
  const [compactMode, setCompactMode] = useState(compact);
  const [data, setData] = useState<GraphApiData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const [showLabels] = useState(true);
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

  const loadData = async (limit?: number, q: string | undefined = initialQuery, tags?: string[]) => {
    setLoading(true);
    setError(null);
    try {
      const graphData = await hindsightApi.getGraph({
        type: factType,
        limit: limit ?? fetchLimit,
        q: q || undefined,
        tags,
        document_id: documentId,
        chunk_id: chunkId,
      });
      setData(graphData);

      // 观察类型的整合状态是辅助信息，失败时不应遮盖已经成功加载的图数据。
      if (factType === "observation") {
        try {
          const stats = await hindsightApi.getBankStats();
          setConsolidationStatus({
            pending_consolidation: stats.pending_consolidation ?? 0,
            last_consolidated_at: stats.last_consolidated_at ?? null,
          });
        } catch (statsError) {
          console.error("[DataView] getBankStats failed:", statsError);
          setConsolidationStatus(null);
        }
      }
    } catch (loadError) {
      console.error("[DataView] loadData failed:", loadError);
      setError(loadError instanceof Error ? loadError.message : t("dataView.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  // 表格行数据（已由服务端过滤）
  const filteredTableRows = useMemo(() => {
    return data?.table_rows ?? [];
  }, [data]);

  // 链接类型归一化
  const getLinkTypeCategory = useCallback((type: string | undefined): string => {
    if (!type) return "semantic";
    if (type === "semantic" || type === "temporal" || type === "entity") return type;
    if (["causes", "caused_by", "enables", "prevents"].includes(type)) return "causal";
    return "semantic";
  }, []);

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
  const nodeColorFn = useCallback((node: GraphNode) => node.color || "var(--color-primary)", []);

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
    if (link.type === "temporal") return "var(--color-cyan)";
    if (link.type === "entity") return "var(--color-status-warning)";
    if (link.type === "causes" || link.type === "caused_by" || link.type === "enables" || link.type === "prevents") {
      return "var(--color-accent-pink)";
    }
    return "var(--color-primary)";
  }, []);

  // 组件挂载或 factType 变化时自动加载数据
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only load, loadData ref stable via ref pattern
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
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {loading && !data ? (
        <div className="text-center py-12" role="status">
          <RefreshCw className="w-8 h-8 mx-auto mb-3 text-muted-foreground animate-spin" />
          <p className="text-muted-foreground">{t("dataView.loadingMemories")}</p>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center" role="alert">
          <AlertCircle className="size-8 text-destructive" />
          <div>
            <p className="text-sm font-medium">{t("dataView.loadFailed")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{error}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void loadData()} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            {t("dataView.retry")}
          </Button>
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
          <p className="text-[15px] font-semibold text-foreground">{t("dataView.emptyTitle")}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">{t("dataView.emptyHint")}</p>
          <img
            src="/images/memories-empty.webp"
            alt={t("dataView.emptyTitle")}
            className="w-[70%] max-w-full mt-6 mb-4 opacity-80"
          />
          <p className="text-[13px] text-muted-foreground">{t("dataView.emptyFooter")}</p>
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
            <div className="mb-4 flex min-w-0 flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
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
              <MemoryViewSwitcher
                value={viewMode}
                onValueChange={setViewMode}
                ariaLabel={t("dataView.viewSwitcher")}
                options={[
                  { value: "constellation", icon: ScatterChart, label: t("dataView.constellation") },
                  { value: "graph", icon: Network, label: t("dataView.graph") },
                  { value: "table", icon: List, label: t("dataView.table") },
                  { value: "timeline", icon: Calendar, label: t("dataView.timeline") },
                ]}
              />
            </div>
          )}

          {/* ── Graph / Constellation 共享可视化容器 ── */}
          {!compactMode && (viewMode === "graph" || viewMode === "constellation") && (
            <div className="min-h-0 flex-1">
              <MemoryVisualizationShell
                panelOpen={showControlPanel}
                onPanelOpenChange={setShowControlPanel}
                toggleLabel={showControlPanel ? t("dataView.hidePanel") : t("dataView.showPanel")}
                sidebar={
                  selectedGraphNode ? (
                    <MemoryDetailPanel memory={selectedGraphNode} onClose={() => setSelectedGraphNode(null)} inPanel />
                  ) : (
                    <div className="space-y-4 p-4">
                      <h3 className="text-sm font-semibold text-foreground">
                        {viewMode === "graph" ? t("dataView.graphTitle") : t("dataView.constellationViewTitle")}
                      </h3>
                      {viewMode === "constellation" && (
                        <>
                          <p className="text-xs text-muted-foreground">{t("dataView.constellationViewDescription")}</p>
                          <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground">{t("dataView.colorBy")}</Label>
                            <Select
                              value={recencyBasis}
                              onValueChange={(value) => setRecencyBasis(value as RecencyBasis)}
                            >
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
                        </>
                      )}
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">{t("dataView.linkTypes")}</p>
                        {(["semantic", "temporal", "entity", "causal"] as const).map((type) => (
                          <Button
                            key={type}
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleLinkType(type)}
                            className="w-full justify-between"
                          >
                            {t(`dataView.${type}`)}
                            <span className="font-mono">{linkStats[type]}</span>
                          </Button>
                        ))}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("dataView.nodes")}: {graph2DData.nodes.length} · {t("dataView.links")}:{" "}
                        {graph2DData.links.length}
                      </div>
                    </div>
                  )
                }
              >
                {(height) =>
                  viewMode === "graph" ? (
                    <Graph2D
                      data={graph2DData}
                      height={height}
                      showLabels={showLabels}
                      onNodeClick={handleGraphNodeClick}
                      maxNodes={maxNodes}
                      nodeColorFn={nodeColorFn}
                      linkColorFn={linkColorFn}
                    />
                  ) : (
                    <Constellation
                      data={graph2DData}
                      height={height}
                      onNodeClick={handleGraphNodeClick}
                      nodeColorFn={nodeColorFn}
                      linkColorFn={linkColorFn}
                      nodeSizeFn={factType === "observation" ? observationNodeSizeFn : undefined}
                      sizeLegendLabel={factType === "observation" ? t("dataView.sourceFactsLabel") : undefined}
                      nodeHeatFn={recencyLookup ? recencyHeatFn : undefined}
                      heatLegendLabel={
                        recencyLookup
                          ? t("dataView.recencyLabel", { basis: RECENCY_BASIS_LABEL[recencyBasis] })
                          : undefined
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
                  )
                }
              </MemoryVisualizationShell>
            </div>
          )}

          {/* 紧凑模式保持独立固定高度，不参与完整视图 shell。 */}
          {compactMode && (
            <div className="min-w-0 overflow-hidden rounded-lg border border-border">
              <Constellation
                data={graph2DData}
                height={300}
                onNodeClick={handleGraphNodeClick}
                nodeColorFn={nodeColorFn}
                linkColorFn={linkColorFn}
              />
            </div>
          )}

          {/* ── Table 视图 ── */}
          {!compactMode && viewMode === "table" && (
            <div className="min-h-0 min-w-0 flex-1 overflow-auto">
              <div className="min-w-[64rem]">
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
                                const entities = row.entities
                                  ? typeof row.entities === "string"
                                    ? row.entities
                                        .split(",")
                                        .map((entity) => entity.trim())
                                        .filter(Boolean)
                                    : row.entities
                                  : [];
                                const tags = row.tags ?? [];

                                return (
                                  <TableRow
                                    key={row.id || idx}
                                    onClick={() => setModalMemoryId(row.id)}
                                    className="h-[60px] cursor-pointer hover:bg-muted/50"
                                  >
                                    <TableCell className="py-2 align-middle">
                                      <div className="line-clamp-2 break-words text-sm leading-snug text-foreground">
                                        {row.text}
                                      </div>
                                    </TableCell>
                                    <TableCell className="py-2 align-middle">
                                      {entities.length > 0 ? (
                                        <div className="flex min-w-0 items-center overflow-hidden">
                                          <span
                                            title={entities[0]}
                                            className="block min-w-0 max-w-full truncate rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                                          >
                                            {entities[0]}
                                          </span>
                                          {entities.length > 1 && (
                                            <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">
                                              +{entities.length - 1}
                                            </span>
                                          )}
                                        </div>
                                      ) : (
                                        <span className="text-xs text-muted-foreground">-</span>
                                      )}
                                    </TableCell>
                                    <TableCell className="py-2 align-middle">
                                      {tags.length > 0 ? (
                                        <div className="flex min-w-0 items-center overflow-hidden">
                                          <span
                                            title={tags[0]}
                                            className="block min-w-0 max-w-full truncate rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-700"
                                          >
                                            #{tags[0]}
                                          </span>
                                          {tags.length > 1 && (
                                            <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">
                                              +{tags.length - 1}
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
            <div className="min-h-0 flex-1 overflow-auto">
              <TimelineView
                _data={data}
                filteredRows={filteredTableRows}
                onMemoryClick={(id) => setModalMemoryId(id)}
              />
            </div>
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
  _data,
  filteredRows,
  onMemoryClick,
}: {
  _data: GraphApiData;
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
