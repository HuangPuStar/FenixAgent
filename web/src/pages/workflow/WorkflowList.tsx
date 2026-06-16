import { AlertTriangle, Inbox, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type WorkflowDefItem, workflowDefApi } from "../../api/workflow-defs";
import { AgentCardList } from "../agent-panel/shared/AgentCardList";
import { SkeletonTable } from "./components/SkeletonRows";

interface WorkflowListProps {
  onEditWorkflow: (workflowId: string) => void;
  onViewVersions: (workflowId: string) => void;
  createRequested?: number;
}

export function WorkflowList({ onEditWorkflow, onViewVersions, createRequested }: WorkflowListProps) {
  const { t } = useTranslation("workflows");
  const [workflows, setWorkflows] = useState<WorkflowDefItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowDefItem | null>(null);

  // 恢复相关
  const [recoverableIds, setRecoverableIds] = useState<string[]>([]);
  const [selectedRecoverIds, setSelectedRecoverIds] = useState<Set<string>>(new Set());
  const [showRecoverPanel, setShowRecoverPanel] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [searchQuery] = useState("");

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await workflowDefApi.list();
      setWorkflows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // 响应外部新建请求（createRequested 递增时触发）
  const prevCreateRequestedRef = useRef(createRequested);
  useEffect(() => {
    if (createRequested !== 0 && createRequested !== prevCreateRequestedRef.current) {
      setShowCreateDialog(true);
    }
    prevCreateRequestedRef.current = createRequested;
  }, [createRequested]);

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const wf = await workflowDefApi.create(createName.trim(), createDesc.trim() || undefined);
      setShowCreateDialog(false);
      setCreateName("");
      setCreateDesc("");
      onEditWorkflow(wf.id);
    } catch (err) {
      console.error(err);
      toast.error(t("list.create_error"), { description: (err as Error).message });
    } finally {
      setCreating(false);
    }
  }, [createName, createDesc, onEditWorkflow, t]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await workflowDefApi.delete(deleteTarget.id);
      loadList();
    } catch (err) {
      console.error(err);
      toast.error(t("list.delete_failed"), { description: (err as Error).message });
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, loadList, t]);

  const _handleScanRecover = useCallback(async () => {
    try {
      const ids = await workflowDefApi.recover();
      setRecoverableIds(ids);
      setSelectedRecoverIds(new Set());
      setShowRecoverPanel(true);
    } catch (err) {
      console.error(err);
      toast.error(t("list.scan_failed"), { description: (err as Error).message });
    }
  }, [t]);

  const handleRecoverApply = useCallback(async () => {
    if (selectedRecoverIds.size === 0) return;
    setRecovering(true);
    try {
      await workflowDefApi.recoverApply(Array.from(selectedRecoverIds));
      setShowRecoverPanel(false);
      loadList();
    } catch (err) {
      console.error(err);
      toast.error(t("list.recover_failed"), { description: (err as Error).message });
    } finally {
      setRecovering(false);
    }
  }, [selectedRecoverIds, loadList, t]);

  function relativeTime(iso?: string | null): string {
    if (!iso) return "--";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return t("list.relative_now");
    if (diff < 3600) return t("list.relative_minutes", { count: Math.floor(diff / 60) });
    if (diff < 86400) return t("list.relative_hours", { count: Math.floor(diff / 3600) });
    return new Date(iso).toLocaleDateString();
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* 恢复面板 */}
      {showRecoverPanel && (
        <div className="mb-4 p-3 border border-warning-border rounded-lg bg-warning-bg text-xs">
          <div className="font-semibold mb-2 text-warning-text">
            {t("list.recoverable_title", { count: recoverableIds.length })}
          </div>
          {recoverableIds.length === 0 ? (
            <p className="text-text-muted">{t("list.no_recoverable")}</p>
          ) : (
            <>
              {recoverableIds.map((id) => (
                <label key={id} className="flex items-center gap-1.5 mb-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedRecoverIds.has(id)}
                    onChange={(e) => {
                      setSelectedRecoverIds((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(id);
                        else next.delete(id);
                        return next;
                      });
                    }}
                  />
                  <span className="font-mono text-[11px]">{id}</span>
                </label>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={handleRecoverApply}
                disabled={recovering || selectedRecoverIds.size === 0}
              >
                {recovering ? t("list.recovering") : t("list.recover_selected", { count: selectedRecoverIds.size })}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowRecoverPanel(false)}
            className="mt-1 text-warning-text"
          >
            {t("list.close")}
          </Button>
        </div>
      )}

      {/* 新建对话框 */}
      <Dialog
        open={showCreateDialog}
        onOpenChange={(open) => {
          setShowCreateDialog(open);
          if (!open) {
            setCreateName("");
            setCreateDesc("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("list.create_title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-2">
              <Label htmlFor="wf-name">{t("list.name_label")}</Label>
              <Input
                id="wf-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="my-workflow"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wf-desc">{t("list.desc_label")}</Label>
              <Textarea
                id="wf-desc"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder={t("list.desc_placeholder")}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowCreateDialog(false);
                setCreateName("");
                setCreateDesc("");
              }}
            >
              {t("list.cancel")}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={creating || !createName.trim()}>
              {creating ? t("list.creating") : t("list.create_and_edit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 内容 */}
      {loading ? (
        <SkeletonTable cols="2fr 100px 120px 80px" rows={4} />
      ) : error ? (
        <div className="text-center py-10">
          <AlertTriangle size={32} className="text-status-error mx-auto mb-2" />
          <p className="text-[13px] text-text-secondary">{t("list.load_failed", { error })}</p>
        </div>
      ) : workflows.length === 0 ? (
        <div className="text-center py-10">
          <Inbox size={32} className="text-text-muted mx-auto mb-2" />
          <p className="text-[13px] text-text-muted font-medium">{t("list.no_workflows")}</p>
          <p className="text-[11px] text-text-dim mt-1">{t("list.no_workflows_hint")}</p>
        </div>
      ) : (
        <AgentCardList
          items={workflows}
          cardKey={(wf) => wf.id}
          searchPlaceholder={t("list.search_placeholder")}
          searchFn={(wf, query) => wf.name.toLowerCase().includes(query)}
          emptyMessage={searchQuery ? t("list.no_match") : t("list.no_workflows")}
          renderCard={(wf) => (
            <div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-bright">{wf.name}</span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        wf.latestVersion
                          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                          : "bg-surface-2 text-text-muted"
                      }`}
                    >
                      {wf.latestVersion ? `v${wf.latestVersion}` : t("list.not_published")}
                    </span>
                  </div>
                  {wf.description && <div className="text-xs text-text-muted mt-1 truncate">{wf.description}</div>}
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-text-dim">
                    <span>
                      {t("list.table_modified")}: {relativeTime(wf.updatedAt)}
                    </span>
                  </div>
                </div>
                <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button size="xs" variant="outline" onClick={() => onEditWorkflow(wf.id)}>
                    {t("list.edit")}
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => onViewVersions(wf.id)}>
                    {t("list.version_history")}
                  </Button>
                  <Button size="xs" variant="destructive" onClick={() => setDeleteTarget(wf)}>
                    <Trash2 size={12} />
                  </Button>
                </div>
              </div>
            </div>
          )}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("list.delete")}
        description={t("list.delete_confirm", { name: deleteTarget?.name ?? "" })}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
