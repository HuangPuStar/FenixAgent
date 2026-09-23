import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { AlertTriangle, Inbox, Rocket } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type WorkflowDefItem, type WorkflowVersionItem, workflowDefApi } from "../../../api/workflow-defs";
import { InlineLoader } from "./InlineLoader";
import { PanelHeader } from "./PanelHeader";
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
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [viewingYaml, setViewingYaml] = useState<string | null>(null);
  const [publishingLocal, setPublishingLocal] = useState(false);
  // 破坏性操作前必须二次确认（参考 VersionIndicator 同模式）
  const [confirmAction, setConfirmAction] = useState<{
    type: "setLatest" | "restore";
    version: number;
  } | null>(null);
  const { t, i18n } = useTranslation("workflows");

  // 两份资源各自的取消句柄（§3.4）：并行加载时不能共用一个 controller，否则后发的会掐掉先发的。
  const wfAbortRef = useRef<AbortController | null>(null);
  const versionsAbortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      wfAbortRef.current?.abort();
      versionsAbortRef.current?.abort();
    },
    [],
  );

  /** 取本次请求的信号，同时取消同一资源上一笔在途请求（换工作流 / 重试时不留双份请求）。 */
  const renewSignal = (ref: typeof wfAbortRef): AbortSignal => {
    ref.current?.abort();
    const controller = new AbortController();
    ref.current = controller;
    return controller.signal;
  };

  /**
   * 详情与版本列表**各自一份 `useRequest`**（§3.4）。
   *
   * 为什么不是合并成一份：改造前的 `Promise.allSettled` 刻意让「某一项失败不影响另一项」，合并后
   * 任一失败都会把两份数据一起丢、面板整体落失败态，反而比改造前更差。三态由各自的
   * `data` / `loading` / `error` 派生，不再手写 `useCallback` + `useEffect` + `setState`。
   */
  const { data: wfData, refresh: reloadWf } = useRequest(
    async () => {
      if (!workflowId) return null;
      const wf = await unwrap(workflowDefApi.get(workflowId, { signal: renewSignal(wfAbortRef) }));
      return wf ?? null;
    },
    {
      ready: !!workflowId,
      refreshDeps: [workflowId],
      onError: (err) => {
        // 头部那一行只是补充信息，失败时整行不渲染；提示与版本列表共用一条（与改造前 allSettled 的口径一致）
        console.error("VersionPanel: 获取工作流详情失败", err);
        toast.error(t("versions.load_data_failed"));
      },
    },
  );
  const wf: WorkflowDefItem | null = wfData ?? null;

  const {
    data: versionsData,
    loading,
    error,
    refresh: reloadVersions,
  } = useRequest(
    async () => {
      if (!workflowId) return [];
      const list = await unwrap(workflowDefApi.getVersions(workflowId, { signal: renewSignal(versionsAbortRef) }));
      return Array.isArray(list) ? list : [];
    },
    {
      ready: !!workflowId,
      refreshDeps: [workflowId],
      // 失败反馈由下方的持久失败块承担（`role="alert"` + 重试），不再叠 toast——
      // 改造前「失败只剩 toast、列表回落成『暂无发布版本』」，用户无从分辨失败与「没有版本」（§3.4）
      onError: (err) => console.error("VersionPanel: 获取版本列表失败", err),
    },
  );
  const versions: WorkflowVersionItem[] = versionsData ?? [];
  const versionsError = error ? (error instanceof Error ? error.message : String(error)) : null;

  /** 两个资源一起重查（发布 / 改 latest 之后头部与列表都会变）。 */
  const reloadAll = useCallback(() => {
    reloadWf();
    reloadVersions();
  }, [reloadWf, reloadVersions]);

  const handlePublishClick = useCallback(async () => {
    setPublishingLocal(true);
    try {
      await onPublish();
      reloadAll();
    } catch (err) {
      console.error(err);
    } finally {
      setPublishingLocal(false);
    }
  }, [onPublish, reloadAll]);

  const handleSetLatest = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      try {
        await unwrap(workflowDefApi.setLatest(workflowId, version));
        reloadAll();
      } catch (err) {
        console.error(err);
        toast.error(`${t("versions.operation_failed")}: ${(err as Error).message}`);
      }
    },
    [workflowId, reloadAll, t],
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
      <PanelHeader
        title={t("editor.version_management")}
        closeLabel={t("editor.version_panel_close")}
        onClose={onClose}
      />

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
            <InlineLoader />
            <p style={{ marginTop: 4 }}>{t("editor.load_failed")}</p>
          </div>
        ) : versionsError ? (
          // 失败是持久分支：改造前只弹 toast，列表落回「暂无发布版本」——把故障伪装成「确实没有版本」
          <EmptyState
            tone="danger"
            role="alert"
            className="px-3 py-6"
            icon={<AlertTriangle />}
            title={t("versions.load_data_failed")}
            description={versionsError}
            action={{ label: t("versions.retry"), onClick: reloadVersions }}
          />
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
