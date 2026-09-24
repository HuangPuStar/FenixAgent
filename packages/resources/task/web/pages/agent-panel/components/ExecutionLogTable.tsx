import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { cn } from "@fenix/ui-components/lib/cn";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExecutionLogInfo } from "../../../api/tasks-v2";
import { taskV2Api } from "../../../api/tasks-v2";
import {
  formatTaskLogTime,
  isUnauthorizedError,
  LOG_STATUS_TONES,
  logStatusLabelKey,
} from "../pages/agent-tasks-utils";

/**
 * 执行日志的统一实现：取数（`useRequest` + 分页）＋ 表格 ＋ 上一页/下一页 ＋ loading/empty/error 三态。
 *
 * 为什么收敛：行内日志区（`TasksPanel` 内联版）与执行日志弹窗（`TaskLogDialog`）此前各持一份**逐字重复**
 * 的实现——同一个 `taskV2Api.logs`、同一个 `PAGE_SIZE = 20`、同一句
 * `Math.max(1, Math.ceil(total / PAGE_SIZE))`、同一批 `log.*` 文案、同一套表格与分页块。漂移也已经发生：
 * 弹窗版自读信封（`if (!success) throw new Error(...)`），401/403 因此被混进普通故障，既没有无权限分支
 * 也没有重试入口；行内版有。收敛后取数与三态只此一处，两个调用点的差异只剩 props：
 * 弹窗多一列「耗时」、行可展开、带状态筛选与「清空日志」入口。
 */
const PAGE_SIZE = 20;

/** 耗时格式化，单位语言无关，直接拼接（仅弹窗的「耗时」列用）。 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface ExecutionLogTableProps {
  taskId: string;
  /** 取数前置条件：弹窗只在打开时请求，关掉不留后台空转。 */
  ready?: boolean;
  /** 额外的重取依赖（弹窗需要随开关与「清空日志」重取）；`taskId` 恒参与，调用方不必重复传。 */
  refreshDeps?: readonly unknown[];
  /** 追加「耗时」列（弹窗版）。 */
  showDuration?: boolean;
  /** 行可展开看错误/结果/跳过原因详情（弹窗版）。 */
  expandable?: boolean;
  /** 客户端过滤，只作用于当前页数据（弹窗的状态筛选 chips）。 */
  filter?: (log: ExecutionLogInfo) => boolean;
  /** 分页栏尾部操作位（弹窗的「清空日志」）。 */
  footerExtra?: ReactNode;
}

