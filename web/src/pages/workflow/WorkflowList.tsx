import { AlertTriangle, ChevronRight, Inbox, Plus, RefreshCw, RotateCcw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type WorkflowDefItem, workflowDefApi } from "../../api/workflow-defs";
import { SkeletonTable } from "./components/SkeletonRows";

interface WorkflowListProps {
  onEditWorkflow: (workflowId: string) => void;
  onViewVersions: (workflowId: string) => void;
}

export function WorkflowList({ onEditWorkflow, onViewVersions }: WorkflowListProps) {
  const { t } = useTranslation("workflows");
  const [workflows, setWorkflows] = useState<WorkflowDefItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
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

  const filtered = workflows.filter((w) => {
    if (searchQuery && !w.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

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

  const handleScanRecover = useCallback(async () => {
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
    <div className="h-full overflow-y-auto p-6">
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-base font-semibold text-text-primary m-0">{t("list.title")}</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleScanRecover}
            className="flex items-center gap-1.5 px-2.5 py-1 border border-border-subtle rounded-md bg-surface-1 text-xs text-text-secondary cursor-pointer hover:bg-surface-hover transition-colors"
          >
            <RotateCcw size={13} /> {t("list.scan_recover")}
          </button>
          <button
            type="button"
            onClick={loadList}
            className="flex items-center gap-1.5 px-2.5 py-1 border border-border-subtle rounded-md bg-surface-1 text-xs text-text-secondary cursor-pointer hover:bg-surface-hover transition-colors"
          >
            <RefreshCw size={13} /> {t("list.refresh")}
          </button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="flex gap-2.5 mb-4 items-center">
        <div className="flex items-center gap-1.5 flex-1 max-w-[260px] border border-border-subtle rounded-md px-2.5 py-1.5 bg-surface-1">
          <Search size={13} className="text-text-muted shrink-0" />
          <input
            placeholder={t("list.search_placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="border-none outline-none text-xs w-full bg-transparent text-text-primary"
          />
        </div>
        <button
          type="button"
          onClick={() => setShowCreateDialog(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 border-none rounded-md bg-brand text-white text-xs font-medium cursor-pointer hover:bg-brand-light transition-colors"
        >
          <Plus size={14} /> {t("list.create")}
        </button>
      </div>

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
              <button
                type="button"
                onClick={handleRecoverApply}
                disabled={recovering || selectedRecoverIds.size === 0}
                className="mt-2 px-2.5 py-1 border-none rounded bg-warning-border text-white text-[11px] cursor-pointer disabled:opacity-50"
              >
                {recovering ? t("list.recovering") : t("list.recover_selected", { count: selectedRecoverIds.size })}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setShowRecoverPanel(false)}
            className="mt-1 bg-transparent border-none text-warning-text cursor-pointer text-[11px]"
          >
            {t("list.close")}
          </button>
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
            <div>
              <label className="block text-xs text-text-secondary mb-1">{t("list.name_label")}</label>
              <input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="my-workflow"
                className="w-full rounded-md border border-border px-2.5 py-1.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">{t("list.desc_label")}</label>
              <textarea
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder={t("list.desc_placeholder")}
                rows={2}
                className="w-full rounded-md border border-border px-2.5 py-1.5 text-sm outline-none resize-y focus:border-brand focus:ring-1 focus:ring-brand"
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
      ) : filtered.length === 0 ? (
        <div className="text-center py-10">
          <Inbox size={32} className="text-text-muted mx-auto mb-2" />
          <p className="text-[13px] text-text-muted font-medium">
            {searchQuery ? t("list.no_match") : t("list.no_workflows")}
          </p>
          <p className="text-[11px] text-text-dim mt-1">{t("list.no_workflows_hint")}</p>
        </div>
      ) : (
        <div className="border border-border-subtle rounded-lg overflow-hidden bg-surface-1">
          {/* 表头 */}
          <div className="grid grid-cols-[2fr_100px_120px_80px] gap-2 px-4 py-2 bg-surface-2 border-b border-border-subtle text-[11px] font-semibold text-text-muted uppercase tracking-wide">
            <span>{t("list.table_name")}</span>
            <span>{t("list.table_version")}</span>
            <span>{t("list.table_modified")}</span>
            <span></span>
          </div>

          {/* 数据行 */}
          {filtered.map((wf) => (
            <div
              key={wf.id}
              onClick={() => onEditWorkflow(wf.id)}
              className="grid grid-cols-[2fr_100px_120px_80px] gap-2 px-4 py-2.5 border-b border-border-subtle cursor-pointer transition-colors text-xs items-center hover:bg-surface-hover"
            >
              <div>
                <div className="font-medium text-text-primary">{wf.name}</div>
                {wf.description && <div className="text-[10px] text-text-muted mt-0.5">{wf.description}</div>}
              </div>
              <div className={wf.latestVersion ? "text-status-running font-mono" : "text-text-muted font-mono"}>
                {wf.latestVersion ? `v${wf.latestVersion}` : t("list.not_published")}
              </div>
              <div className="text-text-secondary">{relativeTime(wf.updatedAt)}</div>
              <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  title={t("list.version_history")}
                  onClick={() => onViewVersions(wf.id)}
                  className="flex items-center justify-center w-6 h-6 border-none bg-transparent rounded hover:bg-surface-hover text-text-muted cursor-pointer transition-colors"
                >
                  <ChevronRight size={13} />
                </button>
                <button
                  type="button"
                  title={t("list.delete")}
                  onClick={() => setDeleteTarget(wf)}
                  className="flex items-center justify-center w-6 h-6 border-none bg-transparent rounded hover:bg-surface-hover hover:text-status-error text-text-muted cursor-pointer transition-colors"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {workflows.length > 0 && (
        <div className="mt-3 text-[11px] text-text-muted text-center">
          {t("list.total_workflows", { count: workflows.length })}
        </div>
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
