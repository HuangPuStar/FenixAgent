import { unwrap } from "@fenix/web-runtime/api/request";
import { Inbox, Loader, Rocket, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { workflowDefApi } from "../../../api/workflow-defs";
import { VersionConfirmDialog } from "./VersionConfirmDialog";
import { VersionRow } from "./VersionRow";

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
  // 破坏性操作前必须二次确认（参考 VersionIndicator 同模式）
  const [confirmAction, setConfirmAction] = useState<{
    type: "setLatest" | "restore";
    version: number;
  } | null>(null);
  const { t, i18n } = useTranslation("workflows");

  const loadData = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    // 独立加载 wf 和版本列表，某一项失败不影响另一项的展示
    const [wfResult, versionsResult] = await Promise.allSettled([
      unwrap(workflowDefApi.get(workflowId)),
      unwrap(workflowDefApi.getVersions(workflowId)),
    ]);
    if (wfResult.status === "fulfilled") {
      setWf(wfResult.value);
    } else {
      console.error("VersionPanel: 获取工作流详情失败", wfResult.reason);
    }
    if (versionsResult.status === "fulfilled") {
      setVersions(Array.isArray(versionsResult.value) ? versionsResult.value : []);
    } else {
      console.error("VersionPanel: 获取版本列表失败", versionsResult.reason);
    }
    if (wfResult.status === "rejected" || versionsResult.status === "rejected") {
      // 失败会让面板退化成「暂无发布版本」的空态，用户无从分辨；两项都失败也只报一条
      toast.error(t("versions.load_data_failed"));
    }
    setLoading(false);
  }, [workflowId, t]);

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
        await unwrap(workflowDefApi.setLatest(workflowId, version));
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
        await unwrap(workflowDefApi.restoreToDraft(workflowId, version));
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
        const result = await unwrap(workflowDefApi.getVersion(workflowId, version));
        setViewingVersion(version);
        setViewingYaml(result.yaml);
      } catch (err) {
        console.error(err);
        // 整行点击展开 YAML 是用户主动操作，失败时行不会展开，不给提示会被当成点击没响应
        toast.error(t("versions.yaml_load_failed"));
      }
    },
    [workflowId, viewingVersion, t],
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
          // 纯图标按钮：可访问名只能由 aria-label 提供（面板标题已由 wf-prop-title 承载，X 只表示关闭）
          aria-label={t("editor.version_panel_close")}
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
            {t("versions.latest")}:{" "}
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
            return (
              // 面板的行是「下边框分隔的一段」，内衬与 hover 底色在行本身上（版本页是卡片、弹层更紧）
              <div key={v.id} className="border-b border-border-light">
                <VersionRow
                  version={v}
                  isLatest={isLatest}
                  labels={{
                    latest: t("versions.latest"),
                    setLatest: t("editor.vi_set_latest"),
                    restoreToDraft: t("editor.vi_restore_to_draft"),
                  }}
                  // 面板与版本页的信息密度差异：这里给绝对日期，版本页给相对时间，弹层不给
                  // 日期取当前 locale（§9.3）：固定 zh-CN 会让英文界面显示中文格式
                  meta={new Date(v.createdAt).toLocaleString(i18n.language, {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  expand={{
                    expanded: isViewing,
                    yaml: viewingYaml,
                    label: t("versions.view_yaml", { version: v.version }),
                    onToggle: () => handleViewYaml(v.version),
                  }}
                  onSetLatest={() => setConfirmAction({ type: "setLatest", version: v.version })}
                  onRestore={() => setConfirmAction({ type: "restore", version: v.version })}
                  className="px-3 py-2 hover:bg-surface-2"
                  yamlClassName="px-3 pb-2"
                />
              </div>
            );
          })
        )}
      </div>

      {/* 破坏性操作二次确认：与版本页 / 版本弹层同一份接线（标题与正文各取自己那族 key） */}
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
