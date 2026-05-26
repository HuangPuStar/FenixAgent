import { Inbox, Loader, Rocket, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { workflowDefApi } from "../../../api/workflow-defs";
import { DAG_STATUS_CFG } from "../utils";

export function VersionPanel({
  workflowId,
  onClose,
  onPublish,
  publishing,
}: {
  workflowId?: string;
  onClose: () => void;
  onPublish: () => Promise<void>;
  publishing: boolean;
}) {
  const [wf, setWf] = useState<import("../../../api/workflow-defs").WorkflowDefItem | null>(null);
  const [versions, setVersions] = useState<import("../../../api/workflow-defs").WorkflowVersionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [viewingYaml, setViewingYaml] = useState<string | null>(null);
  const [publishingLocal, setPublishingLocal] = useState(false);
  const { t } = useTranslation("workflows");

  const loadData = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    try {
      const [wfData, versionList] = await Promise.all([
        workflowDefApi.get(workflowId),
        workflowDefApi.getVersions(workflowId),
      ]);
      setWf(wfData);
      setVersions(Array.isArray(versionList) ? versionList : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handlePublishClick = useCallback(async () => {
    setPublishingLocal(true);
    try {
      await onPublish();
      loadData();
    } catch (err) {
      console.error(err);
    } finally {
      setPublishingLocal(false);
    }
  }, [onPublish, loadData]);

  const handleSetLatest = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      try {
        await workflowDefApi.setLatest(workflowId, version);
        loadData();
      } catch (err) {
        console.error(err);
        toast.error(`${t("versions.operation_failed")}: ${(err as Error).message}`);
      }
    },
    [workflowId, loadData, t],
  );

  const handleRestoreToDraft = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      try {
        await workflowDefApi.restoreToDraft(workflowId, version);
        toast.success(t("versions.restore_success"));
      } catch (err) {
        console.error(err);
        toast.error(`${t("versions.restore_failed")}: ${(err as Error).message}`);
      }
    },
    [workflowId, t],
  );

  const handleViewYaml = useCallback(
    async (version: number) => {
      if (!workflowId) return;
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
      }
    },
    [workflowId, viewingVersion],
  );

  const isBusy = publishing || publishingLocal;

  return (
    <>
      <div
        className="wf-prop-header"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <span className="wf-prop-title">{t("editor.version_management")}</span>
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

      {workflowId && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid #f3f4f6" }}>
          <button
            type="button"
            onClick={handlePublishClick}
            disabled={isBusy}
            style={{
              width: "100%",
              padding: "7px 0",
              border: "none",
              borderRadius: 6,
              background: isBusy ? "#d1d5db" : "#22c55e",
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: isBusy ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
            }}
          >
            <Rocket size={13} />
            {isBusy
              ? t("editor.publishing")
              : t("editor.publish_new", {
                  current: wf?.latestVersion ? t("editor.publish_current", { version: wf.latestVersion }) : "",
                })}
          </button>
        </div>
      )}

      {wf && (
        <div
          style={{
            padding: "6px 12px",
            borderBottom: "1px solid #f3f4f6",
            fontSize: 10,
            color: "#9ca3af",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            latest:{" "}
            <strong style={{ color: wf.latestVersion ? "#22c55e" : "#d1d5db" }}>
              {wf.latestVersion ? `v${wf.latestVersion}` : t("editor.no_published")}
            </strong>
          </span>
          <span>{t("editor.version_total", { count: versions.length })}</span>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 24, color: "#9ca3af", fontSize: 11 }}>
            <Loader size={16} style={{ animation: "wf-spin 1s linear infinite", display: "inline-block" }} />
            <p style={{ marginTop: 4 }}>{t("editor.load_failed")}</p>
          </div>
        ) : versions.length === 0 ? (
          <div style={{ textAlign: "center", padding: 24, color: "#d1d5db", fontSize: 11 }}>
            <Inbox size={24} style={{ margin: "0 auto 4px" }} />
            <p>{t("editor.no_published")}</p>
            <p style={{ fontSize: 9, marginTop: 2 }}>{t("versions.no_versions_hint")}</p>
          </div>
        ) : (
          versions.map((v) => {
            const isLatest = wf?.latestVersion === v.version;
            const isViewing = viewingVersion === v.version;
            const _cfg = DAG_STATUS_CFG[v.status === "active" ? "SUCCESS" : "CANCELLED"] ?? DAG_STATUS_CFG.PENDING;
            return (
              <div key={v.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <div
                  style={{
                    padding: "8px 12px",
                    cursor: "pointer",
                    transition: "background 0.1s",
                  }}
                  onClick={() => handleViewYaml(v.version)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <span
                      style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600, color: "#111827", fontSize: 12 }}
                    >
                      v{v.version}
                    </span>
                    {isLatest && (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 2,
                          fontSize: 9,
                          fontWeight: 500,
                          color: "#22c55e",
                          background: "#f0fdf4",
                          padding: "1px 5px",
                          borderRadius: 99,
                        }}
                      >
                        latest
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", fontSize: 9, color: "#d1d5db" }}>
                      {new Date(v.createdAt).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 3 }} onClick={(e) => e.stopPropagation()}>
                    {!isLatest && (
                      <button
                        type="button"
                        onClick={() => handleSetLatest(v.version)}
                        style={{
                          padding: "2px 6px",
                          border: "1px solid #e5e7eb",
                          borderRadius: 3,
                          background: "#fff",
                          color: "#6b7280",
                          fontSize: 9,
                          cursor: "pointer",
                        }}
                      >
                        {t("versions.set_latest")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRestoreToDraft(v.version)}
                      style={{
                        padding: "2px 6px",
                        border: "1px solid #e5e7eb",
                        borderRadius: 3,
                        background: "#fff",
                        color: "#6b7280",
                        fontSize: 9,
                        cursor: "pointer",
                      }}
                    >
                      {t("versions.restore_to_draft")}
                    </button>
                  </div>
                </div>
                {isViewing && viewingYaml !== null && (
                  <div style={{ padding: "0 12px 8px" }}>
                    <pre
                      style={{
                        background: "#f9fafb",
                        border: "1px solid #e5e7eb",
                        borderRadius: 4,
                        padding: 8,
                        fontSize: 9,
                        fontFamily: "ui-monospace, monospace",
                        color: "#374151",
                        maxHeight: 200,
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
          })
        )}
      </div>
    </>
  );
}
