import { GitBranch, Loader, RotateCcw, Star } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type WorkflowVersionItem, workflowDefApi } from "../../../api/workflow-defs";

export interface VersionIndicatorProps {
  workflowId?: string;
  latestVersion: number | null;
  previewVersion: number | null;
  onPreview: (version: number) => void;
  onBackToDraft: () => void;
  onViewAll: () => void;
}

const MAX_VISIBLE_VERSIONS = 3;

export function VersionIndicator({
  workflowId,
  latestVersion,
  previewVersion,
  onPreview,
  onBackToDraft,
  onViewAll,
}: VersionIndicatorProps) {
  const { t } = useTranslation("workflows");
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<WorkflowVersionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: "setLatest" | "restore";
    version: number;
  } | null>(null);

  const loadVersions = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    try {
      const list = await workflowDefApi.getVersions(workflowId);
      setVersions(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    if (open) loadVersions();
  }, [open, loadVersions]);

  const visibleVersions = versions.slice(0, MAX_VISIBLE_VERSIONS);

  const handleSetLatest = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      setConfirmAction(null);
      try {
        await workflowDefApi.setLatest(workflowId, version);
        toast.success(t("versions.set_latest"));
        loadVersions();
      } catch (err) {
        console.error(err);
        toast.error(t("versions.operation_failed"), { description: (err as Error).message });
      }
    },
    [workflowId, loadVersions, t],
  );

  const handleRestoreToDraft = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      setConfirmAction(null);
      try {
        await workflowDefApi.restoreToDraft(workflowId, version);
        toast.success(t("versions.restore_success"));
        onBackToDraft();
        setOpen(false);
      } catch (err) {
        console.error(err);
        toast.error(t("versions.restore_failed"), { description: (err as Error).message });
      }
    },
    [workflowId, onBackToDraft, t],
  );

  const isPreviewing = previewVersion !== null;
  const badgeText = isPreviewing ? `v${previewVersion}` : t("editor.vi_badge_draft");
  const titleText = isPreviewing
    ? t("editor.vi_status_preview", { version: previewVersion })
    : t("editor.vi_status_draft");

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`wf-meta-trigger-btn ${isPreviewing ? "active" : ""}`}
            title={t("editor.tooltip_version_indicator")}
            style={{
              width: "auto",
              padding: "0 10px",
              ...(isPreviewing ? { borderColor: "#3b82f6", color: "#3b82f6" } : {}),
            }}
          >
            <GitBranch size={14} />
            <span style={{ fontSize: 10, fontWeight: 600, marginLeft: 2 }}>{badgeText}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="wf-meta-popover"
          style={{ width: 280 }}
        >
          {/* 当前状态 */}
          <div className="wf-popover-header">
            <span className="wf-popover-title">{titleText}</span>
          </div>

          {/* 返回草稿按钮（预览模式时可用） */}
          {isPreviewing && (
            <div style={{ padding: "0 12px 8px" }}>
              <button
                type="button"
                onClick={() => {
                  onBackToDraft();
                  setOpen(false);
                }}
                style={{
                  width: "100%",
                  padding: "6px 0",
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  background: "#fff",
                  color: "#374151",
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {t("editor.vi_back_to_draft")}
              </button>
            </div>
          )}

          {/* 版本列表 */}
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {loading ? (
              <div style={{ textAlign: "center", padding: 16, color: "#9ca3af", fontSize: 11 }}>
                <Loader size={14} style={{ animation: "wf-spin 1s linear infinite", display: "inline-block" }} />
              </div>
            ) : visibleVersions.length === 0 ? (
              <div style={{ textAlign: "center", padding: 16, color: "#d1d5db", fontSize: 11 }}>
                <p>{t("editor.vi_no_versions")}</p>
                <p style={{ fontSize: 9, marginTop: 2 }}>{t("editor.vi_no_versions_hint")}</p>
              </div>
            ) : (
              visibleVersions.map((v) => {
                const isLatest = latestVersion === v.version;
                const isCurrentPreview = previewVersion === v.version;
                return (
                  <div
                    key={v.id}
                    style={{
                      padding: "6px 12px",
                      borderBottom: "1px solid #f3f4f6",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: isCurrentPreview ? "#eff6ff" : undefined,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontWeight: 600,
                        color: "#111827",
                        fontSize: 11,
                        minWidth: 28,
                      }}
                    >
                      v{v.version}
                    </span>
                    {isLatest && (
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 500,
                          color: "#22c55e",
                          background: "#f0fdf4",
                          padding: "1px 4px",
                          borderRadius: 99,
                        }}
                      >
                        latest
                      </span>
                    )}
                    <div style={{ marginLeft: "auto", display: "flex", gap: 3 }}>
                      <button
                        type="button"
                        onClick={() => {
                          onPreview(v.version);
                          setOpen(false);
                        }}
                        style={{
                          padding: "2px 6px",
                          border: "1px solid #e5e7eb",
                          borderRadius: 3,
                          background: isCurrentPreview ? "#3b82f6" : "#fff",
                          color: isCurrentPreview ? "#fff" : "#6b7280",
                          fontSize: 9,
                          cursor: "pointer",
                        }}
                      >
                        {t("editor.vi_preview")}
                      </button>
                      {isCurrentPreview && (
                        <>
                          <button
                            type="button"
                            onClick={() => setConfirmAction({ type: "setLatest", version: v.version })}
                            style={{
                              padding: "2px 6px",
                              border: "1px solid #e5e7eb",
                              borderRadius: 3,
                              background: "#fff",
                              color: "#6b7280",
                              fontSize: 9,
                              cursor: "pointer",
                            }}
                            title={t("editor.vi_set_latest")}
                          >
                            <Star size={9} style={{ verticalAlign: "middle" }} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmAction({ type: "restore", version: v.version })}
                            style={{
                              padding: "2px 6px",
                              border: "1px solid #e5e7eb",
                              borderRadius: 3,
                              background: "#fff",
                              color: "#6b7280",
                              fontSize: 9,
                              cursor: "pointer",
                            }}
                            title={t("editor.vi_restore_to_draft")}
                          >
                            <RotateCcw size={9} style={{ verticalAlign: "middle" }} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* 查看全部链接 */}
          {versions.length > 0 && (
            <div style={{ padding: "6px 12px", borderTop: "1px solid #f3f4f6" }}>
              <button
                type="button"
                onClick={() => {
                  onViewAll();
                  setOpen(false);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "#3b82f6",
                  fontSize: 10,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {t("editor.vi_view_all")}
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* 确认对话框 */}
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmAction(null);
        }}
        title={confirmAction?.type === "setLatest" ? t("editor.vi_set_latest") : t("editor.vi_restore_to_draft")}
        description={
          confirmAction?.type === "restore"
            ? t("editor.vi_restore_confirm", { version: confirmAction?.version ?? 0 })
            : t("versions.set_latest_confirm", { version: confirmAction?.version ?? 0 })
        }
        variant={confirmAction?.type === "restore" ? "destructive" : "default"}
        onConfirm={() => {
          if (!confirmAction) return;
          if (confirmAction.type === "setLatest") handleSetLatest(confirmAction.version);
          else if (confirmAction.type === "restore") handleRestoreToDraft(confirmAction.version);
        }}
      />
    </>
  );
}
