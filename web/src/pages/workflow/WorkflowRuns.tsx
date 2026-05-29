import { AlertTriangle, ArrowRight, Inbox, Loader, RefreshCw, Search, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type DAGStatus, type RunSummary, workflowEngineApi } from "../../api/workflow-engine";
import { SkeletonTable } from "./components/SkeletonRows";

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
      {isRunning && (
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ background: cfg.color }}
        />
      )}
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
    <div className="h-full overflow-y-auto p-6">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-base font-semibold text-text-primary m-0">{t("runs.title")}</h1>
        <button
          type="button"
          onClick={loadRuns}
          className="flex items-center gap-1.5 px-2.5 py-1 border border-border-subtle rounded-md bg-surface-1 text-xs text-text-secondary cursor-pointer hover:bg-surface-hover transition-colors"
        >
          <RefreshCw size={13} /> {t("runs.refresh")}
        </button>
      </div>

      {/* 搜索和筛选 */}
      <div className="flex gap-2.5 mb-4 items-center">
        <div className="flex items-center gap-1.5 flex-1 max-w-[260px] border border-border-subtle rounded-md px-2.5 py-1.5 bg-surface-1">
          <Search size={13} className="text-text-secondary shrink-0" />
          <input
            placeholder={t("runs.search_placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="border-none outline-none text-xs w-full bg-transparent text-text-primary"
          />
        </div>
        <div className="flex gap-1">
          {["all", "RUNNING", "SUSPENDED", "SUCCESS", "FAILED"].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 border rounded-md text-[11px] font-medium cursor-pointer transition-colors ${
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

      {/* 内容 */}
      {loading ? (
        <SkeletonTable cols="2fr 1fr 80px 120px 80px 80px" rows={6} />
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
        <div className="border border-border-subtle rounded-lg overflow-hidden bg-surface-1">
          {/* 表头 */}
          <div className="grid grid-cols-[2fr_1fr_80px_120px_80px_80px] gap-2 px-4 py-2 bg-surface-2 border-b border-border-subtle text-[11px] font-semibold text-text-muted uppercase tracking-wide">
            <span>{t("runs.table_workflow")}</span>
            <span>{t("runs.table_status")}</span>
            <span>{t("runs.table_nodes")}</span>
            <span>{t("runs.table_start")}</span>
            <span>{t("runs.table_duration")}</span>
            <span></span>
          </div>

          {/* 数据行 */}
          {filtered.map((r) => (
            <div
              key={r.run_id}
              onClick={() => onSelectRun?.(r.run_id)}
              className="grid grid-cols-[2fr_1fr_80px_120px_80px_80px] gap-2 px-4 py-2.5 border-b border-border-subtle cursor-pointer transition-colors text-xs items-center hover:bg-surface-hover"
            >
              <div>
                <div className="font-medium text-text-primary">{r.workflow_name}</div>
                <div className="text-[10px] text-text-secondary font-mono mt-0.5">
                  {r.run_id.substring(0, 16)}...
                </div>
              </div>
              <StatusBadge status={r.status} />
              <div className="font-mono text-text-secondary">
                <span className="text-status-running">{r.node_summary.completed}</span>
                <span>/{r.node_summary.total}</span>
              </div>
              <div className="text-text-secondary">{relativeTime(r.started_at, t)}</div>
              <div className="font-mono text-text-secondary">
                {formatDuration(r.started_at, r.completed_at)}
              </div>
              <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                {r.status === "RUNNING" && (
                  <button
                    type="button"
                    title={t("runs.cancel")}
                    onClick={() => handleCancel(r.run_id)}
                    className="flex items-center justify-center w-6 h-6 border-none bg-transparent rounded text-status-error cursor-pointer hover:bg-surface-hover transition-colors"
                  >
                    <Square size={13} />
                  </button>
                )}
                <button
                  type="button"
                  title={t("runs.view_details")}
                  onClick={() => onSelectRun?.(r.run_id, r.workflow_id)}
                  className="flex items-center justify-center w-6 h-6 border-none bg-transparent rounded text-text-secondary cursor-pointer hover:bg-surface-hover transition-colors"
                >
                  <ArrowRight size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div className="mt-3 text-[11px] text-text-secondary text-center">
          {t("runs.total_records", { count: runs.length })}
        </div>
      )}
    </div>
  );
}
