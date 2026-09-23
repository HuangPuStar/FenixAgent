import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Calendar, CheckCircle, Clock, List, Network, ScatterChart } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toHindsightFailure } from "../failure";
import { recencyEndpoints } from "../recency";
import type { MemoryTableRow } from "../types";
import { Constellation } from "./Constellation";
import { DataViewControlPanel } from "./data-view-control-panel";
import type { FactType, RecencyBasis, ViewMode } from "./data-view-model";
import { DataViewTable } from "./data-view-table";
import { DataViewTimeline } from "./data-view-timeline";
import { Graph2D } from "./Graph2d";
import type { GraphNode } from "./graph-model";
import { HindsightFailureNotice } from "./HindsightFailureNotice";
import { MemoryDetailModal } from "./MemoryDetailModal";
import { MemoryDetailPanel } from "./MemoryDetailPanel";
import { MemoryViewSwitcher } from "./MemoryViewSwitcher";
import { MemoryVisualizationShell } from "./MemoryVisualizationShell";
import { useDataViewData } from "./use-data-view-data";

/**
 * `DataView` —— 记忆数据视角的主视图（图谱 / 星座图 / 表格 / 时间线四种看同一份数据）。
 *
 * 本文件只做编排与外壳：取数与派生在 `use-data-view-data.ts`（`useRequest` 三态，§3.4），
 * 纯派生口径在 `data-view-model.ts`，三条视图与右侧面板分别是 `data-view-table.tsx` /
 * `data-view-timeline.tsx` / `data-view-control-panel.tsx`。页面级状态（当前视图、紧凑态、表格页码、
 * 选中的节点、详情弹窗、面板开合）仍在这里持有——它们要跨视图切换存活，放进子组件会在卸载时被重置。
 *
 * 两套图谱的渲染模型刻意分叉（`Constellation` 自绘 canvas、`Graph2D` Cytoscape.js，见 §4.8），
 * 这里只负责把同一份 `graphData` 与配色 / 尺寸 / 热度回调交给选中的那一套。
 */
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
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedGraphNode, setSelectedGraphNode] = useState<MemoryTableRow | null>(null);
  const [modalMemoryId, setModalMemoryId] = useState<string | null>(null);

  // Constellation 近期颜色的时间基准
  const RECENCY_BASIS_LABEL: Record<RecencyBasis, string> = {
    mentioned_at: t("dataView.recencyBasisMentioned"),
    occurred_start: t("dataView.recencyBasisOccurredStart"),
    occurred_end: t("dataView.recencyBasisOccurredEnd"),
  };

  // 图谱控制状态
  const [showLabels] = useState(true);
  const [showControlPanel, setShowControlPanel] = useState(true);

  const {
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
    toggleLinkType,
    nodeColorFn,
    linkColorFn,
    recencyHeatFn,
    observationNodeSizeFn,
  } = useDataViewData({ factType, documentId, chunkId, initialQuery });

  const failure = error ? toHindsightFailure(error, t("dataView.loadFailed")) : null;

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

  // 展开 / 收起两个按钮共用的切换口径：调用方给了 `onExpandToggle` 就交给它（此时紧凑态由外层持有），
  // 否则切内部状态。此前两处 onClick 各写一份同样的判断，只有落点不同。
  const toggleCompactMode = (next: boolean) => {
    if (onExpandToggle) {
      onExpandToggle();
      return;
    }
    setCompactMode(next);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {loading && !data ? (
        <Spinner label={t("dataView.loadingMemories")} className="flex py-12" />
      ) : failure ? (
        <HindsightFailureNotice
          failure={failure}
          titleKey="dataView.loadFailed"
          retryKey="dataView.retry"
          onRetry={refreshData}
          className="py-16"
        />
      ) : !data ? (
        <EmptyState className="py-20" title={t("dataView.noDataAvailable")} />
      ) : data.table_rows?.length === 0 ? (
        /* 空状态 */
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm font-semibold text-foreground">{t("dataView.emptyTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("dataView.emptyHint")}</p>
          <img
            src="/images/memories-empty.webp"
            alt={t("dataView.emptyTitle")}
            className="w-[70%] max-w-full mt-6 mb-4 opacity-80"
          />
          <p className="text-xs text-muted-foreground">{t("dataView.emptyFooter")}</p>
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
                onClick={() => toggleCompactMode(false)}
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
                    onClick={() => toggleCompactMode(true)}
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
                    <DataViewControlPanel
                      viewMode={viewMode}
                      recencyBasis={recencyBasis}
                      onRecencyBasisChange={setRecencyBasis}
                      linkStats={linkStats}
                      onToggleLinkType={toggleLinkType}
                      nodeCount={graphData.nodes.length}
                      linkCount={graphData.links.length}
                    />
                  )
                }
              >
                {(height) =>
                  viewMode === "graph" ? (
                    <Graph2D
                      data={graphData}
                      height={height}
                      showLabels={showLabels}
                      onNodeClick={handleGraphNodeClick}
                      maxNodes={maxNodes}
                      nodeColorFn={nodeColorFn}
                      linkColorFn={linkColorFn}
                    />
                  ) : (
                    <Constellation
                      data={graphData}
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
                      heatLegendEndpoints={recencyEndpoints(recencyLookup)}
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
                data={graphData}
                height={300}
                onNodeClick={handleGraphNodeClick}
                nodeColorFn={nodeColorFn}
                linkColorFn={linkColorFn}
              />
            </div>
          )}

          {/* ── Table 视图 ── */}
          {!compactMode && viewMode === "table" && (
            <DataViewTable
              factType={factType}
              rows={tableRows}
              currentPage={currentPage}
              onPageChange={setCurrentPage}
              onRowClick={setModalMemoryId}
            />
          )}

          {/* ── Timeline 视图 ── */}
          {!compactMode && viewMode === "timeline" && (
            <div className="min-h-0 flex-1 overflow-auto">
              <DataViewTimeline _data={data} filteredRows={tableRows} onMemoryClick={(id) => setModalMemoryId(id)} />
            </div>
          )}
        </>
      )}

      {/* 内存详情弹窗 */}
      <MemoryDetailModal memoryId={modalMemoryId} onClose={() => setModalMemoryId(null)} />
    </div>
  );
}
