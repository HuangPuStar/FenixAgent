/**
 * `Graph2d` —— 关系图谱的 cytoscape 渲染壳（§4.8 中两套刻意分叉的图谱之一）。
 *
 * 本文件只负责渲染：样式化容器 + 加载态 / 空态 + 链接 tooltip + 操作提示。
 * 数据整形在 `graph2d-model.ts`，共用数据形状与 API 转换在 `graph-model.ts`，
 * 实例生命周期与交互在 `use-cytoscape-graph.ts`。图形逻辑不与 `Constellation`（自绘 canvas）
 * 归一——两者的渲染模型不同，抽公共层只会得到一层薄转发（已裁定，见前端规范 §4.8）。
 */

import { Spinner } from "@fenix/ui-components/ui/spinner";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useTranslation } from "react-i18next";
import type { GraphData, GraphLink, GraphNode } from "./graph-model";
import { isCausalLinkType } from "./graph-model";
import { useCytoscapeGraph } from "./use-cytoscape-graph";

export interface Graph2DProps {
  data: GraphData;
  height?: number;
  showLabels?: boolean;
  onNodeClick?: (node: GraphNode) => void;
  onNodeHover?: (node: GraphNode | null) => void;
  nodeColorFn?: (node: GraphNode) => string;
  nodeSizeFn?: (node: GraphNode) => number;
  linkColorFn?: (link: GraphLink) => string;
  linkWidthFn?: (link: GraphLink) => number;
  maxNodes?: number;
}

export function Graph2D({
  data,
  height = 600,
  showLabels = true,
  onNodeClick,
  onNodeHover,
  nodeColorFn,
  nodeSizeFn,
  linkColorFn,
  linkWidthFn,
  maxNodes,
}: Graph2DProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const { containerRef, isMounted, isLoading, isDarkMode, nodeCount, hoveredLink, linkTooltipPos } = useCytoscapeGraph({
    data,
    showLabels,
    maxNodes,
    onNodeClick,
    onNodeHover,
    nodeColorFn,
    nodeSizeFn,
    linkColorFn,
    linkWidthFn,
  });

  return (
    <div className="relative w-full rounded-lg overflow-hidden border border-border" style={{ height }}>
      {/* Loading state */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
          <Spinner label={t("graph2d.loading")} />
        </div>
      )}

      {/* Cytoscape container */}
      {isMounted && (
        <div
          ref={containerRef}
          className="w-full h-full"
          style={{
            backgroundImage: isDarkMode
              ? "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.08) 1px, transparent 0)"
              : "radial-gradient(circle at 1px 1px, rgba(0,0,0,0.06) 1px, transparent 0)",
            backgroundSize: "20px 20px",
            backgroundColor: isDarkMode ? "#0f1419" : "#f8fafc",
          }}
        />
      )}

      {/* Empty state */}
      {!isLoading && nodeCount === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <p className="text-muted-foreground">{t("graph2d.emptyState")}</p>
          </div>
        </div>
      )}

      {/* Link hover tooltip */}
      {hoveredLink && linkTooltipPos && (
        <div
          className="absolute z-30 pointer-events-none"
          style={{
            left: linkTooltipPos.x,
            top: linkTooltipPos.y,
            transform: "translate(-50%, -100%) translateY(-8px)",
          }}
        >
          <div
            className={`px-3 py-2 rounded-lg shadow-lg text-sm ${
              isDarkMode ? "bg-gray-800 text-white" : "bg-white text-gray-900 border border-gray-200"
            }`}
          >
            <div className="font-medium capitalize mb-1">
              {(() => {
                const type = hoveredLink.type || "semantic";
                if (isCausalLinkType(type)) {
                  return t("graph2d.linkTypeCausal", { type: type.replace("_", " ") });
                }
                return t("graph2d.linkTypeGeneric", { type });
              })()}
            </div>
            {hoveredLink.entity && (
              <div className="text-xs opacity-80">
                {t("graph2d.linkTooltipEntity")} <span className="font-medium">{hoveredLink.entity}</span>
              </div>
            )}
            {hoveredLink.weight !== undefined && (
              <div className="text-xs opacity-80">
                {t("graph2d.linkTooltipWeight")} <span className="font-medium">{hoveredLink.weight.toFixed(3)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Controls hint */}
      <div className="absolute bottom-4 right-4 text-xs text-muted-foreground/60 z-20">{t("graph2d.controlsHint")}</div>
    </div>
  );
}
