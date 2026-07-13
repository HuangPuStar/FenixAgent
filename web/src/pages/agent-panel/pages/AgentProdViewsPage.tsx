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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { agentApi } from "@/src/api/agents";
import { type ProdViewInfo, type ProdViewModulesConfig, prodViewApi } from "@/src/api/prod-views";
import { unwrap } from "@/src/api/request";
import { NS } from "@/src/i18n";
import type { AgentInfo } from "@/src/types/config";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

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

interface CreateForm {
  name: string;
  description: string;
  agentId: string;
}

export function AgentProdViewsPage() {
  const { t } = useTranslation(NS.PROD_VIEWS);

  const {
    data: views = [],
    loading,
    refresh,
  } = useRequest(
    async () => {
      const list = await unwrap(prodViewApi.list());
      return (Array.isArray(list) ? list : []) as ProdViewInfo[];
    },
    {
      onError: (err) => {
        toast.error(t("loadError", { message: (err as Error).message }));
      },
    },
  );

  const { data: agentOptions = [] } = useRequest(async () => {
    const result = await unwrap(agentApi.list());
    return result?.agents ?? [];
  });

  // 创建对话框
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>({ name: "", description: "", agentId: "" });
  const [creating, setCreating] = useState(false);

  // 配置对话框
  const [editView, setEditView] = useState<ProdViewInfo | null>(null);
  const [editEnabledMap, setEditEnabledMap] = useState<Record<string, boolean>>({});

  const copyLink = (id: string) => {
    const url = `${window.location.origin}/view/${id}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success(t("linkCopied")),
      () => toast.error(t("copyFailed")),
    );
  };

  const handleCreate = async () => {
    if (!createForm.name.trim() || !createForm.agentId) return;
    setCreating(true);
    try {
      await unwrap(
        prodViewApi.create({
          name: createForm.name.trim(),
          agentId: createForm.agentId,
          description: createForm.description.trim() || undefined,
        }),
      );
      toast.success(t("createSuccess"));
      setCreateOpen(false);
      setCreateForm({ name: "", description: "", agentId: "" });
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (view: ProdViewInfo) => {
    setEditView(view);
    setEditEnabledMap(buildEnabledMap(view.modulesConfig));
  };

  const handleSaveConfig = async () => {
    if (!editView) return;
    try {
      const modulesConfig: ProdViewModulesConfig = {};
      for (const key of MODULE_KEYS) {
        modulesConfig[key] = { ...editView.modulesConfig[key], enabled: editEnabledMap[key] };
      }
      await unwrap(prodViewApi.update(editView.id, { modulesConfig }));
      toast.success(t("updateSuccess"));
      setEditView(null);
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<ProdViewInfo | null>(null);

  const handleDelete = async (id: string) => {
    try {
      await unwrap(prodViewApi.del(id));
      toast.success(t("deleteSuccess"));
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  if (loading) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <Skeleton className="h-[22px] w-28 rounded-md" />
        <Skeleton className="mt-1.5 h-3 w-56 rounded-md" />
        <div className="mt-6 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            {t("create")}
          </Button>
        }
      />
      <AgentCardList
        items={views}
        cardKey={(v) => v.id}
        emptyMessage={t("noViews")}
        searchPlaceholder={t("namePlaceholder")}
        searchFn={(v, q) => v.name.toLowerCase().includes(q.toLowerCase())}
        renderCard={(view) => (
          <div className="group flex items-center justify-between rounded-lg border border-border-light bg-surface-1 px-4 py-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate">{view.name}</span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${view.enabled ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}
                >
                  {view.enabled ? t("enabled") : t("disabled")}
                </span>
              </div>
              <div className="text-xs text-text-muted mt-0.5">{view.agentId}</div>
              <div className="text-xs text-text-muted mt-0.5">
                {t("createdAt")}: {new Date(view.createdAt).toLocaleString()}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0 ml-4">
              <Button size="xs" variant="ghost" onClick={() => openEdit(view)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button size="xs" variant="ghost" onClick={() => copyLink(view.id)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="text-red-500 hover:text-red-600"
                onClick={() => setDeleteTarget(view)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      />

      {/* 创建对话框 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t("name")}</Label>
              <Input
                placeholder={t("namePlaceholder")}
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("description")}</Label>
              <Input
                placeholder={t("descriptionPlaceholder")}
                value={createForm.description}
                onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("agent")}</Label>
              <Select value={createForm.agentId} onValueChange={(v) => setCreateForm({ ...createForm, agentId: v })}>
                <SelectTrigger>
                  <SelectValue placeholder={t("agentPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {agentOptions.map((a: AgentInfo) => (
                    <SelectItem key={a.id} value={a.id}>
                      {String(a.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={creating || !createForm.name.trim() || !createForm.agentId}>
              {creating ? "..." : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 配置对话框 */}
      <Dialog open={!!editView} onOpenChange={() => setEditView(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("editTitle")} — {editView?.name}
            </DialogTitle>
          </DialogHeader>
          {editView && (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span>{t("viewLink")}:</span>
                <code className="text-brand">{`${window.location.origin}/view/${editView.id}`}</code>
                <Button size="xs" variant="ghost" onClick={() => copyLink(editView.id)}>
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <div className="space-y-1">
                <Label className="text-sm">{t("modulesConfig")}</Label>
                <div className="grid grid-cols-2 gap-2">
                  {MODULE_KEYS.map((key) => (
                    <div key={key} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2">
                      <span className="text-sm">{t(`modules.${key}`)}</span>
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
              {t("cancel")}
            </Button>
            <Button onClick={handleSaveConfig}>{t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("deleteTitle")}
        description={t("deleteDescription", { name: deleteTarget?.name ?? "" })}
        variant="destructive"
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
