import { useRequest } from "ahooks";
import { AlertTriangle, ArrowRight, Inbox, RefreshCw, Search, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap } from "../../api/request";
import { type DAGStatus, type RunSummary, workflowEngineApi } from "../../api/workflow-engine";

const STATUS_CONFIG: Record<string, { color: string; bg: string }> = {
  PENDING: { color: "#94a3b8", bg: "#f1f5f9" },
  RUNNING: { color: "#3b82f6", bg: "#eff6ff" },
  SUSPENDED: { color: "#f59e0b", bg: "#fffbeb" },
  SUCCESS: { color: "#22c55e", bg: "#f0fdf4" },
  FAILED: { color: "#ef4444", bg: "#fef2f2" },
  CANCELLED: { color: "#94a3b8", bg: "#f8fafc" },
  ERROR: { color: "#ef4444", bg: "#fef2f2" },
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  PENDING: "runs.status_pending",
  RUNNING: "runs.status_running",
  SUSPENDED: "runs.status_suspended",
  SUCCESS: "runs.status_success",
  FAILED: "runs.status_failed",
  CANCELLED: "runs.status_cancelled",
  ERROR: "runs.status_error",
};

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation("workflows");
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.PENDING;
  const isRunning = status === "RUNNING";
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full"
      style={{ color: cfg.color, background: cfg.bg }}
    >
      {isRunning && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: cfg.color }} />}
      {t(STATUS_LABEL_KEYS[status] ?? status)}
    </span>
  );
}

function relativeTime(
  iso: string | undefined | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!iso) return "--";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 0) return t("runs.relative_now");
  if (diff < 60) return t("runs.relative_now");
  if (diff < 3600) return t("runs.relative_minutes", { count: Math.floor(diff / 60) });
  if (diff < 86400) return t("runs.relative_hours", { count: Math.floor(diff / 3600) });
  if (diff < 604800) return t("runs.relative_days", { count: Math.floor(diff / 86400) });
  return new Date(iso).toLocaleDateString();
}

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
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 搜索防抖：输入即时更新，API 请求 300ms 后触发
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // 筛选条件或搜索词变化时，重置到第 1 页
  // biome-ignore lint/correctness/useExhaustiveDependencies: 筛选/搜索变化时需重置页码，但 effect 体只用 setPage
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
          <div className="flex gap-1">
            {["all", "RUNNING", "SUSPENDED", "SUCCESS", "FAILED"].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  statusFilter === s
                    ? "border-brand bg-brand-subtle text-brand"
                    : "border-border-subtle bg-surface-1 text-text-secondary hover:bg-surface-hover"
                }`}
              >
                {s === "all" ? t("runs.filter_all") : t(STATUS_LABEL_KEYS[s] ?? s)}
              </button>
            ))}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw size={13} className="mr-1" /> {t("runs.refresh")}
        </Button>
      </div>

      {/* 内容区 */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <div className="text-center py-10">
          <AlertTriangle size={32} className="text-status-error mx-auto mb-2" />
          <p className="text-[13px] text-text-secondary">{t("runs.load_failed", { error: errorMsg })}</p>
        </div>
      ) : showEmpty ? (
        <div className="text-center py-10">
          {statusFilter !== "all" || debouncedSearch ? (
            <Search size={32} className="text-text-secondary mx-auto mb-2" />
          ) : (
            <Inbox size={32} className="text-text-secondary mx-auto mb-2" />
          )}
          <p className="text-[13px] text-text-secondary font-medium">
            {statusFilter !== "all" || debouncedSearch ? t("runs.no_match") : t("runs.no_runs")}
          </p>
          <p className="text-[11px] text-text-dim mt-1">
            {statusFilter !== "all" || debouncedSearch ? t("runs.no_runs_filter_hint") : t("runs.no_runs_hint")}
          </p>
        </div>
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
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-xs text-muted-foreground font-mono">
                        {r.node_summary.completed}/{r.node_summary.total}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-xs text-muted-foreground">{relativeTime(r.started_at, t)}</span>
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
