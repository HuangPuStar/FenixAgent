import { EMPTY_STATE_FILL_CLASS, EmptyState } from "@fenix/ui-components/config/EmptyState";
import { cn } from "@fenix/ui-components/lib/cn";
import { formatClockTime } from "@fenix/ui-components/lib/format";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { AlertTriangle, GitBranch, RefreshCw } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useObservationDetail } from "../hooks/use-observation-detail";
import { useSessionTraces } from "../hooks/use-session-traces";
import { useTraceObservations } from "../hooks/use-trace-observations";
import { TRACE_NS } from "../i18n/namespace";
import { ObservationDetail } from "./detail/observation-detail";
import { TraceGraph } from "./graph/trace-graph";

/**
 * Trace 面板：左侧 run 列表 + 右侧调用图 / 节点详情。
 *
 * 数据三段式（列表 → 图 → 详情），每段各自取数、各自三态（loading / error / empty），四种事实不互相冒充：
 * 「没接观测后端」「这次会话还没建 ACP 会话」「这次会话没有 run」「读取失败」分别有不同的文案与出口。把它们
 * 统一成一句「暂无数据」会让部署配置问题看起来像业务空态（后端的 `configured` 字段正是为此存在）。
 *
 * **图与详情共用一个区域、按选中态切换**，而不是并排三栏：本面板是 Chat 右侧的浮层/停靠面板，最小宽度只有
 * 356px，三栏下每栏都会窄到不可读。代价是看详情时看不到图（详情头部给返回入口）。若日后需要「边看图边读
 * 详情」，应按面板宽度做并排布局——那是另一个交互设计，不是这里的隐藏分支。
 *
 * 会话定位：`environmentId` 是 Environment 主键，`sessionId` 是前端路由的实例 uid；真正的 ACP 会话 id 由
 * 服务端从 Session Doc 反查，浏览器无法指定「查谁的观测」。
 */
export interface TracePanelProps {
  /** 当前活跃 Environment；为空时面板不取数（agent 未选中）。 */
  environmentId: string | null;
  /** 实例 uid（前端路由的 sessionId 段）；为空时同样不取数。 */
  sessionId: string | null;
  className?: string;
}

/** run 列表宽：够放时间 + 序号，再宽就是浪费聊天区宽度。 */
const RUN_LIST_WIDTH_CLASS = "w-52 shrink-0 border-e border-border-subtle overflow-y-auto";

