import { useRequest } from "ahooks";
import { Copy, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
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

/** Chat 主体模块 */
const CHAT_MODULE_KEYS = [
  "chatHeader",
  "sessionSidebar",
  "chatView",
  "chatComposer",
  "permissionPanel",
  "todoPanel",
  "contextPanel",
  "toolCallRow",
] as const;

/** 右侧附加面板模块 */
const PANEL_MODULE_KEYS = ["filesPanel", "sitesPanel", "tasksPanel", "viewsPanel"] as const;

const ALL_MODULE_KEYS = [...CHAT_MODULE_KEYS, ...PANEL_MODULE_KEYS] as const;

function defaultEnabledMap(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const key of CHAT_MODULE_KEYS) {
    map[key] = true;
  }
  for (const key of PANEL_MODULE_KEYS) {
    map[key] = false;
  }
  return map;
}

function buildEnabledMap(cfg: ProdViewModulesConfig): Record<string, boolean> {
  const map = defaultEnabledMap();
  for (const key of ALL_MODULE_KEYS) {
    const m = cfg[key];
    if (m !== undefined) map[key] = m.enabled !== false;
  }
  return map;
}

/** 模块配置开关区域 */
function ModuleConfigSection({
  enabledMap,
  onToggle,
}: {
  enabledMap: Record<string, boolean>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  const { t } = useTranslation(NS.PROD_VIEWS);

  const ModuleRow = ({ moduleKey }: { moduleKey: string }) => (
    <div className="flex items-center justify-between rounded bg-gray-50 px-3 py-2">
      <span className="text-sm">{t(`modules.${moduleKey}`)}</span>
      <Switch checked={enabledMap[moduleKey]} onCheckedChange={(checked) => onToggle(moduleKey, checked)} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-text-secondary">{t("modulePanelSection")}</Label>
        <div className="grid grid-cols-2 gap-2">
          {PANEL_MODULE_KEYS.map((mk) => (
            <ModuleRow key={mk} moduleKey={mk} />
          ))}
        </div>
      </div>
    </div>
  );
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

  const copyLink = (id: string) => {
    const url = `${window.location.origin}/view/${id}`;
    navigator.clipboard.writeText(url).then(
      () => toast.success(t("linkCopied")),
      () => toast.error(t("copyFailed")),
    );
  };

  const openView = (id: string) => {
    window.open(`/view/${id}`, "_blank");
  };

  // ── 共用表单状态 ──
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingView, setEditingView] = useState<ProdViewInfo | null>(null);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formAgentId, setFormAgentId] = useState("");
  const [formModules, setFormModules] = useState<Record<string, boolean>>(defaultEnabledMap());
  const [submitting, setSubmitting] = useState(false);

  const isEditing = !!editingView;

  const openCreate = () => {
    setEditingView(null);
    setFormName("");
    setFormDesc("");
    setFormAgentId("");
    setFormModules(defaultEnabledMap());
    setDialogOpen(true);
  };

  const openEdit = (view: ProdViewInfo) => {
    setEditingView(view);
    setFormName(view.name);
    setFormDesc(view.description ?? "");
    setFormAgentId(view.agentId);
    setFormModules(buildEnabledMap(view.modulesConfig));
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingView(null);
  };

  const buildModulesConfig = (): ProdViewModulesConfig => {
    const cfg: ProdViewModulesConfig = {};
    for (const key of ALL_MODULE_KEYS) {
      cfg[key] = { ...editingView?.modulesConfig[key], enabled: formModules[key] };
    }
    return cfg;
  };

  const handleSubmit = async () => {
    if (!formName.trim()) return;
    setSubmitting(true);
    try {
      if (isEditing) {
        await unwrap(
          prodViewApi.update(editingView!.id, {
            name: formName.trim(),
            description: formDesc.trim() || undefined,
            modulesConfig: buildModulesConfig(),
          }),
        );
        toast.success(t("updateSuccess"));
      } else {
        if (!formAgentId) {
          toast.error(t("agentRequired"));
          setSubmitting(false);
          return;
        }
        await unwrap(
          prodViewApi.create({
            name: formName.trim(),
            agentId: formAgentId,
            description: formDesc.trim() || undefined,
            modulesConfig: buildModulesConfig(),
          }),
        );
        toast.success(t("createSuccess"));
      }
      closeDialog();
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── 删除确认 ──
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
          <Button size="sm" onClick={openCreate}>
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
              <Button size="xs" variant="ghost" onClick={() => openView(view.id)} title={t("openView")}>
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
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

      {/* ── 创建 / 编辑共用对话框 ── */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEditing ? `${t("editTitle")} — ${editingView?.name}` : t("createTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* 编辑时显示链接 */}
            {isEditing && editingView && (
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span>{t("viewLink")}:</span>
                <code className="text-brand">{`${window.location.origin}/view/${editingView.id}`}</code>
                <Button size="xs" variant="ghost" onClick={() => copyLink(editingView.id)}>
                  <Copy className="h-3 w-3" />
                </Button>
                <Button size="xs" variant="ghost" onClick={() => openView(editingView.id)}>
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            )}
            {/* 名称 */}
            <div className="space-y-2">
              <Label>{t("name")}</Label>
              <Input
                placeholder={t("namePlaceholder")}
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            {/* 描述 */}
            <div className="space-y-2">
              <Label>{t("description")}</Label>
              <Input
                placeholder={t("descriptionPlaceholder")}
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
              />
            </div>
            {/* Agent 选择（仅创建时） */}
            {!isEditing && (
              <div className="space-y-2">
                <Label>{t("agent")}</Label>
                <Select
                  value={formAgentId}
                  onValueChange={(v) => {
                    setFormAgentId(v);
                    const selectedAgent = agentOptions.find((a: AgentInfo) => a.id === v);
                    if (selectedAgent && !formName.trim()) {
                      setFormName(String(selectedAgent.name));
                    }
                  }}
                >
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
            )}
            {/* 模块配置 */}
            <div className="space-y-1">
              <Label className="text-sm">{t("modulesConfig")}</Label>
              <ModuleConfigSection
                enabledMap={formModules}
                onToggle={(key, checked) => setFormModules({ ...formModules, [key]: checked })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              {t("cancel")}
            </Button>
            <Button onClick={handleSubmit} disabled={submitting || !formName.trim()}>
              {submitting ? "..." : t("save")}
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
