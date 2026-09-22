import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { Link } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { AlertTriangle, Clock, Inbox, RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { workflowDefApi } from "../../api/workflow-defs";
import { VersionConfirmDialog } from "./components/VersionConfirmDialog";
import { VersionRow } from "./components/VersionRow";
import { isUnauthorizedError, relativeTime } from "./utils";

interface WorkflowVersionsProps {
  workflowId: string;
  onEditWorkflow: (workflowId: string) => void;
}

/**
 * 版本列表骨架：工作流详情与版本列表两处加载态原先各写一份逐字副本（只有键前缀不同），这里是唯一实现。
 *
 * 占位行没有领域标识：先生成键数组再渲染，避免下标直接作为 key（骨架屏不重排、无行内状态）。
 * 不用包内既有的 `SkeletonVersionRows`——它占位的是「一张卡片内多行分隔」的旧列表形态，
 * 而本页加载完成后是「多条独立卡片」（`space-y-2`），骨架与终态不同形会看出跳变。
 */
function VersionListSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: 3 }, (_, i) => `version-skeleton-${i}`).map((rowKey) => (
        <Skeleton key={rowKey} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
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
    return <VersionListSkeleton label={t("versions.loading")} />;
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
        <VersionListSkeleton label={t("versions.loading")} />
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
          {versions.map((v) => (
            <VersionRow
              key={v.id}
              version={v}
              isLatest={wf?.latestVersion === v.version}
              labels={{
                latest: t("versions.latest"),
                setLatest: t("versions.set_latest"),
                restoreToDraft: t("versions.restore_to_draft"),
              }}
              meta={
                <>
                  <Clock className="size-3" />
                  {relativeTime(t, v.createdAt, "versions")}
                </>
              }
              // 整行是展开/收起 YAML 的键盘入口（行内动作列不做展开）：语义与焦点环由 VersionRow 承载
              expand={{
                expanded: viewingVersion === v.version,
                yaml: viewingYaml,
                label: t("versions.view_yaml", { version: v.version }),
                onToggle: () => handleViewYaml(v.version),
              }}
              onSetLatest={() => setConfirmAction({ type: "setLatest", version: v.version })}
              onRestore={() => setConfirmAction({ type: "restore", version: v.version })}
              // 版本页的行是一张卡片：边框与内衬都在行本身上（hover 反馈也在此，别的容器用行底色）
              className="rounded-lg border border-border-light bg-surface-1 px-4 py-3 hover:border-border-active hover:shadow-sm"
            />
          ))}
        </div>
      )}

      <VersionConfirmDialog
        action={confirmAction}
        labels={{
          setLatestTitle: t("versions.set_latest"),
          restoreTitle: t("versions.restore_to_draft"),
          setLatestDescription: (version) => t("versions.set_latest_confirm", { version }),
          restoreDescription: (version) => t("versions.restore_confirm", { version }),
        }}
        onClose={() => setConfirmAction(null)}
        onConfirm={(action) => {
          if (action.type === "setLatest") runSetLatest(action.version);
          else runRestoreToDraft(action.version);
        }}
      />
    </div>
  );
}
