import { unwrap } from "@fenix/web-runtime/api/request";
import { Link } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { AlertTriangle, ExternalLink, Inbox } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { workflowEngineApi } from "../../../api/workflow-engine";
import { DAG_STATUS_CFG, relativeTime } from "../utils";
import { InlineLoader } from "./InlineLoader";
import { PanelHeader } from "./PanelHeader";
import { RUN_STATUS_FILTERS, StatusFilterRow } from "./StatusFilterRow";

export function RunListPanel({ onClose, onSelect }: { onClose: () => void; onSelect: (runId: string) => void }) {
  const { t } = useTranslation("workflows");
  const [statusFilter, setStatusFilter] = useState("all");

  // 运行列表的 loading / error / data 三态交给 useRequest 管理（§3.2）；失败必须是 rejected Promise，
  // 因此经 unwrap 解包，不能直接 await 域模块（双语义期，见 §5.2）。
  const {
    data: runs = [],
    loading,
    error,
  } = useRequest(async () => {
    const page = await unwrap(workflowEngineApi.listRuns());
    return Array.isArray(page.items) ? page.items : [];
  });

  const filtered = runs.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    return true;
  });

  return (
    <>
      <PanelHeader title={t("editor.run_history")} closeLabel={t("editor.run_panel_close")} onClose={onClose} />

      {/* 筛选：取词路径是本页自己的（editor.dag_status_*），由这里翻译后交给共享件 */}
      <StatusFilterRow
        value={statusFilter}
        onChange={setStatusFilter}
        className="border-b border-border-light px-3 py-1.5"
        options={RUN_STATUS_FILTERS.map((s) => ({
          value: s,
          label: s === "all" ? t("runs.filter_all") : DAG_STATUS_CFG[s] ? t(DAG_STATUS_CFG[s].labelKey) : s,
        }))}
      />

      {/* 列表 */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 24, color: "#4b5563", fontSize: 11 }}>
            <InlineLoader />
            <p style={{ marginTop: 4 }}>{t("editor.load_failed")}</p>
          </div>
        ) : error ? (
          <div style={{ textAlign: "center", padding: 24 }}>
            <AlertTriangle size={20} style={{ color: "#ef4444", margin: "0 auto 4px" }} />
            <p style={{ fontSize: 11, color: "#6b7280" }}>{t("editor.load_failed_short")}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 24, color: "#6b7280", fontSize: 11 }}>
            <Inbox size={24} style={{ margin: "0 auto 4px" }} />
            <p>{statusFilter !== "all" ? t("editor.no_match") : t("runs.no_runs")}</p>
          </div>
        ) : (
          filtered.map((r) => {
            const cfg = DAG_STATUS_CFG[r.status] ?? DAG_STATUS_CFG.PENDING;
            const isRunning = r.status === "RUNNING";
            return (
              /*
                整行点击 = 打开该次运行的详情，行内没有等价的键盘入口，所以行自身必须可聚焦：
                role="button" + tabIndex + Enter/Space（Space 默认滚动页面，需 preventDefault）。
                行内无嵌套可聚焦控件，键盘事件不需要像 VersionPanel 那样做后代隔离。
              */
              <div
                key={r.run_id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(r.run_id)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  onSelect(r.run_id);
                }}
                // 本组件沿用内联样式（非 Tailwind）：焦点反馈必须显式写出，否则 Tab 到这里没有可见提示
                onFocus={(e) => {
                  e.currentTarget.style.outline = "2px solid #3b82f6";
                  e.currentTarget.style.outlineOffset = "-2px";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.outline = "";
                  e.currentTarget.style.outlineOffset = "";
                }}
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
                  <span style={{ fontSize: 10, color: "#4b5563", fontFamily: "ui-monospace, monospace" }}>
                    {r.node_summary.completed}/{r.node_summary.total}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 9, color: "#6b7280" }}>
                    {relativeTime(t, r.started_at, "runs")}
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
                <div style={{ fontSize: 9, color: "#6b7280", fontFamily: "ui-monospace, monospace" }}>
                  {r.run_id.substring(0, 20)}...
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 底部统计 + 查看全部 */}
      <div
        style={{
          padding: "6px 12px",
          borderTop: "1px solid #f3f4f6",
          fontSize: 10,
          color: "#6b7280",
          textAlign: "center",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        {runs.length > 0 && <span>{t("runs.total_records", { count: runs.length })}</span>}
        <Link
          to="/agent/workflow"
          search={{ tab: "runs" }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            color: "#3b82f6",
            textDecoration: "none",
            fontWeight: 500,
          }}
        >
          {t("editor.view_all_runs")} <ExternalLink size={10} />
        </Link>
      </div>
    </>
  );
}
