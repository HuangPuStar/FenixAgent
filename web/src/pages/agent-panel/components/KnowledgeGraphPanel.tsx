"use client";

import type { ElementDatum, IElementEvent } from "@antv/g6";
import { Graph } from "@antv/g6";
import { Loader2, Network, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { kbApi } from "@/src/api/knowledge-bases";
import { NS } from "@/src/i18n";
import type { KnowledgeGraphData, KnowledgeGraphProgress } from "@/src/types/knowledge";

interface KnowledgeGraphPanelProps {
  knowledgeBaseId: string;
}

const POLL_INTERVAL_MS = 3000;

/** tooltip 中不同元素类型的颜色 */
const TooltipColorMap: Record<string, string> = {
  node: "text-[#0f172a]",
  edge: "text-[#6366f1]",
};

export function KnowledgeGraphPanel({ knowledgeBaseId }: KnowledgeGraphPanelProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const tooltipId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);

  const [graphData, setGraphData] = useState<KnowledgeGraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<KnowledgeGraphProgress | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchGraph = useCallback(async () => {
    try {
      setGraphLoading(true);
      const resp = await kbApi.getGraph({ id: knowledgeBaseId });
      setGraphData(resp.data ?? null);
    } catch {
      // 图谱不存在时不显示错误
    } finally {
      setGraphLoading(false);
    }
  }, [knowledgeBaseId]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // 构建并渲染 G6 力导向图
  const renderGraph = useCallback(() => {
    if (!containerRef.current || !graphData) return;

    const { nodes, edges } = graphData.graph;

    // ── 预计算每个节点的度数（连接数），用于按重要性分层渲染 ──
    const degreeMap = new Map<string, number>();
    for (const n of nodes) degreeMap.set(n.id, 0);
    for (const e of edges) {
      degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
      degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
    }

    // 度数降序排列，取前 30% 作为"需要显示标签的 hub 节点"
    const sortedDegs = [...degreeMap.values()].sort((a, b) => b - a);
    const labelDegThreshold = Math.max(3, sortedDegs[Math.floor(sortedDegs.length * 0.3)] ?? 3);

    // 节点尺寸：基于度数，hub 节点大（带标签），边缘节点小（仅圆点）
    const nodeSize = (d: Record<string, unknown>) => {
      const deg = degreeMap.get((d.id as string) ?? "") ?? 0;
      return 40 + Math.min(deg * 22, 180); // 范围 40 ~ 220
    };
    const getMaxSize = (node: Record<string, unknown>) => nodeSize(node);

    const graph = new Graph({
      container: containerRef.current,
      autoFit: "view",
      autoResize: true,
      behaviors: [
        "drag-element",
        "drag-canvas",
        "zoom-canvas",
        {
          type: "hover-activate",
          degree: 1, // 悬停高亮一度关联节点
        },
      ],
      plugins: [
        {
          type: "tooltip",
          enterable: true,
          getContent: (e: IElementEvent, items: ElementDatum) => {
            if (!Array.isArray(items)) return;

            return items
              .flatMap((item) => {
                const colorCls = TooltipColorMap[e.targetType as string] ?? "text-[#0f172a]";
                const title = (item?.name as string) || (item?.id as string) || "";
                const et = (item?.entity_type as string) || "";
                const w = item?.weight as number | undefined;
                const desc = (item?.description as string) || "";

                return [
                  "<div ",
                  `id="${tooltipId}"`,
                  `aria-label="${item?.id}"`,
                  'role="tooltip"',
                  `class="${colorCls}"`,
                  'style="max-width:320px"',
                  ">",
                  `<h3 style="font-weight:600;font-size:13px;margin-bottom:4px">${title}</h3>`,
                  '<dl style="margin-bottom:4px;font-size:12px">',
                  ...(et
                    ? [
                        '<div style="display:flex;align-items:center;gap:0.5ch">',
                        "<dt><b>Entity type: </b></dt>",
                        `<dd>${et}</dd>`,
                        "</div>",
                      ]
                    : []),
                  ...(w != null
                    ? [
                        '<div style="display:flex;align-items:center;gap:0.5ch">',
                        "<dt><b>Weight: </b></dt>",
                        `<dd>${w}</dd>`,
                        "</div>",
                      ]
                    : []),
                  "</dl>",
                  ...(desc ? [`<p style="font-size:11px;color:#64748b;line-height:1.5">${desc}</p>`] : []),
                  "</div>",
                ];
              })
              .join("");
          },
        },
      ],
      layout: {
        type: "force",
        preventOverlap: true,
        nodeSize: getMaxSize as unknown as number,
        // 节点数多时降低引力、增加排斥力，让图更分散
        gravity: nodes.length > 100 ? 0.3 : 0.8,
        factor: nodes.length > 100 ? 8 : 4,
        linkDistance: (_edge: unknown, source: unknown, target: unknown) => {
          const sourceSize = getMaxSize(source as Record<string, unknown>);
          const targetSize = getMaxSize(target as Record<string, unknown>);
          return sourceSize / 2 + targetSize / 2 + 150;
        },
      },
      node: {
        style: {
          size: (d: Record<string, unknown>) => nodeSize(d),
          // 仅 hub 节点（度数 >= 阈值）显示标签，避免大图标签糊成一团
          labelText: (d: Record<string, unknown>) => {
            const deg = degreeMap.get((d.id as string) ?? "") ?? 0;
            if (deg < labelDegThreshold) return "";
            return (d.name as string) || (d.id as string) || "";
          },
          // 标签字号与节点尺寸成比例，保证缩放后仍可读
          labelFontSize: (d: Record<string, unknown>) => Math.max(10, nodeSize(d) * 0.14),
          labelFill: "#1e293b",
          labelPlacement: "bottom",
          labelOffsetY: 4,
          labelWordWrap: true,
          labelMaxWidth: "250%",
          // 标签底色：白底圆角，防止与边线/节点重叠时不可读
          labelBackground: true,
          labelBackgroundFill: "#ffffff",
          labelBackgroundFillOpacity: 0.92,
          labelBackgroundRadius: 4,
          labelBackgroundLineWidth: 1,
          labelBackgroundStroke: "#e2e8f0",
          // 高亮态样式
          labelActiveFill: "#6366f1",
          labelActiveBackgroundFill: "#eef2ff",
        },
        palette: {
          type: "group",
          field: (d: Record<string, unknown>) => (d?.entity_type as string) || "default",
        },
      },
      edge: {
        style: (model: Record<string, unknown>) => {
          const weight: number = Number(model?.weight) || 2;
          return {
            stroke: "rgba(100,116,139,0.3)",
            lineDash: [8, 8],
            lineWidth: Math.min(weight * 3, 6),
          };
        },
      },
    });

    // 销毁旧图再创建新图
    if (graphRef.current) {
      graphRef.current.destroy();
    }
    graphRef.current = graph;

    // G6 v5 的 setData 需要 NodeData/EdgeData，这里做类型转换
    graph.setData({ nodes: nodes as never, edges: edges as never });
    graph.render();

    // 力导向布局是异步迭代的，autoFit 在渲染瞬间执行时坐标还在原点附近，
    // 导致初始视图要么太放大（一坨）要么偏离中心。等布局收敛后再 fitView，
    // 并留 padding，保证初始视图合理且不撑爆画布。
    const fitOnce = () => {
      try {
        graph.fitView({ when: "always" }, false);
      } catch {
        // 忽略：节点尚未就位时 fitView 可能抛错
      }
    };
    graph.once("afterlayout", fitOnce);
    // 兜底：如果 afterlayout 未触发（极小图），延迟再 fit 一次
    const fallbackTimer = setTimeout(fitOnce, 2500);
    graphOnceCleanupRef.current = () => clearTimeout(fallbackTimer);
  }, [graphData, tooltipId]);

  // 存储 fitOnce 兜底定时器的清理函数
  const graphOnceCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (graphData) {
      renderGraph();
    }
    return () => {
      if (graphOnceCleanupRef.current) {
        graphOnceCleanupRef.current();
        graphOnceCleanupRef.current = null;
      }
      if (graphRef.current) {
        graphRef.current.destroy();
        graphRef.current = null;
      }
    };
  }, [graphData, renderGraph]);

  const handleGenerate = useCallback(async () => {
    try {
      setGenerating(true);
      setProgress({ progress: 0 });
      await kbApi.generateGraph({ id: knowledgeBaseId });

      pollRef.current = setInterval(async () => {
        try {
          const resp = await kbApi.getGraphProgress({ id: knowledgeBaseId });
          if (resp.success && resp.data) {
            setProgress(resp.data);
            if (resp.data.progress >= 1) {
              if (pollRef.current) clearInterval(pollRef.current);
              pollRef.current = null;
              setGenerating(false);
              setProgress(null);
              await fetchGraph();
              toast.success(t("graph.generateSuccess"));
            }
          }
        } catch {
          // 轮询失败静默处理
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      console.error("[KnowledgeGraphPanel] generate failed", err);
      toast.error(t("graph.generateFailed"));
      setGenerating(false);
      setProgress(null);
    }
  }, [knowledgeBaseId, fetchGraph, t]);

  const handleDelete = useCallback(async () => {
    try {
      await kbApi.deleteGraph({ id: knowledgeBaseId });
      setGraphData(null);
      setDeleteConfirmOpen(false);
      toast.success(t("graph.deleteSuccess"));
    } catch (err) {
      console.error("[KnowledgeGraphPanel] delete failed", err);
      toast.error(t("graph.deleteFailed"));
    }
  }, [knowledgeBaseId, t]);

  const nodeCount = graphData?.graph.nodes?.length ?? 0;
  const edgeCount = graphData?.graph.edges?.length ?? 0;

  return (
    <div className="space-y-5">
      {/* 操作按钮行 */}
      <div className="flex items-center gap-2.5">
        {graphData && (
          <Button
            variant="outline"
            size="sm"
            className="text-[12px] h-8 rounded-lg border-[#e2e8f0] hover:border-red-300 hover:text-red-500 hover:bg-red-50 transition-all duration-150"
            onClick={() => setDeleteConfirmOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            {t("graph.delete")}
          </Button>
        )}
        <Button
          size="sm"
          className="text-[12px] h-8 rounded-lg shadow-md shadow-[#6366f1]/20 bg-[#6366f1] hover:bg-[#5558e6] transition-all duration-150"
          onClick={handleGenerate}
          disabled={generating}
        >
          {generating ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
          )}
          {generating ? t("graph.generating") : t("graph.generate")}
        </Button>
      </div>

      {/* 进度条 */}
      {generating && progress && (
        <div className="space-y-2.5 rounded-xl bg-[#f8fafc] border border-[#eef2f6] p-4">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-[#64748b]">{t("graph.generating")}...</span>
            <span className="font-bold text-[#6366f1] tabular-nums">{Math.round(progress.progress * 100)}%</span>
          </div>
          <div className="h-2 rounded-full bg-[#e2e8f0] overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#6366f1] to-[#8b5cf6] shadow-[0_0_10px_rgba(99,102,241,0.35)] transition-all duration-500"
              style={{ width: `${Math.round(progress.progress * 100)}%` }}
            />
          </div>
          {progress.progressMsg && <p className="text-[11px] text-[#94a3b8] truncate">{progress.progressMsg}</p>}
        </div>
      )}

      {/* 加载态 */}
      {graphLoading && (
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="flex flex-col items-center gap-3">
            <div className="h-10 w-10 rounded-full border-[3px] border-[#e2e8f0] border-t-[#6366f1] animate-spin" />
            <p className="text-[13px] text-[#94a3b8]">Loading graph...</p>
          </div>
        </div>
      )}

      {/* 空态 */}
      {!graphLoading && !graphData && !generating && (
        <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 rounded-xl bg-[#f8fafc] border border-[#eef2f6]">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-[#f1f5f9] to-[#e2e8f0] shadow-inner">
            <Network className="h-9 w-9 text-[#94a3b8]" />
          </div>
          <p className="text-[14px] font-medium text-[#64748b]">{t("graph.empty")}</p>
          <p className="text-[12px] text-[#94a3b8] -mt-1">{t("graph.emptyHint")}</p>
        </div>
      )}

      {/* G6 力导向图 */}
      {!graphLoading && graphData && nodeCount > 0 && (
        <div className="rounded-xl bg-white border border-[#eef2f6] overflow-hidden shadow-sm">
          {/* 顶栏：节点/边计数 + 操作提示 */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#eef2f6] bg-[#fafbfc]">
            <div className="flex items-center gap-4 text-[12px] text-[#64748b]">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#6366f1]" />
                {t("graph.nodes")}: {nodeCount}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-4 rounded bg-[#94a3b8]" />
                {t("graph.edges")}: {edgeCount}
              </span>
            </div>
            <span className="text-[11px] text-[#94a3b8]">{t("graph.networkHint")}</span>
          </div>
          {/* G6 画布 */}
          <div ref={containerRef} className="w-full" style={{ height: "560px" }}>
            {/* tooltip 的基础样式 — 由 G6 动态插入的 tooltip 元素使用 */}
            <style>{`
              .g6-tooltip {
                padding: 10px 14px !important;
                border-radius: 10px !important;
                font-family: system-ui, -apple-system, sans-serif !important;
                font-size: 12px !important;
                background: #fff !important;
                box-shadow: 0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06) !important;
                border: 1px solid #e8edf4 !important;
                max-width: 360px !important;
                line-height: 1.5 !important;
              }
            `}</style>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("graph.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("graph.deleteConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <Button variant="destructive" onClick={handleDelete}>
              {t("graph.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
