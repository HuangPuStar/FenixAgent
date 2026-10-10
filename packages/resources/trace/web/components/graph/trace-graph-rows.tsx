/**
 * 调用图的行渲染（移植自 langfuse-lite 的 `shared/components/observation-trace-graph-rows.tsx`）。
 *
 * 移植差异：
 * 1. `Observation` → {@link TraceObservation}；`formatDuration` → `formatInterval`、`formatMs` →
 *    `formatDurationMs`（取 `@fenix/ui-components/lib/format` 的命名——2026-10-10 起时长 / 令牌格式化与其他
 *    展示串原语同住该模块，本包不再自持一份）。
 * 2. **删掉生成节点的输出预览**：参考实现用 `getGenerationPreview()` 把模型输出压成一行主文案，首版不做
 *    （输出预览的解析归独立模块）。因此行内主文案一律是观测名，`node.label` 为空时用 `t()` 兜底。
 * 3. 行首类型标记由「GEN/TOOL 文本缩写」改为复用 `ObservationTypeIcon`：图标与配色只在
 *    `observation-badges` 维护一份，同一份 trace 在图、列表与详情里才是同一套视觉。
 * 4. 文案全部走 `t()`；`tnum` 换成 Tailwind 内建 `tabular-nums`（本项目主题并未定义 `.tnum`）。
 */
import { cn } from "@fenix/ui-components/lib/cn";
import { formatDurationMs, formatInterval, formatTokens } from "@fenix/ui-components/lib/format";
import type { TFunction } from "i18next";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TRACE_NS } from "../../i18n/namespace";
import type { TraceGraphDisplayRow } from "../../lib/graph/trace-graph-display-layout";
import type { TraceGraphNode } from "../../lib/graph/trace-graph-layout";
import { ObservationTypeIcon, observationTypeStyle } from "../observation-badges";

/**
 * 行模板：名称（弹性） + 模型/Token（100px） + 耗时（64px） + 相对时间（68px）。
 *
 * 用 flex + 标准宽度刻度而不是 `grid-cols-[minmax(...)_100px_...]`：任意值模板属禁写项（FCP-WEB-02），
 * 而列的语义本来就只有「名称占余量、其余定宽」，flex 表达得更直接。三处定宽合计 232px（w-25 / w-16 / w-17
 * 在 v4 的间距刻度下分别为 100px / 64px / 68px），表头与数据行共用本常量，列对齐由同一份定义保证。
 */
export const TRACE_GRAPH_COLUMNS = "flex items-center gap-1.5 pr-2";

type Selection = { selectedId: string | null | undefined; onSelect: (id: string | null) => void };

/** 观测名缺失时的兜底文案；`t` 由调用方传入，布局层保持纯函数、不持有 i18n 单例。 */
function nodeLabel(node: TraceGraphNode, t: TFunction): string {
  if (node.label) return node.label;
  if (node.kind === "generation") return t("graph.node.generation");
  if (node.kind === "tool") return t("graph.node.tool");
  return t("graph.node.subagent");
}

function Selectable({
  node,
  selectedId,
  onSelect,
  className,
  children,
  style,
  titleExtra,
}: Selection & {
  node: TraceGraphNode;
  className: string;
  children: ReactNode;
  style?: CSSProperties;
  titleExtra?: string;
}) {
  const { t } = useTranslation(TRACE_NS);
  const observation = node.observation;
  const selected = Boolean(observation && selectedId === observation.id);
  const title = [nodeLabel(node, t), observation?.statusMessage, titleExtra].filter(Boolean).join("\n");
  const classes = cn(
    "text-left transition-colors",
    selected ? "bg-brand-subtle shadow-[inset_2px_0_0_var(--color-brand)]" : "hover:bg-surface-hover",
    observation &&
      "cursor-pointer focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-[-2px]",
    className,
  );
  return observation ? (
    <button
      type="button"
      className={classes}
      style={style}
      title={title}
      aria-pressed={selected}
      onClick={() => onSelect(observation.id)}
    >
      {children}
    </button>
  ) : (
    <div className={classes} style={style} title={title}>
      {children}
    </div>
  );
}

/** 节点与类型标记共用语义色（取自角标表），与泳道连线的配色无关。 */
export function traceGraphTypeColor(node: TraceGraphNode) {
  const observation = node.observation;
  if (observation?.level === "ERROR") return "text-status-error";
  if (!observation) return "text-text-muted";
  return observationTypeStyle(observation.type).text;
}

/** 行首类型标记：复用角标图标，组行在后缀标出成员数（代替原先的类型缩写）。 */
function TypeMarker({ node, count }: { node: TraceGraphNode; count?: number }) {
  const type = node.observation?.type;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", count ? "w-16" : "w-7")}>
      {type ? <ObservationTypeIcon type={type} /> : null}
      {count ? <span className="font-mono text-3xs text-text-muted">×{count}</span> : null}
    </span>
  );
}

