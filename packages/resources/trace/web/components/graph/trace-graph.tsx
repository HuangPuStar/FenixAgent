/**
 * 调用图主体：泳道 + 连线 + 事件行（移植自 langfuse-lite 的
 * `shared/components/observation-trace-graph.tsx`）。
 *
 * 移植差异：
 * 1. **纯 props 驱动**：参考实现的图由 `use-trace-graph-observations` 经 react-query 按分支懒加载补全观测，
 *    本包首版由调用方（artifacts 面板壳）传入整条 trace 的观测，图内不取数、不依赖路由，也不持有缓存。
 * 2. 去掉与产品其余部分耦合的东西：全屏 Dialog、书签、Score 列表（节点详情由面板壳另行装配），因此不再引入
 *    `@radix-ui/react-dialog`。
 * 3. 选中态语义由调用方决定：`selectedId === undefined` 表示当前没有选中项，`null` 表示选中 trace 本身
 *    （图上没有对应节点，因此不高亮任何行）；图只负责高亮匹配项并回传被点击的观测 id。
 * 4. 样式 token 换成本项目主题（`var(--surface-raised)` → `var(--color-surface-1)`、
 *    `var(--brand)` → `var(--color-brand)`），文案走 `t()`。
 */
import { cn } from "@fenix/ui-components/lib/cn";
import { ArrowDown, GitBranch } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TRACE_NS } from "../../i18n/namespace";
import { buildTraceGraphDisplay, type TraceGraphDisplayRow } from "../../lib/graph/trace-graph-display-layout";
import { buildTraceGraph, type TraceGraphEdge, type TraceGraphNode } from "../../lib/graph/trace-graph-layout";
import type { TraceObservation } from "../../lib/observation-types";
import { TRACE_GRAPH_COLUMNS, TraceGraphRow, traceGraphTypeColor } from "./trace-graph-rows";

const LANE_WIDTH = 16;
const GRAPH_PADDING = 14;
const LANE_COLORS = ["var(--color-brand)", "#a879e8", "#2bb9a6", "#e2a146", "#e279a4", "#64a8e5"];

const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
const laneX = (lane: number) => GRAPH_PADDING + lane * LANE_WIDTH;
const rowY = (rows: TraceGraphDisplayRow[], row: number) => rows[row].top + rows[row].height / 2;

