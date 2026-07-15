import { useRequest } from "ahooks";
import { AlertTriangle, Clock, Inbox, RefreshCw, RotateCcw, Star } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap } from "@/src/api/request";
import { workflowDefApi } from "../../api/workflow-defs";
import { AgentPageHeader } from "../agent-panel/shared/AgentPageHeader";

interface WorkflowVersionsProps {
  workflowId: string;
  onEditWorkflow: (workflowId: string) => void;
}

export function WorkflowVersions({ workflowId, onEditWorkflow }: WorkflowVersionsProps) {
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

  // 设为最新版本
  const { run: runSetLatest } = useRequest((version: number) => workflowDefApi.setLatest(workflowId, version), {
    manual: true,
    onSuccess: () => {
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
    (version: number) => workflowDefApi.restoreToDraft(workflowId, version),
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

  function relativeTime(iso?: string | null): string {
    if (!iso) return "--";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return t("versions.relative_now");
    if (diff < 3600) return t("versions.relative_minutes", { count: Math.floor(diff / 60) });
    if (diff < 86400) return t("versions.relative_days", { count: Math.floor(diff / 86400) });
    return new Date(iso).toLocaleDateString();
  }

  if (wfLoading && !wf) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <AgentPageHeader
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
            <button
              type="button"
              onClick={() => onEditWorkflow(workflowId)}
              className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              {t("page.breadcrumb_edit")}
            </button>
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
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : versionsError ? (
        <div className="text-center py-10">
          <AlertTriangle size={32} className="text-status-error mx-auto mb-2" />
          <p className="text-[13px] text-text-secondary">{t("versions.load_failed", { error: versionsErrorMsg })}</p>
        </div>
      ) : versions.length === 0 ? (
        <div className="text-center py-10">
          <Inbox size={32} className="text-text-muted mx-auto mb-2" />
          <p className="text-[13px] text-text-muted font-medium">{t("versions.no_versions")}</p>
          <p className="text-[11px] text-text-dim mt-1">{t("versions.no_versions_hint")}</p>
        </div>
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
                <div
                  className="flex items-center gap-3 text-xs cursor-pointer"
                  onClick={() => handleViewYaml(v.version)}
                >
                  <div className="font-mono font-semibold text-text-primary min-w-[40px]">v{v.version}</div>
                  {isLatest && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-status-running bg-surface-2 px-1.5 py-px rounded-full">
                      <Star size={10} /> {t("versions.latest")}
                    </span>
                  )}
                  <span className="text-text-muted text-[11px]">
                    <Clock size={10} className="mr-0.5 align-[-1px]" />
                    {relativeTime(v.createdAt)}
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