function Duration({ node }: { node: TraceGraphNode }) {
  const { t } = useTranslation(TRACE_NS);
  const observation = node.observation;
  if (!observation || node.kind === "fork" || node.kind === "join") return "—";
  return observation.endTime ? (
    formatInterval(observation.startTime, observation.endTime)
  ) : (
    <span className="inline-flex items-center gap-1 text-brand">
      <span className="h-1.5 w-1.5 rounded-full bg-brand motion-safe:animate-pulse" />
      {t("graph.running")}
    </span>
  );
}

function ErrorMark({ node }: { node: TraceGraphNode }) {
  const level = node.observation?.level;
  if (level !== "ERROR") return null;
  return <span className="shrink-0 font-mono text-3xs font-semibold text-status-error">{level}</span>;
}

function NodeGroup({
  row,
  startTime,
  graphWidth,
  groupColumns,
  ...selection
}: Selection & {
  row: TraceGraphDisplayRow;
  startTime: number;
  graphWidth: number;
  groupColumns: number;
}) {
  const { t } = useTranslation(TRACE_NS);
  const forkGroup = row.nodes[0].kind === "fork";
  const typeNode = row.nodes.find((node) => node.observation?.level === "ERROR") ?? row.nodes[0];
  return (
    <div
      data-tool-group={forkGroup ? undefined : row.nodes.length}
      data-fork-group={forkGroup ? row.nodes.length : undefined}
      className="relative flex items-center gap-1.5 pr-2"
      style={{ height: row.height, paddingLeft: graphWidth }}
    >
      <TypeMarker node={typeNode} count={row.nodes.length} />
      <div
        className="grid min-w-0 flex-1 gap-1 py-1"
        style={{
          gridTemplateColumns: `repeat(${Math.min(groupColumns, row.nodes.length)}, minmax(0, 1fr))`,
        }}
      >
        {row.nodes.map((node) => (
          <Selectable
            key={node.id}
            node={node}
            {...selection}
            titleExtra={t("graph.row.startedAt", { offset: formatDurationMs(node.timestamp - startTime) })}
            className="inline-flex h-5 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded border border-border-subtle/70 bg-surface-2/30 px-1.5"
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-11 font-medium",
                node.observation?.level === "ERROR" ? "text-status-error" : "text-text-primary",
              )}
            >
              {nodeLabel(node, t)}
            </span>
            <ErrorMark node={node} />
            <span className="shrink-0 font-mono text-3xs tabular-nums text-text-muted">
              {forkGroup ? (
                node.background ? (
                  t("graph.branch.backgroundShort")
                ) : (
                  t("graph.branch.syncShort")
                )
              ) : (
                <Duration node={node} />
              )}
            </span>
          </Selectable>
        ))}
      </div>
    </div>
  );
}

/** GEN 行锚定 agent 文本；合并组保证每个工具与子 agent 仍可单独选中。 */
export function TraceGraphRow({
  row,
  startTime,
  graphWidth,
  groupColumns = 4,
  ...selection
}: Selection & {
  row: TraceGraphDisplayRow;
  startTime: number;
  graphWidth: number;
  groupColumns?: number;
}) {
  const { t } = useTranslation(TRACE_NS);
  if (row.nodes.length > 1)
    return (
      <NodeGroup row={row} startTime={startTime} graphWidth={graphWidth} groupColumns={groupColumns} {...selection} />
    );
  const node = row.nodes[0];
  const observation = node.observation;
  const structural = node.kind === "fork" || node.kind === "join";
  const modelLabel = structural
    ? node.kind === "join"
      ? t("graph.branch.returned")
      : node.background
        ? t("graph.branch.background")
        : t("graph.branch.synchronous")
    : [
        observation?.model,
        observation?.totalTokens ? t("graph.tokens", { amount: formatTokens(observation.totalTokens) }) : null,
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <Selectable
      node={node}
      {...selection}
      className={cn(TRACE_GRAPH_COLUMNS, "relative w-full whitespace-nowrap")}
      style={{ height: row.height, paddingLeft: graphWidth }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <TypeMarker node={node} />
        <span
          className={cn(
            "truncate text-xs",
            structural ? "font-medium text-text-secondary" : "font-semibold text-text-primary",
            observation?.level === "ERROR" && "text-status-error",
          )}
        >
          {nodeLabel(node, t)}
        </span>
        <ErrorMark node={node} />
      </span>
      <span className="w-25 shrink-0 truncate text-3xs text-text-muted" title={modelLabel}>
        {modelLabel === "" ? "—" : modelLabel}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-3xs tabular-nums text-text-secondary">
        <Duration node={node} />
      </span>
      <span
        className="w-17 shrink-0 text-right font-mono text-3xs tabular-nums text-text-muted"
        title={t("graph.row.relativeTime")}
      >
        +{formatDurationMs(node.timestamp - startTime)}
      </span>
    </Selectable>
  );
}
