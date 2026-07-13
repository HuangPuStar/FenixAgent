import { useRequest } from "ahooks";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { ProdViewInfo, ProdViewModulesConfig } from "@/src/api/prod-views";
import { prodViewApi } from "@/src/api/prod-views";
import { unwrap } from "@/src/api/request";
import { NS } from "@/src/i18n";
import { cn } from "@/src/lib/utils";

const MODULE_KEYS = [
  "chatHeader",
  "sessionSidebar",
  "chatView",
  "chatComposer",
  "permissionPanel",
  "todoPanel",
  "contextPanel",
  "toolCallRow",
  "filesPanel",
  "sitesPanel",
  "tasksPanel",
  "viewsPanel",
] as const;

function buildEnabledMap(cfg: ProdViewModulesConfig): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const key of MODULE_KEYS) {
    const m = cfg[key];
    map[key] = m?.enabled !== false;
  }
  return map;
}

interface ProdViewsPanelProps {
  agentId: string | null;
}

export function ProdViewsPanel({ agentId }: ProdViewsPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const prodT = useTranslation(NS.PROD_VIEWS).t;

  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  const { data, loading, error, refresh } = useRequest(() => prodViewApi.list({ agentId: agentId! }), {
    ready: !!agentId,
    onError: () => {
      toast.error(t("panelMode.viewsLoadFailed"));
    },
  });

  const views: ProdViewInfo[] = data?.success !== false ? (data?.data ?? []) : [];

  // ── 创建对话框 ──
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", description: "" });
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!createForm.name.trim() || !agentId) return;
    setCreating(true);
    try {
      await unwrap(
        prodViewApi.create({
          name: createForm.name.trim(),
          agentId,
          description: createForm.description.trim() || undefined,
        }),
      );
      toast.success(t("panelMode.viewsCreateSuccess"));
      setCreateOpen(false);
      setCreateForm({ name: "", description: "" });
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  // ── 编辑对话框 ──
  const [editView, setEditView] = useState<ProdViewInfo | null>(null);
  const [editForm, setEditForm] = useState({ name: "", description: "" });
  const [editEnabledMap, setEditEnabledMap] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const openEdit = (view: ProdViewInfo) => {
    setEditView(view);
    setEditForm({ name: view.name, description: view.description ?? "" });
    setEditEnabledMap(buildEnabledMap(view.modulesConfig));
  };

  const handleSaveEdit = async () => {
    if (!editView || !editForm.name.trim()) return;
    setSaving(true);
    try {
      const modulesConfig: ProdViewModulesConfig = {};
      for (const key of MODULE_KEYS) {
        modulesConfig[key] = { ...editView.modulesConfig[key], enabled: editEnabledMap[key] };
      }
      await unwrap(
        prodViewApi.update(editView.id, {
          name: editForm.name.trim(),
          description: editForm.description.trim() || undefined,
          modulesConfig,
        }),
      );
      toast.success(t("panelMode.viewsUpdateSuccess"));
      setEditView(null);
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // ── 删除确认 ──
  const [deleteTarget, setDeleteTarget] = useState<ProdViewInfo | null>(null);

  const handleDelete = async (id: string) => {
    try {
      await unwrap(prodViewApi.del(id));
      toast.success(t("panelMode.viewsDeleteSuccess"));
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // ── 开关 ──
  const handleToggle = async (view: ProdViewInfo) => {
    setTogglingIds((prev) => new Set(prev).add(view.id));
    try {
      await unwrap(prodViewApi.update(view.id, { enabled: !view.enabled }));
      refresh();
    } catch {
      toast.error(t("panelMode.viewsToggleFailed"));
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(view.id);
        return next;
      });
    }
  };

  // ── 复制链接 ──
  const copyLink = (id: string) => {
    const url = `${window.location.origin}/view/${id}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success(t("panelMode.viewsLinkCopied")),
      () => toast.error(t("panelMode.viewsCopyFailed")),
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 flex-shrink-0">
        <span className="text-xs font-medium text-text-primary">{t("panelMode.viewsListTitle")}</span>
        <Button size="xs" variant="ghost" onClick={() => setCreateOpen(true)} disabled={!agentId}>
          <Plus className="size-3.5" />
        </Button>
      </div>

      {/* 内容区 */}
      {error ? (
        <div className="flex-1 flex items-center justify-center py-8 px-4">
          <p className="text-sm text-text-muted">{t("panelMode.viewsLoadFailed")}</p>
        </div>
      ) : loading ? (
        <div className="p-3 space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: loading placeholder
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : views.length === 0 ? (
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex-1 flex flex-col items-center justify-center py-8 px-4 gap-3 hover:bg-surface-2/30 transition-colors"
        >
          <Plus className="h-8 w-8 text-text-dim" />
          <p className="text-sm text-text-muted">{t("panelMode.viewsEmptyHint")}</p>
        </button>
      ) : (
        <ScrollArea className="flex-1">
          {views.map((view) => (
            <div
              key={view.id}
              className={cn(
                "group flex items-center gap-3 px-3 py-2.5 border-b border-border/40 hover:bg-surface-2/50 transition-colors cursor-pointer",
                !view.enabled && "opacity-50",
              )}
              onClick={() => openEdit(view)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") openEdit(view);
              }}
              role="button"
              tabIndex={0}
            >
              {/* 左侧：状态圆点 + 名称 + 描述 */}
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span
                  className={cn("shrink-0 size-2 rounded-full", view.enabled ? "bg-emerald-500" : "bg-slate-400")}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">{view.name}</p>
                  {view.description && <p className="text-xs text-text-muted truncate">{view.description}</p>}
                </div>
              </div>
              {/* 右侧：hover 按钮 + 开关 */}
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyLink(view.id);
                  }}
                  title={t("panelMode.viewsCopyLink")}
                >
                  <Copy className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-600"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(view);
                  }}
                  title={t("panelMode.viewsDelete")}
                >
                  <Trash2 className="size-3" />
                </Button>
                <Switch
                  checked={view.enabled}
                  onCheckedChange={() => handleToggle(view)}
                  disabled={togglingIds.has(view.id)}
                  size="sm"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
          ))}
        </ScrollArea>
      )}

      {/* ── 创建对话框 ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("panelMode.viewsCreateTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t("panelMode.viewsNameLabel")}</Label>
              <Input
                placeholder={t("panelMode.viewsNamePlaceholder")}
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("panelMode.viewsDescLabel")}</Label>
              <Input
                placeholder={t("panelMode.viewsDescPlaceholder")}
                value={createForm.description}
                onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("panelMode.viewsCancel")}
            </Button>
            <Button onClick={handleCreate} disabled={creating || !createForm.name.trim()}>
              {creating ? "..." : t("panelMode.viewsSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 编辑对话框 ── */}
      <Dialog open={!!editView} onOpenChange={() => setEditView(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("panelMode.viewsEditTitle")} — {editView?.name}
            </DialogTitle>
          </DialogHeader>
          {editView && (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span>{t("panelMode.viewsLinkLabel")}:</span>
                <code className="text-brand">{`${window.location.origin}/view/${editView.id}`}</code>
                <Button size="xs" variant="ghost" onClick={() => copyLink(editView.id)}>
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <div className="space-y-2">
                <Label>{t("panelMode.viewsNameLabel")}</Label>
                <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>{t("panelMode.viewsDescLabel")}</Label>
                <Input
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm">{t("panelMode.viewsModulesLabel")}</Label>
                <div className="grid grid-cols-2 gap-2">
                  {MODULE_KEYS.map((key) => (
                    <div key={key} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2">
                      <span className="text-sm">{prodT(`modules.${key}`)}</span>
                      <Switch
                        checked={editEnabledMap[key]}
                        onCheckedChange={(checked) => setEditEnabledMap({ ...editEnabledMap, [key]: checked })}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditView(null)}>
              {t("panelMode.viewsCancel")}
            </Button>
            <Button onClick={handleSaveEdit} disabled={saving || !editForm.name.trim()}>
              {saving ? "..." : t("panelMode.viewsSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 删除确认 ── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("panelMode.viewsDeleteTitle")}
        description={t("panelMode.viewsDeleteConfirm", { name: deleteTarget?.name ?? "" })}
        variant="destructive"
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
