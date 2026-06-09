import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, List, ScatterChart } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { hindsightApi } from "@/src/api/hindsight";
import { NS } from "@/src/i18n";
import type { EntityGraphResponse, EntityItem } from "../types";
import { Constellation } from "./Constellation";
import { convertHindsightGraphData, type GraphNode } from "./Graph2d";

type ViewMode = "relations" | "list";

const ITEMS_PER_PAGE = 50;

export function EntitiesView() {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [entities, setEntities] = useState<EntityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState<EntityItem | null>(null);
  const [_loadingDetail, setLoadingDetail] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("relations");
  const [graphData, setGraphData] = useState<EntityGraphResponse | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [total, setTotal] = useState(0);

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
  const offset = (currentPage - 1) * ITEMS_PER_PAGE;

  const loadEntities = useCallback(async (page: number = 1) => {
    setLoading(true);
    try {
      const pageOffset = (page - 1) * ITEMS_PER_PAGE;
      const result = await hindsightApi.listEntities({
        limit: ITEMS_PER_PAGE,
        offset: pageOffset,
      });
      setEntities(result.items || []);
      setTotal(result.total || 0);
    } catch (error) {
      console.error("Failed to load entities:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEntityDetail = useCallback(async (entityId: string) => {
    setLoadingDetail(true);
    try {
      const result = await hindsightApi.getEntity(entityId);
      setSelectedEntity(result);
    } catch (error) {
      console.error("Failed to load entity detail:", error);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  // Handle page change
  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
    loadEntities(newPage);
  };

  const loadGraph = useCallback(async () => {
    setGraphLoading(true);
    try {
      const result = await hindsightApi.getEntityGraph({
        limit: 2000,
        min_count: 1,
      });
      setGraphData(result);
    } catch (error) {
      console.error("Failed to load entity graph:", error);
    } finally {
      setGraphLoading(false);
    }
  }, []);

  useEffect(() => {
    setCurrentPage(1);
    loadEntities(1);
    setSelectedEntity(null);
    // 仅挂载时执行一次；不重置 graphData，由第二个 effect 自行管理
    // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时执行
  }, []);

  useEffect(() => {
    if (viewMode === "relations" && !graphData && !graphLoading) {
      loadGraph();
    }
  }, [viewMode, graphData, graphLoading, loadGraph]);

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
    if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT === minT) return null;
    return { times, minT, maxT };
  }, [graphData]);

  const nodeHeatFn = useCallback(
    (node: GraphNode) => {
      if (!recencyLookup) return 0.5;
      const t = recencyLookup.times.get(node.id);
      if (t === undefined) return 0;
      return (t - recencyLookup.minT) / (recencyLookup.maxT - recencyLookup.minT);
    },
    [recencyLookup],
  );

  const handleConstellationNodeClick = useCallback(
    (node: GraphNode) => {
      loadEntityDetail(node.id);
    },
    [loadEntityDetail],
  );

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return t("entitiesView.na");
    return new Date(dateStr).toLocaleDateString();
  };

  return (
    <div>
      {/* View mode toggle — same segmented control as memories page */}
      <div className="mb-4 flex items-center justify-end">
        <div className="flex items-center gap-2 bg-muted rounded-lg p-1">
          <button
            onClick={() => setViewMode("relations")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${
              viewMode === "relations"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <ScatterChart className="w-4 h-4" />
            {t("entitiesView.viewRelations")}
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${
              viewMode === "list"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <List className="w-4 h-4" />
            {t("entitiesView.viewList")}
          </button>
        </div>
      </div>

      {viewMode === "relations" && (
        <div className="border border-border rounded-lg overflow-hidden">
          {graphLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="text-center">
                <div className="text-4xl mb-2">...</div>
                <div className="text-sm text-muted-foreground">{t("entitiesView.loadingEntityGraph")}</div>
              </div>
            </div>
          ) : constellationData.nodes.length > 0 ? (
            <Constellation
              data={constellationData}
              height={700}
              onNodeClick={handleConstellationNodeClick}
              nodeSizeFn={nodeSizeFn}
              nodeHeatFn={recencyLookup ? nodeHeatFn : undefined}
              heatLegendLabel={recencyLookup ? t("entitiesView.heatLegendLabel") : undefined}
              heatLegendEndpoints={
                recencyLookup
                  ? [
                      new Date(recencyLookup.minT).toISOString().slice(0, 10),
                      new Date(recencyLookup.maxT).toISOString().slice(0, 10),
                    ]
                  : undefined
              }
              sizeLegendLabel={t("entitiesView.sizeLegendLabel")}
              compactLabels
            />
          ) : (
            <div className="flex items-center justify-center py-20">
              <div className="text-center">
                <div className="text-sm text-muted-foreground">{t("entitiesView.noCooccurrences")}</div>
                <div className="text-xs text-muted-foreground mt-1">{t("entitiesView.noCooccurrencesDescription")}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Entity List */}
      {viewMode === "list" && (
        <div>
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="text-center">
                <div className="text-4xl mb-2">...</div>
                <div className="text-sm text-muted-foreground">{t("entitiesView.loadingEntities")}</div>
              </div>
            </div>
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
                        onClick={() => loadEntityDetail(entity.id)}
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
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-3 pt-3 border-t">
                  <div className="text-xs text-muted-foreground">
                    {offset + 1}-{Math.min(offset + ITEMS_PER_PAGE, total)} of {total}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(1)}
                      disabled={currentPage === 1 || loading}
                      className="h-7 w-7 p-0"
                    >
                      <ChevronsLeft className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(currentPage - 1)}
                      disabled={currentPage === 1 || loading}
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
                      onClick={() => handlePageChange(currentPage + 1)}
                      disabled={currentPage === totalPages || loading}
                      className="h-7 w-7 p-0"
                    >
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(totalPages)}
                      disabled={currentPage === totalPages || loading}
                      className="h-7 w-7 p-0"
                    >
                      <ChevronsRight className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center py-20">
              <div className="text-center">
                <div className="text-4xl mb-2">...</div>
                <div className="text-sm text-muted-foreground">{t("entitiesView.noEntitiesFound")}</div>
                <div className="text-xs text-muted-foreground mt-1">{t("entitiesView.noEntitiesDescription")}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Entity Detail Panel - Fixed overlay */}
      {selectedEntity && (
        <div className="fixed right-0 top-0 h-screen w-[420px] bg-card border-l-2 border-primary shadow-2xl z-50 overflow-y-auto animate-in slide-in-from-right duration-300 ease-out">
          <div className="p-5">
            {/* Header */}
            <div className="flex justify-between items-center mb-6 pb-4 border-b border-border">
              <div>
                <h3 className="text-xl font-bold text-card-foreground">{selectedEntity.canonical_name}</h3>
                <p className="text-sm text-muted-foreground mt-1">{t("entitiesView.entityDetails")}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelectedEntity(null)} className="h-8 w-8 p-0">
                <span className="text-lg">x</span>
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
