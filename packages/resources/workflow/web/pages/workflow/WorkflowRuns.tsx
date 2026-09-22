import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Pagination } from "@fenix/ui-components/ui/pagination";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useDebounce, useRequest } from "ahooks";
import { AlertTriangle, ArrowRight, Inbox, RefreshCw, Search, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type DAGStatus, workflowEngineApi } from "../../api/workflow-engine";
import { WORKFLOW_RUN_STATUS_TONES } from "../../lib/status-tones";
import { RUN_STATUS_FILTERS, StatusFilterRow } from "./components/StatusFilterRow";
import { relativeTime } from "./utils";

const STATUS_LABEL_KEYS: Record<string, string> = {
  PENDING: "runs.status_pending",
  RUNNING: "runs.status_running",
  SUSPENDED: "runs.status_suspended",
  SUCCESS: "runs.status_success",
  FAILED: "runs.status_failed",
  CANCELLED: "runs.status_cancelled",
  ERROR: "runs.status_error",
};

function formatDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt) return "--";
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diff = Math.max(0, (end - new Date(startedAt).getTime()) / 1000);
  if (diff < 1) return "<1s";
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${Math.floor(diff % 60)}s`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
}

interface WorkflowRunsProps {
  onSelectRun?: (runId: string, workflowId?: string) => void;
}

export function WorkflowRuns({ onSelectRun }: WorkflowRunsProps) {
  const { t } = useTranslation("workflows");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 搜索防抖：输入即时更新，API 请求 300ms 后触发。此前这里是手写的 `setTimeout` + `clearTimeout`
  // 配对（effect 里再 `clearTimeout`），改用 ahooks 的 `useDebounce`（本包与仓库根依赖的 ahooks@^3.9.7）：
  // 首帧直接返回当前值、卸载时取消挂起的定时器，语义与原实现一致，少一份需要各自维护的定时器状态。
  const debouncedSearch = useDebounce(searchQuery, { wait: 300 });

  // 筛选条件或搜索词变化时，重置到第 1 页。
  // debouncedSearch / statusFilter 是「变化即重置页码」的触发条件，不是 effect 读取的值；按 biome 的建议删掉
  // 依赖会静默丢掉重置语义（翻到第 3 页后改筛选会停在不存在的页码上），因此用行级 ignore 保留触发语义。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖是触发条件（筛选/搜索变化即回第 1 页），effect 体只调用 setPage
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter]);

  // 数据加载
  const {
    data: runData,
    loading,
    error,
    refresh,
  } = useRequest(
    async () => {
      const params: { page?: number; pageSize?: number; status?: string; q?: string } = {
        page,
        pageSize,
      };
      if (statusFilter !== "all") params.status = statusFilter;
      if (debouncedSearch) params.q = debouncedSearch;
      return unwrap(workflowEngineApi.listRuns(params));
    },
    { refreshDeps: [page, pageSize, statusFilter, debouncedSearch] },
  );
  const runs = Array.isArray(runData?.items) ? runData.items : [];
  const total = runData?.total ?? 0;
  const errorMsg = error ? (error instanceof Error ? error.message : String(error)) : null;

  // 取消运行
  const { run: runCancel } = useRequest((runId: string) => unwrap(workflowEngineApi.cancel(runId)), {
    manual: true,
    onSuccess: () => refresh(),
    onError: (err) => {
      console.error(err);
      toast.error(t("runs.cancel"), { description: (err as Error).message });
    },
  });

  const _isTerminal = (s: DAGStatus) => ["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(s);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const showEmpty = !loading && !error && runs.length === 0;
  // 「筛选/搜索后没有匹配」与「一条运行都没有」是两种空态：前者要提示清空筛选，后者要提示去发起运行。
  const isFiltered = statusFilter !== "all" || Boolean(debouncedSearch);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* 顶部工具栏：刷新 + 搜索 + 状态筛选 */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex flex-1 items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("runs.search_placeholder")}
              className="h-8 pl-8 text-xs"
            />
          </div>
          {/* 筛选：取词路径是本页自己的（runs.status_*），由这里翻译后交给共享件 */}
          <StatusFilterRow
            value={statusFilter}
            onChange={setStatusFilter}
            options={RUN_STATUS_FILTERS.map((s) => ({
              value: s,
              label: s === "all" ? t("runs.filter_all") : t(STATUS_LABEL_KEYS[s] ?? s),
            }))}
          />
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw size={13} className="mr-1" /> {t("runs.refresh")}
        </Button>
      </div>

      {/* 内容区 */}
      {loading ? (
        <div className="space-y-2">
          {/* 占位行没有领域标识：先生成键数组再渲染，避免下标直接作为 key（骨架屏不重排、无行内状态）。 */}
          {Array.from({ length: 5 }, (_, i) => `run-skeleton-${i}`).map((rowKey) => (
            <Skeleton key={rowKey} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
        // 失败是持久分支：不能与下面的「暂无运行」空态合并，否则用户分不清「没有数据」与「没取到数据」。
        // 本页不额外给重试按钮——工具栏上的刷新是同一入口，再放一个只会让错误态里出现两个「重试」。
        <EmptyState
          icon={<AlertTriangle />}
          title={t("runs.load_failed", { error: errorMsg })}
          tone="danger"
          role="alert"
        />
      ) : showEmpty ? (
        <EmptyState
          icon={isFiltered ? <Search /> : <Inbox />}
          title={isFiltered ? t("runs.no_match") : t("runs.no_runs")}
          description={isFiltered ? t("runs.no_runs_filter_hint") : t("runs.no_runs_hint")}
        />
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* 数据表格 */}
          <div className="flex-1 overflow-auto">
            <table className="w-full">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground">
                    {t("runs.col_workflow")}
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground w-[100px]">
                    {t("runs.col_status")}
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground w-[90px]">
                    {t("runs.col_progress")}
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground w-[130px]">
                    {t("runs.col_started")}
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground w-[100px]">
                    {t("runs.col_duration")}
                  </th>
                  <th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground w-[80px]">
                    {t("runs.col_actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.run_id}
                    onClick={() => onSelectRun?.(r.run_id)}
                    className="border-b border-border hover:bg-muted/50 cursor-pointer transition-colors"
                  >
                    <td className="py-3 px-4">
                      <span className="text-sm font-medium">{r.workflow_name}</span>
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge
                        status={r.status}
                        label={t(STATUS_LABEL_KEYS[r.status] ?? r.status)}
                        toneMap={WORKFLOW_RUN_STATUS_TONES}
                        indicator={r.status === "RUNNING" ? "pulse" : "none"}
                        className="text-[11px]"
                      />
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-xs text-muted-foreground font-mono">
                        {r.node_summary.completed}/{r.node_summary.total}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-xs text-muted-foreground">{relativeTime(t, r.started_at, "runs")}</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-xs text-muted-foreground font-mono">
                        {formatDuration(r.started_at, r.completed_at)}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {r.status === "RUNNING" && (
                          <Button
                            size="xs"
                            variant="ghost"
                            title={t("runs.cancel")}
                            onClick={(e) => {
                              e.stopPropagation();
                              runCancel(r.run_id);
                            }}
                          >
                            <Square size={12} className="text-destructive" />
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="ghost"
                          title={t("runs.view_details")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectRun?.(r.run_id, r.workflow_id);
                          }}
                        >
                          <ArrowRight size={12} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 底部分页 */}
          <div className="border-t border-border px-4 shrink-0">
            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              t={t}
            />
          </div>
        </div>
      )}
    </div>
  );
}
