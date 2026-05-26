import { AlertTriangle, Inbox, Loader, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type RunSummary, workflowEngineApi } from "../../../api/workflow-engine";
import { DAG_STATUS_CFG, relativeTime } from "../utils";

export function RunListPanel({ onClose, onSelect }: { onClose: () => void; onSelect: (runId: string) => void }) {
  const { t } = useTranslation("workflows");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");

  useEffect(() => {
    setLoading(true);
    setError(null);
    workflowEngineApi
      .listRuns()
      .then((data) => setRuns(Array.isArray(data) ? data : []))
      .catch((err) => {
        console.error(err);
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = runs.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    return true;
  });

  return (
    <>
      <div
        className="wf-prop-header"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <span className="wf-prop-title">{t("editor.run_history")}</span>
        <button
          type="button"
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            border: "none",
            background: "#f3f4f6",
            borderRadius: 4,
            color: "#6b7280",
            cursor: "pointer",
          }}
        >
          <X size={11} />
        </button>
      </div>

      {/* 筛选 */}
      <div
        style={{ display: "flex", gap: 3, padding: "6px 12px", borderBottom: "1px solid #f3f4f6", flexWrap: "wrap" }}
      >
        {["all", "RUNNING", "SUSPENDED", "SUCCESS", "FAILED"].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            style={{
              padding: "2px 6px",
              border: "1px solid",
              borderColor: statusFilter === s ? "#3b82f6" : "#e5e7eb",
              borderRadius: 4,
              background: statusFilter === s ? "#eff6ff" : "#fff",
              color: statusFilter === s ? "#3b82f6" : "#6b7280",
              fontSize: 10,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {s === "all" ? t("runs.filter_all") : DAG_STATUS_CFG[s] ? t(DAG_STATUS_CFG[s].labelKey) : s}
          </button>
        ))}
      </div>

      {/* 列表 */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 24, color: "#9ca3af", fontSize: 11 }}>
            <Loader size={16} style={{ animation: "wf-spin 1s linear infinite", display: "inline-block" }} />
            <p style={{ marginTop: 4 }}>{t("editor.load_failed")}</p>
          </div>
        ) : error ? (
          <div style={{ textAlign: "center", padding: 24 }}>
            <AlertTriangle size={20} style={{ color: "#ef4444", margin: "0 auto 4px" }} />
            <p style={{ fontSize: 11, color: "#6b7280" }}>{t("editor.load_failed_short")}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 24, color: "#d1d5db", fontSize: 11 }}>
            <Inbox size={24} style={{ margin: "0 auto 4px" }} />
            <p>{statusFilter !== "all" ? t("editor.no_match") : t("runs.no_runs")}</p>
          </div>
        ) : (
          filtered.map((r) => {
            const cfg = DAG_STATUS_CFG[r.status] ?? DAG_STATUS_CFG.PENDING;
            const isRunning = r.status === "RUNNING";
            return (
              <div
                key={r.run_id}
                onClick={() => onSelect(r.run_id)}
                style={{
                  padding: "8px 12px",
                  borderBottom: "1px solid #f3f4f6",
                  cursor: "pointer",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      padding: "1px 6px",
                      borderRadius: 99,
                      fontSize: 9,
                      fontWeight: 500,
                      color: cfg.color,
                      background: cfg.bg,
                    }}
                  >
                    {isRunning && (
                      <span
                        style={{
                          width: 4,
                          height: 4,
                          borderRadius: "50%",
                          background: cfg.color,
                          animation: "wf-pulse 1.5s ease-in-out infinite",
                        }}
                      />
                    )}
                    {t(cfg.labelKey)}
                  </span>
                  <span style={{ fontSize: 10, color: "#9ca3af", fontFamily: "ui-monospace, monospace" }}>
                    {r.node_summary.completed}/{r.node_summary.total}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 9, color: "#d1d5db" }}>
                    {relativeTime(t, r.started_at)}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: "#111827",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {r.workflow_name}
                </div>
                <div style={{ fontSize: 9, color: "#d1d5db", fontFamily: "ui-monospace, monospace" }}>
                  {r.run_id.substring(0, 20)}...
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 底部统计 */}
      {runs.length > 0 && (
        <div
          style={{
            padding: "6px 12px",
            borderTop: "1px solid #f3f4f6",
            fontSize: 10,
            color: "#d1d5db",
            textAlign: "center",
          }}
        >
          {t("runs.total_records", { count: runs.length })}
        </div>
      )}
    </>
  );
}