function edgePath(edge: TraceGraphEdge, rows: TraceGraphDisplayRow[]): string {
  const x1 = laneX(edge.from.lane);
  const y1 = rowY(rows, edge.from.row);
  const x2 = laneX(edge.to.lane);
  const y2 = rowY(rows, edge.to.row);
  if (x1 === x2) return `M ${x1} ${y1} V ${y2}`;
  const middleY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${middleY}, ${x2} ${middleY}, ${x2} ${y2}`;
}

function GraphPoint({ node, lane, y, selected }: { node: TraceGraphNode; lane: number; y: number; selected: boolean }) {
  const x = laneX(lane);
  const color = "currentColor";
  return (
    <g data-graph-node={node.kind} className={traceGraphTypeColor(node)}>
      {selected && <circle cx={x} cy={y} r={8} fill={color} opacity={0.16} />}
      <circle cx={x} cy={y} r={6} fill="var(--color-surface-1)" />
      {node.kind === "tool" ? (
        <rect
          x={x - 3.5}
          y={y - 3.5}
          width={7}
          height={7}
          rx={1}
          transform={`rotate(45 ${x} ${y})`}
          fill={color}
          stroke="var(--color-surface-1)"
          strokeWidth={1}
        />
      ) : (
        <circle
          cx={x}
          cy={y}
          r={node.kind === "generation" ? 3.5 : 2.5}
          fill={node.kind === "fork" ? "var(--color-surface-1)" : color}
          stroke={color}
          strokeWidth={1.5}
        />
      )}
    </g>
  );
}

/**
 * Git 风格的执行顺序图：行表示事件或连续的工具调用；时间戳描述相对起点的时间，泳道只描述祖先关系、
 * 不表示时长。滚动与观测详情的加载由调用方负责。
 */
export function TraceGraph({
  observations,
  selectedId,
  onSelect,
  className,
  headerActions,
}: {
  observations: TraceObservation[];
  selectedId: string | null | undefined;
  onSelect: (id: string | null) => void;
  className?: string;
  headerActions?: ReactNode;
}) {
  const { t } = useTranslation(TRACE_NS);
  const [compact, setCompact] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(760);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const width = container.getBoundingClientRect().width;
      if (width > 0) setContainerWidth(width);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const model = useMemo(() => buildTraceGraph(observations), [observations]);
  const graphWidth = Math.max(32, laneX(model.laneCount - 1) + 16);
  const groupColumns = Math.max(1, Math.floor((Math.max(containerWidth, graphWidth + 500) - graphWidth - 80) / 144));
  const display = useMemo(() => buildTraceGraphDisplay(model, compact, groupColumns), [model, compact, groupColumns]);
  const toggleLabel = compact ? t("graph.control.showRows") : t("graph.control.groupTools");
  return (
    <div ref={containerRef} className={cn("min-w-0 bg-surface-1", className)}>
      <div style={{ minWidth: graphWidth + 500 }}>
        <div
          className={cn(
            TRACE_GRAPH_COLUMNS,
            "h-8 border-b border-border-subtle bg-surface-2 text-left text-3xs uppercase tracking-wide text-text-muted",
          )}
          style={{ paddingLeft: graphWidth }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{t("graph.header.observation")}</span>
            <span className="shrink-0 normal-case">{headerActions}</span>
            <button
              type="button"
              aria-label={toggleLabel}
              aria-pressed={!compact}
              title={toggleLabel}
              onClick={() => setCompact((value) => !value)}
              className="shrink-0 rounded px-1 py-1 normal-case hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-brand"
            >
              {compact ? t("graph.control.rows") : t("graph.control.compact")}
            </button>
          </div>
          <span className="w-25 shrink-0 truncate">{t("graph.header.modelTokens")}</span>
          <span className="w-16 shrink-0 text-right">{t("graph.header.duration")}</span>
          <span className="w-17 shrink-0 text-right">{t("graph.header.time")}</span>
        </div>
        {model.nodes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <GitBranch className="h-7 w-7 text-text-muted/60" />
            <p className="text-sm text-text-secondary">{t("graph.empty.title")}</p>
            <p className="text-xs text-text-muted">{t("graph.empty.hint")}</p>
          </div>
        ) : (
          <div className="relative">
            {display.rows.map((row) => (
              <TraceGraphRow
                key={row.id}
                row={row}
                startTime={model.startTime}
                graphWidth={graphWidth}
                groupColumns={groupColumns}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
            <svg
              aria-hidden="true"
              width={graphWidth}
              height={display.height}
              className="pointer-events-none absolute left-0 top-0"
            >
              {display.edges.map((edge) => (
                <path
                  key={edge.id}
                  d={edgePath(edge, display.rows)}
                  fill="none"
                  stroke={laneColor(edge.lane)}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeDasharray={edge.kind === "fork" && edge.background ? "4 4" : undefined}
                  opacity={0.7}
                />
              ))}
              {display.rows.map((row, index) => (
                <GraphPoint
                  key={row.id}
                  node={row.nodes.find((node) => node.observation?.level === "ERROR") ?? row.nodes[0]}
                  lane={row.lane}
                  y={rowY(display.rows, index)}
                  selected={row.nodes.some((node) => Boolean(node.observation && selectedId === node.observation.id))}
                />
              ))}
            </svg>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-3xs text-text-muted">
        <span className="inline-flex items-center gap-1">
          <ArrowDown className="h-3 w-3" /> {t("graph.footer.timeOrder")} ·{" "}
          {compact ? t("graph.footer.grouped") : t("graph.footer.individual")}
        </span>
        <span className="ml-auto">{t("graph.footer.hiddenSpans", { hidden: model.hiddenCount })}</span>
      </div>
    </div>
  );
}
