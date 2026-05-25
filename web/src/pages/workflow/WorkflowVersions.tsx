import { AlertTriangle, Clock, Inbox, Loader, RefreshCw, RotateCcw, Star } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type WorkflowDefItem, type WorkflowVersionItem, workflowDefApi } from "../../api/workflow-defs";

interface WorkflowVersionsProps {
  workflowId: string;
  onEditWorkflow: (workflowId: string) => void;
}

export function WorkflowVersions({ workflowId }: WorkflowVersionsProps) {
  const { t } = useTranslation("workflows");
  const [wf, setWf] = useState<WorkflowDefItem | null>(null);
  const [versions, setVersions] = useState<WorkflowVersionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [viewingYaml, setViewingYaml] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [wfData, versionList] = await Promise.all([
        workflowDefApi.get(workflowId),
        workflowDefApi.getVersions(workflowId),
      ]);
      setWf(wfData);
      setVersions(Array.isArray(versionList) ? versionList : []);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSetLatest = useCallback(
    async (version: number) => {
      if (!confirm(t("versions.set_latest_confirm", { version }))) return;
      try {
        await workflowDefApi.setLatest(workflowId, version);
        loadData();
      } catch (err) {
        console.error(err);
        alert(`${t("versions.operation_failed")}: ${(err as Error).message}`);
      }
    },
    [workflowId, loadData, t],
  );

  const handleRestoreToDraft = useCallback(
    async (version: number) => {
      if (!confirm(t("versions.restore_confirm", { version }))) return;
      try {
        await workflowDefApi.restoreToDraft(workflowId, version);
        alert(t("versions.restore_success"));
      } catch (err) {
        console.error(err);
        alert(`${t("versions.restore_failed")}: ${(err as Error).message}`);
      }
    },
    [workflowId, t],
  );

  const handleViewYaml = useCallback(
    async (version: number) => {
      if (viewingVersion === version) {
        setViewingVersion(null);
        setViewingYaml(null);
        return;
      }
      try {
        const result = await workflowDefApi.getVersion(workflowId, version);
        setViewingVersion(version);
        setViewingYaml(result.yaml);
      } catch (err) {
        console.error(err);
        alert(`${t("versions.yaml_load_failed")}: ${(err as Error).message}`);
      }
    },
    [workflowId, viewingVersion, t],
  );

  function relativeTime(iso?: string | null): string {
    if (!iso) return "--";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return t("versions.relative_now");
    if (diff < 3600) return t("versions.relative_minutes", { count: Math.floor(diff / 60) });
    if (diff < 86400) return t("versions.relative_days", { count: Math.floor(diff / 86400) });
    return new Date(iso).toLocaleDateString();
  }

  return (
    <div style={{ padding: "24px 32px", height: "100%", overflowY: "auto" }}>
      {/* 标题 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: "#111827", margin: 0 }}>
          {wf ? t("versions.title", { name: wf.name }) : t("versions.title", { name: "" })}
        </h1>
        <button
          type="button"
          onClick={loadData}
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
          <RefreshCw size={13} /> {t("versions.refresh")}
        </button>
      </div>

      {/* 当前状态 */}
      {wf && (
        <div
          style={{
            padding: "10px 16px",
            background: "#f9fafb",
            borderRadius: 8,
            border: "1px solid #e5e7eb",
            marginBottom: 16,
            fontSize: 12,
            color: "#6b7280",
            display: "flex",
            gap: 16,
          }}
        >
          <span>
            {t("versions.latest_label", {
              value: wf.latestVersion ? `v${wf.latestVersion}` : t("versions.latest_not_set"),
            })}
          </span>
          <span>{t("versions.published_count", { count: versions.length })}</span>
        </div>
      )}

      {/* 内容 */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "#9ca3af", fontSize: 13 }}>
          <Loader size={20} style={{ animation: "spin 1s linear infinite", display: "inline-block" }} />
          <p style={{ marginTop: 8 }}>{t("versions.loading")}</p>
        </div>
      ) : error ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <AlertTriangle size={32} style={{ color: "#ef4444", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#6b7280" }}>{t("versions.load_failed", { error })}</p>
        </div>
      ) : versions.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Inbox size={32} style={{ color: "#d1d5db", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#9ca3af", fontWeight: 500 }}>{t("versions.no_versions")}</p>
          <p style={{ fontSize: 11, color: "#d1d5db", marginTop: 4 }}>{t("versions.no_versions_hint")}</p>
        </div>
      ) : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
          {versions.map((v) => {
            const isLatest = wf?.latestVersion === v.version;
            const isViewing = viewingVersion === v.version;

            return (
              <div key={v.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 16px",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                  onClick={() => handleViewYaml(v.version)}
                >
                  {/* 版本号 */}
                  <div
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontWeight: 600,
                      color: "#111827",
                      minWidth: 40,
                    }}
                  >
                    v{v.version}
                  </div>

                  {/* latest 标记 */}
                  {isLatest && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        fontSize: 10,
                        fontWeight: 500,
                        color: "#22c55e",
                        background: "#f0fdf4",
                        padding: "1px 6px",
                        borderRadius: 99,
                      }}
                    >
                      <Star size={10} /> {t("versions.latest")}
                    </span>
                  )}

                  {/* 时间 */}
                  <span style={{ color: "#9ca3af", fontSize: 11 }}>
                    <Clock size={10} style={{ marginRight: 3, verticalAlign: -1 }} />
                    {relativeTime(v.createdAt)}
                  </span>

                  {/* 操作 */}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    {!isLatest && (
                      <button
                        type="button"
                        title={t("versions.set_latest")}
                        onClick={() => handleSetLatest(v.version)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 3,
                          padding: "3px 8px",
                          border: "1px solid #e5e7eb",
                          borderRadius: 4,
                          background: "#fff",
                          fontSize: 10,
                          color: "#6b7280",
                          cursor: "pointer",
                        }}
                      >
                        <Star size={10} /> {t("versions.set_latest")}
                      </button>
                    )}
                    <button
                      type="button"
                      title={t("versions.restore_to_draft")}
                      onClick={() => handleRestoreToDraft(v.version)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 3,
                        padding: "3px 8px",
                        border: "1px solid #e5e7eb",
                        borderRadius: 4,
                        background: "#fff",
                        fontSize: 10,
                        color: "#6b7280",
                        cursor: "pointer",
                      }}
                    >
                      <RotateCcw size={10} /> {t("versions.restore_to_draft")}
                    </button>
                  </div>
                </div>

                {/* YAML 展开区域 */}
                {isViewing && viewingYaml !== null && (
                  <div style={{ padding: "0 16px 12px" }}>
                    <pre
                      style={{
                        background: "#f9fafb",
                        border: "1px solid #e5e7eb",
                        borderRadius: 6,
                        padding: 10,
                        fontSize: 11,
                        fontFamily: "ui-monospace, monospace",
                        color: "#374151",
                        maxHeight: 300,
                        overflow: "auto",
                        margin: 0,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {viewingYaml}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