export function ExecutionLogTable({
  taskId,
  ready = true,
  refreshDeps,
  showDuration = false,
  expandable = false,
  filter,
  footerExtra,
}: ExecutionLogTableProps) {
  const { t } = useTranslation(NS.TASKS_V2);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 取数必须经 `unwrap` 而不是自读信封：`request()` 对 4xx/5xx 返回 `{ success: false }` 而不 throw，
  // 只有解包抛出的 `ApiError` 才带错误码——401/403 的无权限分支据此判定；自造 `new Error(message)`
  // 会把授权失败与瞬时故障混成同一类，只能一律给重试。
  const { data, loading, error, run } = useRequest(
    async (p: number) => unwrap(taskV2Api.logs(taskId, { page: p, pageSize: PAGE_SIZE })),
    {
      defaultParams: [1],
      refreshDeps: [taskId, ...(refreshDeps ?? [])],
      ready,
      // 失败态的可见反馈是下面的 `EmptyState`（`role="alert"` + 重试，§5.8）；原始 `ApiError`
      // 只在这一行留诊断上下文——失败块自本批起不再回显 `error.message`（§9.3）。
      onError: (err: unknown) => console.error("task logs load failed", err),
    },
  );

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  // 与列表侧同口径：401/403 是持久授权状态，只说明原因（标题 + 提示）且不给重试；其余失败给一次重试。
  const unauthorized = isUnauthorizedError(error);
  const items = data?.items ?? [];
  const visibleItems = filter ? items.filter(filter) : items;
  /** 展开行的 colSpan：可选的首列（展开箭头）与「耗时」列都要算进去。 */
  const columnCount = (expandable ? 1 : 0) + (showDuration ? 5 : 4);

  const goTo = (next: number) => {
    setPage(next);
    run(next);
  };

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {error ? (
          // 权限态与瞬时故障分开：401/403 只说明原因，其余失败给一次重试（沿用分页按钮的 run(page) 入口）。
          // `disabled: loading`：ahooks 在新请求期间**不清空** error（只在成功时置回 undefined），
          // 所以重试中错误块仍在渲染，不禁用就能连点重发同页请求。
          <EmptyState
            title={unauthorized ? t("loadState.unauthorizedTitle") : t("loadState.failed")}
            description={unauthorized ? t("loadState.unauthorizedHint") : undefined}
            tone="danger"
            role="alert"
            action={
              unauthorized ? undefined : { label: t("loadState.retry"), onClick: () => run(page), disabled: loading }
            }
            className="py-8 px-3"
          />
        ) : loading ? (
          <div className="py-4 px-3 space-y-2" aria-busy="true">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : !visibleItems.length ? (
          <EmptyState title={t("log.empty")} className="py-8" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {expandable && <TableHead className="w-6" />}
                <TableHead className="text-xs">{t("log.time")}</TableHead>
                <TableHead className="text-xs">{t("log.triggeredBy")}</TableHead>
                <TableHead className="text-xs">{t("log.status")}</TableHead>
                {showDuration && <TableHead className="text-xs">{t("log.duration")}</TableHead>}
                <TableHead className="text-xs">{t("log.result")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleItems.map((log: ExecutionLogInfo) => {
                // 展开只在弹窗版开启；没有详情的行不可点，因此也不给手势光标。
                const hasDetail = expandable && !!(log.error || log.resultSummary || log.skipReason);
                const isExpanded = hasDetail && expandedId === log.id;
                return (
                  <Fragment key={log.id}>
                    <TableRow
                      className={cn(hasDetail && "cursor-pointer", isExpanded && "bg-muted/30")}
                      onClick={hasDetail ? () => setExpandedId(isExpanded ? null : log.id) : undefined}
                    >
                      {expandable && (
                        <TableCell className="w-6 pr-0">
                          {hasDetail && (
                            <span className="text-text-muted">
                              {isExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                            </span>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="text-xs whitespace-nowrap">{formatTaskLogTime(log.createdAt)}</TableCell>
                      <TableCell>
                        <span className="text-xs text-text-muted">
                          {log.triggeredBy === "cron" ? t("triggeredBy.cron") : t("triggeredBy.manual")}
                        </span>
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          status={log.status}
                          label={t(logStatusLabelKey(log.status))}
                          toneMap={LOG_STATUS_TONES}
                          className="h-5"
                        />
                      </TableCell>
                      {showDuration && (
                        <TableCell className="text-xs">
                          {log.duration != null ? formatDuration(log.duration) : t("log.noResult")}
                        </TableCell>
                      )}
                      <TableCell className="max-w-40">
                        <div className="truncate text-xs">
                          {log.error ? (
                            <span className="text-destructive">{log.error}</span>
                          ) : log.skipReason ? (
                            <span className="text-text-muted">{log.skipReason}</span>
                          ) : (
                            log.resultSummary || t("log.noResult")
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow className="bg-muted/20">
                        <TableCell colSpan={columnCount} className="px-4 py-3">
                          <div className="space-y-1.5">
                            {log.error && (
                              <div>
                                <span className="text-xs font-medium text-destructive">{t("log.errorLabel")}: </span>
                                <pre className="mt-0.5 text-xs font-mono text-destructive whitespace-pre-wrap break-all">
                                  {log.error}
                                </pre>
                              </div>
                            )}
                            {log.resultSummary && (
                              <div>
                                <span className="text-xs font-medium text-emerald-600">{t("log.resultLabel")}: </span>
                                <pre className="mt-0.5 text-xs font-mono text-text-primary whitespace-pre-wrap break-all">
                                  {log.resultSummary}
                                </pre>
                              </div>
                            )}
                            {log.skipReason && (
                              <div>
                                <span className="text-xs font-medium text-text-muted">{t("log.skipLabel")}: </span>
                                <span className="text-xs text-text-muted">{log.skipReason}</span>
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* 分页：总数 + 上一页/x/y/下一页 + 调用方的尾部操作（弹窗的「清空日志」） */}
      {data && data.total > 0 && (
        <div className="flex items-center justify-between gap-2 shrink-0 border-t border-border/40 px-3 py-2">
          <span className="text-xs text-text-muted">{t("log.total", { count: data.total })}</span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => goTo(page - 1)}
              disabled={page <= 1}
            >
              {t("log.prev")}
            </Button>
            <span className="text-xs text-text-muted">
              {page}/{totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => goTo(page + 1)}
              disabled={page >= totalPages}
            >
              {t("log.next")}
            </Button>
          </div>
          {footerExtra}
        </div>
      )}
    </>
  );
}
