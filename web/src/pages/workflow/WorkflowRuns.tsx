import { AlertTriangle, ArrowRight, Inbox, Loader, RefreshCw, Search, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 500,
        color: cfg.color,
        background: cfg.bg,
        padding: "2px 8px",
        borderRadius: 99,
      }}
    >
      {isRunning && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: cfg.color,
            animation: "wf-pulse 1.5s ease-in-out infinite",
          }}
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
      alert((err as Error).message);
    }
  };

  return (
    <div style={{ padding: "24px 32px", height: "100%", overflowY: "auto" }}>
      {/* 顶部标题栏 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: "#111827", margin: 0 }}>{t("runs.title")}</h1>
        <button
          type="button"
          onClick={loadRuns}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "5px 10px",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            background: "#fff",
            fontSize: 12,
            color: "#374151",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={13} /> {t("runs.refresh")}
        </button>
      </div>

      {/* 搜索和筛选 */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            maxWidth: 260,
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            padding: "5px 10px",
            background: "#fff",
          }}
        >
          <Search size={13} style={{ color: "#9ca3af", flexShrink: 0 }} />
          <input
            placeholder={t("runs.search_placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ border: "none", outline: "none", fontSize: 12, width: "100%", background: "transparent" }}
          />
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {["all", "RUNNING", "SUSPENDED", "SUCCESS", "FAILED"].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              style={{
                padding: "4px 10px",
                border: "1px solid",
                borderColor: statusFilter === s ? "#3b82f6" : "#e5e7eb",
                borderRadius: 6,
                background: statusFilter === s ? "#eff6ff" : "#fff",
                color: statusFilter === s ? "#3b82f6" : "#6b7280",
                fontSize: 11,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {s === "all" ? t("runs.filter_all") : t(STATUS_LABEL_KEYS[s] ?? s)}
            </button>
          ))}
        </div>
      </div>

      {/* 内容 */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "#9ca3af", fontSize: 13 }}>
          <Loader size={20} style={{ animation: "spin 1s linear infinite", display: "inline-block" }} />
          <p style={{ marginTop: 8 }}>{t("runs.loading")}</p>
        </div>
      ) : error ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <AlertTriangle size={32} style={{ color: "#ef4444", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#6b7280" }}>{t("runs.load_failed", { error })}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          {statusFilter !== "all" || searchQuery ? (
            <Search size={32} style={{ color: "#d1d5db", margin: "0 auto 8px" }} />
          ) : (
            <Inbox size={32} style={{ color: "#d1d5db", margin: "0 auto 8px" }} />
          )}
          <p style={{ fontSize: 13, color: "#9ca3af", fontWeight: 500 }}>
            {statusFilter !== "all" || searchQuery ? t("runs.no_match") : t("runs.no_runs")}
          </p>
          <p style={{ fontSize: 11, color: "#d1d5db", marginTop: 4 }}>
            {statusFilter !== "all" || searchQuery ? t("runs.no_runs_filter_hint") : t("runs.no_runs_hint")}
          </p>
        </div>
      ) : (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            overflow: "hidden",
            background: "#fff",
          }}
        >
          {/* 表头 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 80px 120px 80px 80px",
              gap: 8,
              padding: "8px 16px",
              background: "#f9fafb",
              borderBottom: "1px solid #e5e7eb",
              fontSize: 11,
              fontWeight: 600,
              color: "#6b7280",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
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
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 1fr 80px 120px 80px 80px",
                gap: 8,
                padding: "10px 16px",
                borderBottom: "1px solid #f3f4f6",
                cursor: "pointer",
                transition: "background 0.1s",
                fontSize: 12,
                alignItems: "center",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "")}
            >
              <div>
                <div style={{ fontWeight: 500, color: "#111827" }}>{r.workflow_name}</div>
                <div style={{ fontSize: 10, color: "#9ca3af", fontFamily: "ui-monospace, monospace", marginTop: 1 }}>
                  {r.run_id.substring(0, 16)}...
                </div>
              </div>
              <StatusBadge status={r.status} />
              <div style={{ fontFamily: "ui-monospace, monospace", color: "#6b7280" }}>
                <span style={{ color: "#22c55e" }}>{r.node_summary.completed}</span>
                <span style={{ color: "#d1d5db" }}>/{r.node_summary.total}</span>
              </div>
              <div style={{ color: "#6b7280" }}>{relativeTime(r.started_at, t)}</div>
              <div style={{ fontFamily: "ui-monospace, monospace", color: "#6b7280" }}>
                {formatDuration(r.started_at, r.completed_at)}
              </div>
              <div style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                {r.status === "RUNNING" && (
                  <button
                    type="button"
                    title={t("runs.cancel")}
                    onClick={() => handleCancel(r.run_id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 26,
                      height: 26,
                      border: "none",
                      background: "none",
                      borderRadius: 4,
                      color: "#ef4444",
                      cursor: "pointer",
                    }}
                  >
                    <Square size={13} />
                  </button>
                )}
                <button
                  type="button"
                  title={t("runs.view_details")}
                  onClick={() => onSelectRun?.(r.run_id, r.workflow_id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 26,
                    height: 26,
                    border: "none",
                    background: "none",
                    borderRadius: 4,
                    color: "#6b7280",
                    cursor: "pointer",
                  }}
                >
                  <ArrowRight size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {runs.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 11, color: "#9ca3af", textAlign: "center" }}>
          {t("runs.total_records", { count: runs.length })}
        </div>
      )}
    </div>
  );
}
