import { Button } from "@fenix/ui-components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@fenix/ui-components/ui/popover";
import { unwrap } from "@fenix/web-runtime/api/request";
import { GitBranch } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type WorkflowVersionItem, workflowDefApi } from "../../../api/workflow-defs";
import { InlineLoader } from "./InlineLoader";
import { PopoverHeader } from "./PopoverHeader";
import { VersionConfirmDialog } from "./VersionConfirmDialog";
import { VersionRow } from "./VersionRow";

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
      const list = await unwrap(workflowDefApi.getVersions(workflowId));
      setVersions(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error(err);
      // popover 由用户点开，失败时列表会变成「暂无发布版本」，不给提示会被当成真的没有版本
      toast.error(t("versions.load_data_failed"));
    } finally {
      setLoading(false);
    }
  }, [workflowId, t]);

  useEffect(() => {
    if (open) loadVersions();
  }, [open, loadVersions]);

  const visibleVersions = versions.slice(0, MAX_VISIBLE_VERSIONS);

  const handleSetLatest = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      try {
        await unwrap(workflowDefApi.setLatest(workflowId, version));
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
      try {
        await unwrap(workflowDefApi.restoreToDraft(workflowId, version));
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
          <PopoverHeader title={titleText} />

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
                <InlineLoader size={14} />
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
                  <VersionRow
                    key={v.id}
                    version={v}
                    isLatest={isLatest}
                    labels={{
                      latest: t("versions.latest"),
                      setLatest: t("editor.vi_set_latest"),
                      restoreToDraft: t("editor.vi_restore_to_draft"),
                    }}
                    // 预览态整行高亮是与「展开了原文」不同的语义，且只有弹层有这一态
                    active={isCurrentPreview}
                    // 窄弹层：破坏性动作只留图标位（可访问名由 VersionRow 的 aria-label 承载）
                    iconActions
                    extraActions={
                      <Button
                        size="xs"
                        variant={isCurrentPreview ? "default" : "outline"}
                        title={t("editor.vi_preview")}
                        onClick={() => {
                          onPreview(v.version);
                          setOpen(false);
                        }}
                      >
                        {t("editor.vi_preview")}
                      </Button>
                    }
                    // 破坏性动作只对「当前预览的那一版」提供：弹层内一行放不下四个按钮，
                    // 且先预览再决定也避免在看错版本时误改 latest
                    onSetLatest={
                      isCurrentPreview ? () => setConfirmAction({ type: "setLatest", version: v.version }) : undefined
                    }
                    onRestore={
                      isCurrentPreview ? () => setConfirmAction({ type: "restore", version: v.version }) : undefined
                    }
                    // 弹层行更紧：行分隔与内衬在行上；没有行底色 hover（弹层没有整行点击/展开位）
                    className="border-b border-border-light px-3 py-1.5"
                  />
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

      {/* 确认对话框：与版本页 / 版本面板同一份接线（确认后由它关闭待确认动作） */}
      <VersionConfirmDialog
        action={confirmAction}
        labels={{
          setLatestTitle: t("editor.vi_set_latest"),
          restoreTitle: t("editor.vi_restore_to_draft"),
          setLatestDescription: (version) => t("versions.set_latest_confirm", { version }),
          restoreDescription: (version) => t("editor.vi_restore_confirm", { version }),
        }}
        onClose={() => setConfirmAction(null)}
        onConfirm={(action) => {
          if (action.type === "setLatest") handleSetLatest(action.version);
          else handleRestoreToDraft(action.version);
        }}
      />
    </>
  );
}