export function TracePanel({ environmentId, sessionId, className }: TracePanelProps) {
  const { t } = useTranslation(TRACE_NS);
  const scope = useMemo(
    () => ({ environmentId: environmentId ?? "", sessionId: sessionId ?? "" }),
    [environmentId, sessionId],
  );
  const enabled = Boolean(environmentId) && Boolean(sessionId);

  const list = useSessionTraces(scope, enabled);
  /** 用户在左栏点选的 run；null 表示尚未点选（此时取列表第一条）。 */
  const [pickedTraceId, setPickedTraceId] = useState<string | null>(null);
  /** 用户在图上点开的节点；**与它所属的 run 一起记录**，换 run 后自然失效（见下方 selectedObservationId）。 */
  const [selection, setSelection] = useState<{ traceId: string; observationId: string } | null>(null);

  // run 按起始时间倒序（新的在上）：列表顺序与「默认选中最新一条」必须同源，否则打开面板时选中的那条不是
  // 用户看到的第一条。
  const runs = useMemo(() => {
    const traces = list.data?.traces ?? [];
    return [...traces].sort((a, b) => Date.parse(b.timestamp ?? "") - Date.parse(a.timestamp ?? ""));
  }, [list.data]);

  // 生效的 run =「点选且仍在列表里的那条」或列表第一条。**派生而不是用 effect 复位**：effect 复位会先用过期
  // 的 traceId 渲染一帧，那一帧会白跑一次注定 404 的 observations 请求，而列表刷新时用户的选择也不该丢。
  const activeTraceId = useMemo(() => {
    if (runs.length === 0) return null;
    return pickedTraceId !== null && runs.some((run) => run.id === pickedTraceId) ? pickedTraceId : runs[0].id;
  }, [runs, pickedTraceId]);

  // 选中节点同理按所属 run 派生：上一条 run 的 observation id 在新 run 里不存在，拿它取详情必然 404。
  const selectedObservationId =
    selection !== null && selection.traceId === activeTraceId ? selection.observationId : null;

  const graph = useTraceObservations(scope, activeTraceId);
  const detail = useObservationDetail(scope, activeTraceId, selectedObservationId);

  function frame(content: ReactNode) {
    return <div className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col", className)}>{content}</div>;
  }

  /**
   * 失败态：给重试出口，并把服务端错误信封的 `message` 作为说明上屏——固定文案会让用户与测试都定位不到
   * 后端故障；`message` 为空时只剩标题（原始错误对象仍由取数层的 `onError` 进 console）。
   *
   * `error` 收 `unknown` 而不是 `Error`：两个取数 hook 如实声明 `unknown`（真伪判别留给视图层），
   * 写成 `Error` 会让调用点被迫用断言把类型「修好」。
   */
  function failure(title: string, retry: () => void, error?: unknown) {
    return (
      <EmptyState
        icon={<AlertTriangle className="size-5 text-status-warning" />}
        title={title}
        description={error instanceof Error && error.message ? error.message : undefined}
        tone="danger"
        role="alert"
        action={{ label: t("list.retry"), onClick: retry }}
        className={EMPTY_STATE_FILL_CLASS}
      />
    );
  }

  function body() {
    if (!enabled) {
      return (
        <EmptyState
          title={t("list.noSessionTitle")}
          description={t("list.noSessionHint")}
          className={EMPTY_STATE_FILL_CLASS}
        />
      );
    }
    if (list.loading && !list.data) {
      return (
        <div className="space-y-2 p-4" aria-busy="true">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-6 w-48" />
        </div>
      );
    }
    if (list.error) return failure(t("list.loadFailed"), list.refresh, list.error);
    if (list.data && !list.data.configured) {
      return (
        <EmptyState
          title={t("list.notConfiguredTitle")}
          description={t("list.notConfiguredHint")}
          className={EMPTY_STATE_FILL_CLASS}
        />
      );
    }
    if (list.data && list.data.acpSessionId === null) {
      return (
        <EmptyState
          title={t("list.noSessionTitle")}
          description={t("list.noSessionHint")}
          className={EMPTY_STATE_FILL_CLASS}
        />
      );
    }
    if (runs.length === 0) return <EmptyState title={t("list.empty")} className={EMPTY_STATE_FILL_CLASS} />;

    return (
      <div className="flex h-full min-h-0 min-w-0">
        <aside className={RUN_LIST_WIDTH_CLASS} aria-label={t("list.heading")}>
          <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-2 py-1.5">
            <span className="text-3xs font-medium text-text-muted">
              {t("list.total", { total: list.data?.totalItems ?? runs.length })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-3xs"
              onClick={list.refresh}
              disabled={list.loading}
            >
              <RefreshCw className={cn("size-3", list.loading && "animate-spin")} />
              {t("panel.refresh")}
            </Button>
          </div>
          <ul>
            {runs.map((run, index) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => setPickedTraceId(run.id)}
                  aria-current={run.id === activeTraceId}
                  className={cn(
                    "flex w-full flex-col gap-0.5 border-b border-border-subtle/60 px-2 py-1.5 text-left hover:bg-surface-hover",
                    run.id === activeTraceId && "bg-brand-subtle",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-xs text-text-primary">
                    <GitBranch className="size-3 shrink-0 text-text-dim" />
                    <span className="truncate">{formatClockTime(run.timestamp)}</span>
                    <span className="ms-auto text-3xs text-text-dim">#{runs.length - index}</span>
                  </span>
                  <span className="truncate text-3xs text-text-muted">{run.name ?? run.id}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">{detailOrGraph()}</section>
      </div>
    );
  }

  function detailOrGraph() {
    if (selectedObservationId) {
      if (detail.error) return failure(t("panel.detailLoadFailed"), detail.refresh, detail.error);
      // 详情数据未到前不渲染半张详情：IO 是详情的全部内容，缺了它先显示头部只会让人以为输出为空。
      if (detail.loading || !detail.observation) {
        return (
          <div className="space-y-2 p-4" aria-busy="true">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-40 w-full" />
          </div>
        );
      }
      return (
        <ObservationDetail observation={detail.observation} onClose={() => setSelection(null)} className="flex-1" />
      );
    }
    if (!activeTraceId || (graph.loading && graph.observations.length === 0)) {
      return (
        <div className="space-y-2 p-4" aria-busy="true">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-48 w-full" />
        </div>
      );
    }
    if (graph.error) return failure(t("panel.graphLoadFailed"), graph.refresh, graph.error);
    if (graph.observations.length === 0) {
      return <EmptyState title={t("panel.graphEmpty")} className={EMPTY_STATE_FILL_CLASS} />;
    }
    return (
      <TraceGraph
        observations={graph.observations}
        selectedId={undefined}
        onSelect={(id) =>
          setSelection(id !== null && activeTraceId !== null ? { traceId: activeTraceId, observationId: id } : null)
        }
        className="flex-1"
      />
    );
  }

  return frame(body());
}
