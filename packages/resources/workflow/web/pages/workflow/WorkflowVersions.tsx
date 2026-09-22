import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { Link } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { AlertTriangle, Clock, Inbox, RefreshCw, RotateCcw, ShieldAlert, Star } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { workflowDefApi } from "../../api/workflow-defs";
import { isUnauthorizedError, relativeTime } from "./utils";

interface WorkflowVersionsProps {
  workflowId: string;
  onEditWorkflow: (workflowId: string) => void;
}

export function WorkflowVersions({ workflowId }: WorkflowVersionsProps) {
  const { t } = useTranslation("workflows");
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [viewingYaml, setViewingYaml] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: "setLatest" | "restore"; version: number } | null>(null);

  // 加载 workflow 详情
  const {
    data: wf,
    loading: wfLoading,
    refresh: wfRefresh,
  } = useRequest(() => unwrap(workflowDefApi.get(workflowId)), { refreshDeps: [workflowId] });

  // 加载版本列表
  const {
    data: versionsResult = [],
    loading: versionsLoading,
    error: versionsError,
    refresh: versionsRefresh,
  } = useRequest(() => unwrap(workflowDefApi.getVersions(workflowId)), { refreshDeps: [workflowId] });
  const versions = Array.isArray(versionsResult) ? versionsResult : [];
  const versionsErrorMsg = versionsError
    ? versionsError instanceof Error
      ? versionsError.message
      : String(versionsError)
    : null;
  const unauthorized = isUnauthorizedError(versionsError);

  // 设为最新版本
  const { run: runSetLatest } = useRequest((version: number) => unwrap(workflowDefApi.setLatest(workflowId, version)), {
    manual: true,
    onSuccess: () => {
      // 列表刷新会换掉 latest 徽标，但「哪一次操作生效了」仍需一句明说（同页恢复操作同口径）
      toast.success(t("versions.set_latest_success"));
      wfRefresh();
      versionsRefresh();
    },
    onError: (err) => {
      console.error(err);
      toast.error(t("versions.operation_failed"), { description: (err as Error).message });
    },
  });

  // 恢复到草稿
  const { run: runRestoreToDraft } = useRequest(
    (version: number) => unwrap(workflowDefApi.restoreToDraft(workflowId, version)),
    {
      manual: true,
      onSuccess: () => toast.success(t("versions.restore_success")),
      onError: (err) => {
        console.error(err);
        toast.error(t("versions.restore_failed"), { description: (err as Error).message });
      },
    },
  );

  // 查看版本 YAML（展开/收起切换）
  const handleViewYaml = async (version: number) => {
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
      toast.error(t("versions.yaml_load_failed"), { description: (err as Error).message });
    }
  };

  if (wfLoading && !wf) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-busy="true" aria-label={t("versions.loading")}>
        {/* 占位行没有领域标识：先生成键数组再渲染，避免下标直接作为 key（骨架屏不重排、无行内状态）。 */}
        {Array.from({ length: 3 }, (_, i) => `version-skeleton-${i}`).map((rowKey) => (
          <Skeleton key={rowKey} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <AppHeader
        title={wf?.name ?? t("versions.title", { name: "" })}
        subtitle={wf?.description ?? undefined}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                wfRefresh();
                versionsRefresh();
              }}
            >
              <RefreshCw size={13} className="mr-1" /> {t("versions.refresh")}
            </Button>
            <Link
              to="/agent/workflow/$id/edit"
              params={{ id: workflowId }}
              className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              {t("page.breadcrumb_edit")}
            </Link>
          </>
        }
      />

      {/* 当前状态 */}
      {wf && (
        <div className="mb-3 flex gap-4 rounded-lg border border-border-light bg-surface-1 px-4 py-2.5 text-xs text-text-secondary">
          <span>
            {t("versions.latest_label", {
              value: wf.latestVersion ? `v${wf.latestVersion}` : t("versions.latest_not_set"),
            })}
          </span>
          <span>{t("versions.published_count", { count: versions.length })}</span>
        </div>
      )}

      {/* 内容 */}
      {versionsLoading ? (
        <div className="flex flex-col gap-2" role="status" aria-busy="true" aria-label={t("versions.loading")}>
          {/* 占位行没有领域标识：先生成键数组再渲染，避免下标直接作为 key（骨架屏不重排、无行内状态）。 */}
          {Array.from({ length: 3 }, (_, i) => `version-list-skeleton-${i}`).map((rowKey) => (
            <Skeleton key={rowKey} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : versionsError ? (
        // 持久错误分支：不能只弹 toast 就落回「暂无发布版本」，否则用户以为是没有版本可用。
        // 无权限单独渲染且不带重试（401 需重新登录、403 是永久拒绝，重试不会改变结果）。
        unauthorized ? (
          <EmptyState
            icon={<ShieldAlert />}
            title={t("versions.unauthorized_title")}
            description={t("versions.unauthorized_hint")}
            tone="danger"
            role="alert"
          />
        ) : (
          <EmptyState
            icon={<AlertTriangle />}
            title={t("versions.load_failed", { error: versionsErrorMsg })}
            tone="danger"
            role="alert"
            action={{ label: t("versions.retry"), onClick: versionsRefresh, icon: <RefreshCw /> }}
          />
        )
      ) : versions.length === 0 ? (
        <EmptyState icon={<Inbox />} title={t("versions.no_versions")} description={t("versions.no_versions_hint")} />
      ) : (
        <div className="space-y-2">
          {versions.map((v) => {
            const isLatest = wf?.latestVersion === v.version;
            const isViewing = viewingVersion === v.version;

            return (
              <div
                key={v.id}
                className="rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm"
              >
                {/*
                  整行点击 = 展开/收起该版本 YAML。这在包里没有等价的键盘入口（操作列只有
                  「设为 latest / 恢复到草稿」，都不做展开），所以整行必须自己是可聚焦控件：
                  role="button" + tabIndex + Enter/Space 键处理。Space 默认会滚动页面，需 preventDefault。
                  aria-expanded 暴露展开状态，aria-label 给整行一个不含内部按钮文案的可访问名。
                  focus-visible 用与 ui/button 相同的 ring token，键盘焦点才可见。
                */}
                <div
                  className="flex items-center gap-3 text-xs cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  role="button"
                  tabIndex={0}
                  aria-expanded={isViewing}
                  aria-label={t("versions.view_yaml", { version: v.version })}
                  onClick={() => handleViewYaml(v.version)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    // 后代隔离：行内操作列有真实的 <button>，落在它们身上的 Enter/Space 属于按钮自身，
                    // 必须原样冒泡给浏览器默认激活；这里抢过来既会 preventDefault 掉按钮的默认激活，
                    // 又会让整行误展开 YAML。整行只处理落在自己身上的按键。
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    handleViewYaml(v.version);
                  }}
                >
                  <div className="font-mono font-semibold text-text-primary min-w-[40px]">v{v.version}</div>
                  {isLatest && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-status-running bg-surface-2 px-1.5 py-px rounded-full">
                      <Star size={10} /> {t("versions.latest")}
                    </span>
                  )}
                  <span className="text-text-muted text-[11px]">
                    <Clock size={10} className="mr-0.5 align-[-1px]" />
                    {relativeTime(t, v.createdAt, "versions")}
                  </span>
                  <div className="ml-auto flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {!isLatest && (
                      <Button
                        size="xs"
                        variant="outline"
                        title={t("versions.set_latest")}
                        onClick={() => setConfirmAction({ type: "setLatest", version: v.version })}
                      >
                        <Star size={10} className="mr-0.5" /> {t("versions.set_latest")}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="outline"
                      title={t("versions.restore_to_draft")}
                      onClick={() => setConfirmAction({ type: "restore", version: v.version })}
                    >
                      <RotateCcw size={10} className="mr-0.5" /> {t("versions.restore_to_draft")}
                    </Button>
                  </div>
                </div>

                {isViewing && viewingYaml !== null && (
                  <div className="mt-2">
                    <pre className="bg-surface-2 border border-border-light rounded-md p-2.5 text-[11px] font-mono text-text-secondary max-h-[300px] overflow-auto m-0 whitespace-pre-wrap">
                      {viewingYaml}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        title={confirmAction?.type === "setLatest" ? t("versions.set_latest") : t("versions.restore_to_draft")}
        description={
          confirmAction?.type === "setLatest"
            ? t("versions.set_latest_confirm", { version: confirmAction?.version ?? 0 })
            : t("versions.restore_confirm", { version: confirmAction?.version ?? 0 })
        }
        variant={confirmAction?.type === "restore" ? "destructive" : "default"}
        onConfirm={() => {
          if (confirmAction?.type === "setLatest") runSetLatest(confirmAction.version);
          else if (confirmAction?.type === "restore") runRestoreToDraft(confirmAction.version);
        }}
      />
    </div>
  );
}
