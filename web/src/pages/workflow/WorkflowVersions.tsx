import { AlertTriangle, Clock, Inbox, RefreshCw, RotateCcw, Star } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { type WorkflowDefItem, type WorkflowVersionItem, workflowDefApi } from "../../api/workflow-defs";
import { SkeletonVersionRows } from "./components/SkeletonRows";

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
  const [confirmAction, setConfirmAction] = useState<{ type: "setLatest" | "restore"; version: number } | null>(null);

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
      setConfirmAction(null);
      try {
        await workflowDefApi.setLatest(workflowId, version);
        loadData();
      } catch (err) {
        console.error(err);
        toast.error(t("versions.operation_failed"), { description: (err as Error).message });
      }
    },
    [workflowId, loadData, t],
  );

  const handleRestoreToDraft = useCallback(
    async (version: number) => {
      setConfirmAction(null);
      try {
        await workflowDefApi.restoreToDraft(workflowId, version);
        toast.success(t("versions.restore_success"));
      } catch (err) {
        console.error(err);
        toast.error(t("versions.restore_failed"), { description: (err as Error).message });
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
        toast.error(t("versions.yaml_load_failed"), { description: (err as Error).message });
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
    <div className="h-full overflow-y-auto p-6">
      {/* 标题 */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-base font-semibold text-text-primary m-0">
          {wf ? t("versions.title", { name: wf.name }) : t("versions.title", { name: "" })}
        </h1>
        <button
          type="button"
          onClick={loadData}
          className="flex items-center gap-1.5 px-2.5 py-1 border border-border-subtle rounded-md bg-surface-1 text-xs text-text-secondary cursor-pointer hover:bg-surface-hover transition-colors"
        >
          <RefreshCw size={13} /> {t("versions.refresh")}
        </button>
      </div>

      {/* 当前状态 */}
      {wf && (
        <div className="p-2.5 bg-surface-2 rounded-lg border border-border-subtle mb-4 text-xs text-text-secondary flex gap-4">
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
        <SkeletonVersionRows rows={3} />
      ) : error ? (
        <div className="text-center py-10">
          <AlertTriangle size={32} className="text-status-error mx-auto mb-2" />
          <p className="text-[13px] text-text-secondary">{t("versions.load_failed", { error })}</p>
        </div>
      ) : versions.length === 0 ? (
        <div className="text-center py-10">
          <Inbox size={32} className="text-text-muted mx-auto mb-2" />
          <p className="text-[13px] text-text-muted font-medium">{t("versions.no_versions")}</p>
          <p className="text-[11px] text-text-dim mt-1">{t("versions.no_versions_hint")}</p>
        </div>
      ) : (
        <div className="border border-border-subtle rounded-lg overflow-hidden bg-surface-1">
          {versions.map((v) => {
            const isLatest = wf?.latestVersion === v.version;
            const isViewing = viewingVersion === v.version;

            return (
              <div key={v.id} className="border-b border-border-subtle">
                <div
                  className="flex items-center gap-3 px-4 py-3 text-xs cursor-pointer hover:bg-surface-hover transition-colors"
                  onClick={() => handleViewYaml(v.version)}
                >
                  {/* 版本号 */}
                  <div className="font-mono font-semibold text-text-primary min-w-[40px]">v{v.version}</div>

                  {/* latest 标记 */}
                  {isLatest && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-status-running bg-surface-2 px-1.5 py-px rounded-full">
                      <Star size={10} /> {t("versions.latest")}
                    </span>
                  )}

                  {/* 时间 */}
                  <span className="text-text-muted text-[11px]">
                    <Clock size={10} className="mr-0.5 align-[-1px]" />
                    {relativeTime(v.createdAt)}
                  </span>

                  {/* 操作 */}
                  <div className="ml-auto flex gap-1" onClick={(e) => e.stopPropagation()}>
                    {!isLatest && (
                      <button
                        type="button"
                        title={t("versions.set_latest")}
                        onClick={() => setConfirmAction({ type: "setLatest", version: v.version })}
                        className="flex items-center gap-1 px-2 py-0.5 border border-border-subtle rounded text-[10px] text-text-secondary bg-surface-1 cursor-pointer hover:bg-surface-hover transition-colors"
                      >
                        <Star size={10} /> {t("versions.set_latest")}
                      </button>
                    )}
                    <button
                      type="button"
                      title={t("versions.restore_to_draft")}
                      onClick={() => setConfirmAction({ type: "restore", version: v.version })}
                      className="flex items-center gap-1 px-2 py-0.5 border border-border-subtle rounded text-[10px] text-text-secondary bg-surface-1 cursor-pointer hover:bg-surface-hover transition-colors"
                    >
                      <RotateCcw size={10} /> {t("versions.restore_to_draft")}
                    </button>
                  </div>
                </div>

                {/* YAML 展开区域 */}
                {isViewing && viewingYaml !== null && (
                  <div className="px-4 pb-3">
                    <pre className="bg-surface-2 border border-border-subtle rounded-md p-2.5 text-[11px] font-mono text-text-secondary max-h-[300px] overflow-auto m-0 whitespace-pre-wrap">
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
          if (confirmAction?.type === "setLatest") handleSetLatest(confirmAction.version);
          else if (confirmAction?.type === "restore") handleRestoreToDraft(confirmAction.version);
        }}
      />
    </div>
  );
}
