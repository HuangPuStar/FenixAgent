import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { List, ScatterChart, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { hindsightApi } from "../../../api/hindsight";
import { useElementHeight } from "../element-height";
import { toHindsightFailure } from "../failure";
import { recencyEndpoints, recencyHeat, toRecencyLookup } from "../recency";
import { Constellation } from "./Constellation";
import { convertHindsightGraphData, type GraphNode } from "./Graph2d";
import { HindsightFailureNotice } from "./HindsightFailureNotice";
import { MemoryPagination } from "./MemoryPagination";
import { MemoryViewSwitcher } from "./MemoryViewSwitcher";

type ViewMode = "relations" | "list";

const ITEMS_PER_PAGE = 50;

export function EntitiesView() {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("relations");
  const graphPaneRef = useRef<HTMLDivElement>(null);
  const graphHeight = useElementHeight(graphPaneRef);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const offset = (currentPage - 1) * ITEMS_PER_PAGE;

  /** 实体列表取数：页码变化即重查（`refreshDeps`），不再手写 `loadEntities(newPage)`。 */
  const {
    data: entitiesPage,
    loading,
    error: entitiesError,
    refresh: refreshEntities,
  } = useRequest(() => hindsightApi.listEntities({ limit: ITEMS_PER_PAGE, offset }), {
    refreshDeps: [currentPage],
    onError: (error) => console.error("Failed to load entities:", error),
  });
  const entities = entitiesPage && Array.isArray(entitiesPage.items) ? entitiesPage.items : [];
  const total = entitiesPage?.total || 0;
  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
  const entitiesFailure = entitiesError ? toHindsightFailure(entitiesError) : null;

  /**
   * 实体详情按需取数（`manual`）。失败时把 `selectedEntity` 置空（下面的派生），避免把上一条实体的
   * 详情挂在新的标题下——与改造前失败路径里的 `setSelectedEntity(null)` 同形。
   */
  const {
    data: loadedEntity,
    loading: loadingDetail,
    error: detailError,
    run: runLoadEntityDetail,
  } = useRequest((entityId: string) => hindsightApi.getEntity(entityId), {
    manual: true,
    onError: (error) => console.error("Failed to load entity detail:", error),
  });
  const selectedEntity = detailError || selectedEntityId === null ? null : (loadedEntity ?? null);
  const detailFailure = detailError ? toHindsightFailure(detailError) : null;

  /**
   * 图谱取数：关系视图才需要它，故用 `ready` 做条件请求（与 `MountSiteDialog` 的 `ready: open` 同形），
   * 失败时由失败块的重试入口重新发起。注意 `ready` 是「此刻该不该请求」而非「取过一次就缓存住」：
   * 切到列表再切回关系视图会重新取一次（图谱本就是随时间变化的快照，刷新得到的是更近的数据）。
   */
  const {
    data: loadedGraph,
    loading: graphLoading,
    error: graphError,
    refresh: refreshGraph,
  } = useRequest(() => hindsightApi.getEntityGraph({ limit: 2000, min_count: 1 }), {
    ready: viewMode === "relations",
    onError: (error) => console.error("Failed to load entity graph:", error),
  });
  const graphData = graphError ? null : (loadedGraph ?? null);
  const graphFailure = graphError ? toHindsightFailure(graphError) : null;

  /** 打开实体详情：记录「当前打开的是哪一条」，再触发详情请求。 */
  const openEntityDetail = useCallback(
    (entityId: string) => {
      setSelectedEntityId(entityId);
      runLoadEntityDetail(entityId);
    },
    [runLoadEntityDetail],
  );

  // Handle page change
  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
  };

  const constellationData = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };
    return convertHindsightGraphData(graphData);
  }, [graphData]);

  // Sum co-occurrence counts (edge weights) per entity, then map to a dot
  // radius. Log scaling keeps hubs big without letting them dwarf everything.
  const nodeWeights = useMemo(() => {
    const weights = new Map<string, number>();
    for (const link of constellationData.links) {
      const w = typeof link.weight === "number" && link.weight > 0 ? link.weight : 1;
      weights.set(link.source, (weights.get(link.source) || 0) + w);
      weights.set(link.target, (weights.get(link.target) || 0) + w);
    }
    return weights;
  }, [constellationData]);

  const maxNodeWeight = useMemo(() => {
    let max = 1;
    for (const w of nodeWeights.values()) if (w > max) max = w;
    return max;
  }, [nodeWeights]);

  const nodeSizeFn = useCallback(
    (node: GraphNode) => {
      const w = nodeWeights.get(node.id) || 0;
      // 3px (isolated) → 14px (the hub); sqrt flattens the long tail.
      const t = Math.sqrt(w / maxNodeWeight);
      return 3 + t * 11;
    },
    [nodeWeights, maxNodeWeight],
  );

  // Recency heat per entity — the most recent co-occurrence across any of its
  // edges. Lets color encode "fresh vs stale" while size encodes co-occurrence
  // volume, so the two axes stay orthogonal.
  const recencyLookup = useMemo(() => {
    const edges = graphData?.edges || [];
    if (!edges.length) return null;
    const times = new Map<string, number>();
    let minT = Infinity;
    let maxT = -Infinity;
    for (const e of edges) {
      const iso = e.data.lastCooccurred;
      if (!iso) continue;
      const t = Date.parse(iso);
      if (Number.isNaN(t)) continue;
      for (const id of [e.data.source, e.data.target]) {
        const prev = times.get(id);
        if (prev === undefined || t > prev) times.set(id, t);
      }
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    return toRecencyLookup(times, minT, maxT);
  }, [graphData]);

  const nodeHeatFn = useCallback((node: GraphNode) => recencyHeat(recencyLookup, node.id), [recencyLookup]);

  const handleConstellationNodeClick = useCallback(
    (node: GraphNode) => {
      openEntityDetail(node.id);
    },
    [openEntityDetail],
  );

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return t("entitiesView.na");
    return new Date(dateStr).toLocaleDateString();
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {/* View mode toggle — same segmented control as memories page */}
      <div className="mb-4 flex shrink-0 items-center justify-end">
        <MemoryViewSwitcher
          value={viewMode}
          onValueChange={setViewMode}
          ariaLabel={t("entitiesView.viewSwitcher")}
          options={[
            { value: "relations", icon: ScatterChart, label: t("entitiesView.viewRelations") },
            { value: "list", icon: List, label: t("entitiesView.viewList") },
          ]}
        />
      </div>

      {viewMode === "relations" && (
        <div ref={graphPaneRef} className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          {graphLoading ? (
            <Spinner variant="panel" className="py-20" label={t("entitiesView.loadingEntityGraph")} />
          ) : graphFailure ? (
            <HindsightFailureNotice
              failure={graphFailure}
              titleKey="entitiesView.graphLoadFailed"
              retryKey="entitiesView.retry"
              onRetry={refreshGraph}
              className="py-20"
            />
          ) : constellationData.nodes.length > 0 ? (
            <Constellation
              data={constellationData}
              height={graphHeight}
              onNodeClick={handleConstellationNodeClick}
              nodeSizeFn={nodeSizeFn}
              nodeHeatFn={recencyLookup ? nodeHeatFn : undefined}
              heatLegendLabel={recencyLookup ? t("entitiesView.heatLegendLabel") : undefined}
              heatLegendEndpoints={recencyEndpoints(recencyLookup)}
              sizeLegendLabel={t("entitiesView.sizeLegendLabel")}
              compactLabels
            />
          ) : (
            <EmptyState
              className="py-20"
              title={t("entitiesView.noCooccurrences")}
              description={t("entitiesView.noCooccurrencesDescription")}
            />
          )}
        </div>
      )}

      {/* Entity List */}
      {viewMode === "list" && (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {loading ? (
            <Spinner variant="panel" className="py-20" label={t("entitiesView.loadingEntities")} />
          ) : entitiesFailure ? (
            <HindsightFailureNotice
              failure={entitiesFailure}
              titleKey="entitiesView.listLoadFailed"
              retryKey="entitiesView.retry"
              onRetry={refreshEntities}
              className="py-20"
            />
          ) : entities.length > 0 ? (
            <>
              <div className="mb-4 text-sm text-muted-foreground">
                {t("entitiesView.entityCount", { count: total })}
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("entitiesView.colName")}</TableHead>
                      <TableHead>{t("entitiesView.colMentions")}</TableHead>
                      <TableHead>{t("entitiesView.colFirstSeen")}</TableHead>
                      <TableHead>{t("entitiesView.colLastSeen")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entities.map((entity) => (
                      <TableRow
                        key={entity.id}
                        onClick={() => openEntityDetail(entity.id)}
                        className={`cursor-pointer hover:bg-muted/50 ${
                          selectedEntity?.id === entity.id ? "bg-primary/10" : ""
                        }`}
                      >
                        <TableCell className="font-medium text-card-foreground">{entity.canonical_name}</TableCell>
                        <TableCell className="text-card-foreground">{entity.mention_count}</TableCell>
                        <TableCell className="text-card-foreground">{formatDate(entity.first_seen)}</TableCell>
                        <TableCell className="text-card-foreground">{formatDate(entity.last_seen)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination Controls */}
              <MemoryPagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={handlePageChange}
                rangeLabel={`${offset + 1}-${Math.min(offset + ITEMS_PER_PAGE, total)} ${t("entitiesView.of")} ${total}`}
                disabled={loading}
              />
            </>
          ) : (
            <EmptyState
              className="py-20"
              title={t("entitiesView.noEntitiesFound")}
              description={t("entitiesView.noEntitiesDescription")}
            />
          )}
        </div>
      )}

      {selectedEntityId && (loadingDetail || detailFailure) && (
        <div
          className="fixed right-4 top-4 z-50 flex w-80 flex-col items-center gap-3 rounded-lg border bg-card p-5 text-center shadow-lg"
          role={detailFailure ? "alert" : "status"}
        >
          {detailFailure ? (
            <HindsightFailureNotice
              failure={detailFailure}
              titleKey="entitiesView.detailLoadFailed"
              retryKey="entitiesView.retry"
              onRetry={() => runLoadEntityDetail(selectedEntityId)}
              className="py-0"
            />
          ) : (
            <>
              <Spinner />
              <p className="text-sm font-medium">{t("entitiesView.loadingEntityDetail")}</p>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => setSelectedEntityId(null)}>
            {t("entitiesView.close")}
          </Button>
        </div>
      )}

      {/* Entity Detail Panel - Fixed overlay */}
      {selectedEntity && (
        <div className="fixed right-0 top-0 h-screen w-105 bg-card border-l-2 border-primary shadow-2xl z-50 overflow-y-auto animate-in slide-in-from-right duration-300 ease-out">
          <div className="p-5">
            {/* Header */}
            <div className="flex justify-between items-center mb-6 pb-4 border-b border-border">
              <div>
                <h3 className="text-xl font-bold text-card-foreground">{selectedEntity.canonical_name}</h3>
                <p className="text-sm text-muted-foreground mt-1">{t("entitiesView.entityDetails")}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelectedEntityId(null)} className="h-8 w-8 p-0">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-5">
              {/* Entity Info */}
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                    {t("entitiesView.mentionsLabel")}
                  </div>
                  <div className="text-lg font-semibold text-card-foreground">{selectedEntity.mention_count}</div>
                </div>
                <div className="p-4 bg-muted/50 rounded-lg">
                  <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                    {t("entitiesView.firstSeenLabel")}
                  </div>
                  <div className="text-sm font-medium text-card-foreground">
                    {formatDate(selectedEntity.first_seen)}
                  </div>
                </div>
              </div>

              {/* ID */}
              <div className="p-4 bg-muted/50 rounded-lg">
                <div className="text-xs font-bold text-muted-foreground uppercase mb-2">
                  {t("entitiesView.entityIdLabel")}
                </div>
                <code className="text-xs font-mono break-all text-muted-foreground">{selectedEntity.id}</code>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
