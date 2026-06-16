import { AlertTriangle, ArrowRight, Inbox, RefreshCw, Search, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await workflowEngineApi.listRuns();
      setRuns(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const filtered = runs.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (searchQuery && !r.workflow_name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const _isTerminal = (s: DAGStatus) => ["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(s);

  const handleCancel = async (runId: string) => {
    try {
      await workflowEngineApi.cancel(runId);
      loadRuns();
    } catch (err) {
      console.error(err);
      toast.error(t("runs.cancel"), { description: (err as Error).message });
    }
  };

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
        <Button variant="outline" size="sm" onClick={loadRuns}>
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
          <p className="text-[13px] text-text-secondary">{t("runs.load_failed", { error })}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-10">
          {statusFilter !== "all" || searchQuery ? (
            <Search size={32} className="text-text-secondary mx-auto mb-2" />
          ) : (
            <Inbox size={32} className="text-text-secondary mx-auto mb-2" />
          )}
          <p className="text-[13px] text-text-secondary font-medium">
            {statusFilter !== "all" || searchQuery ? t("runs.no_match") : t("runs.no_runs")}
          </p>
          <p className="text-[11px] text-text-dim mt-1">
            {statusFilter !== "all" || searchQuery ? t("runs.no_runs_filter_hint") : t("runs.no_runs_hint")}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => (
            <div
              key={r.run_id}
              onClick={() => onSelectRun?.(r.run_id)}
              className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-bright">{r.workflow_name}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-text-dim">
                    <span className="font-mono">{r.run_id.substring(0, 16)}...</span>
                    <span>
                      <span className="text-status-running">{r.node_summary.completed}</span>
                      <span className="text-text-muted">/{r.node_summary.total}</span>
                    </span>
                    <span>{relativeTime(r.started_at, t)}</span>
                    <span className="font-mono">{formatDuration(r.started_at, r.completed_at)}</span>
                  </div>
                </div>
                <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  {r.status === "RUNNING" && (
                    <Button
                      size="xs"
                      variant="outline"
                      title={t("runs.cancel")}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCancel(r.run_id);
                      }}
                    >
                      <Square size={12} className="text-status-error" />
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    title={t("runs.view_details")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectRun?.(r.run_id, r.workflow_id);
                    }}
                  >
                    <ArrowRight size={12} />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div className="mt-3 text-[11px] text-text-muted text-center">
          {t("runs.total_records", { count: runs.length })}
        </div>
      )}
    </div>
  );
}
