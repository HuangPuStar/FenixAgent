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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { ProdViewInfo, ProdViewModulesConfig } from "@/src/api/prod-views";
import { prodViewApi } from "@/src/api/prod-views";
import { unwrap } from "@/src/api/request";
import { NS } from "@/src/i18n";
import { cn } from "@/src/lib/utils";

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

/** 默认全启用 */
function defaultEnabledMap(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const key of ALL_MODULE_KEYS) {
    map[key] = true;
  }
  return map;
}

function buildEnabledMap(cfg: ProdViewModulesConfig): Record<string, boolean> {
  const map = defaultEnabledMap();
  for (const key of ALL_MODULE_KEYS) {
    const m = cfg[key];
    if (m?.enabled === false) map[key] = false;
  }
  return map;
}

/** 推荐命名 */
const SUGGESTED_NAMES = ["通用助手", "代码助手", "文档助手", "数据分析师", "客服助手", "翻译助手"];

interface ProdViewsPanelProps {
  agentId: string | null;
}

/** 模块配置开关区域（创建 & 编辑共用） */
function ModuleConfigSection({
  enabledMap,
  onToggle,
  prodT,
}: {
  enabledMap: Record<string, boolean>;
  onToggle: (key: string, checked: boolean) => void;
  prodT: (key: string) => string;
}) {
  const { t } = useTranslation(NS.COMPONENTS);

  const ModuleRow = ({ moduleKey }: { moduleKey: string }) => (
    <div className="flex items-center justify-between rounded bg-gray-50 px-3 py-2">
      <span className="text-sm">{prodT(`modules.${moduleKey}`)}</span>
      <Switch checked={enabledMap[moduleKey]} onCheckedChange={(checked) => onToggle(moduleKey, checked)} />
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Chat 模块 */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-text-secondary">{t("panelMode.viewsChatModules")}</Label>
        <div className="grid grid-cols-2 gap-2">
          {CHAT_MODULE_KEYS.map((mk) => (
            <ModuleRow key={mk} moduleKey={mk} />
          ))}
        </div>
      </div>
      {/* 附加面板 */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-text-secondary">{t("panelMode.viewsPanelModules")}</Label>
        <div className="grid grid-cols-2 gap-2">
          {PANEL_MODULE_KEYS.map((mk) => (
            <ModuleRow key={mk} moduleKey={mk} />
          ))}
        </div>
      </div>
    </div>
  );
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

  // ── 共用表单状态（创建 / 编辑共用同一个 Dialog） ──
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingView, setEditingView] = useState<ProdViewInfo | null>(null);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formModules, setFormModules] = useState<Record<string, boolean>>(defaultEnabledMap());
  const [submitting, setSubmitting] = useState(false);

  const isEditing = !!editingView;

  const openCreate = () => {
    setEditingView(null);
    setFormName("");
    setFormDesc("");
    setFormModules(defaultEnabledMap());
    setDialogOpen(true);
  };

  const openEdit = (view: ProdViewInfo) => {
    setEditingView(view);
    setFormName(view.name);
    setFormDesc(view.description ?? "");
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
    if (!formName.trim() || !agentId) return;
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
        toast.success(t("panelMode.viewsUpdateSuccess"));
      } else {
        await unwrap(
          prodViewApi.create({
            name: formName.trim(),
            agentId,
            description: formDesc.trim() || undefined,
          }),
        );
        toast.success(t("panelMode.viewsCreateSuccess"));
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

  // ── 打开视图 ──
  const openView = (id: string) => {
    window.open(`/view/${id}`, "_blank");
  };

  return (
    <div className="flex flex-col h-full">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 flex-shrink-0">
        <span className="text-xs font-medium text-text-primary">{t("panelMode.viewsListTitle")}</span>
        <Button size="xs" variant="ghost" onClick={openCreate} disabled={!agentId}>
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
          onClick={openCreate}
          className="flex-1 flex flex-col items-center justify-center py-8 px-4 gap-3 hover:bg-surface-2/30 transition-colors"
        >
          <Plus className="h-8 w-8 text-text-dim" />
          <p className="text-sm text-text-muted">{t("panelMode.viewsEmptyHint")}</p>
        </button>
      ) : (
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-2 p-3">
            {views.map((view) => (
              <div
                key={view.id}
                className={cn(
                  "rounded-lg border border-border/40 bg-surface-1 p-3 transition-colors",
                  !view.enabled && "opacity-50",
                )}
              >
                {/* 头部：状态圆点 + 名称 + 启用 badge */}
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn("shrink-0 size-2 rounded-full", view.enabled ? "bg-emerald-500" : "bg-slate-400")}
                  />
                  <span className="text-sm font-medium text-text-primary truncate">{view.name}</span>
                  <span
                    className={cn(
                      "shrink-0 text-[10px] px-1.5 py-px rounded-full",
                      view.enabled ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500",
                    )}
                  >
                    {view.enabled ? t("panelMode.viewsEnabled") : t("panelMode.viewsDisabled")}
                  </span>
                </div>
                {/* 描述 */}
                {view.description && <p className="text-xs text-text-muted truncate mt-1">{view.description}</p>}
                {/* 底部：操作按钮 + 开关 */}
                <div className="flex items-center justify-between mt-2.5">
                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => openView(view.id)}
                      title={t("panelMode.viewsOpenView")}
                    >
                      <ExternalLink className="size-3 mr-1" />
                      {t("panelMode.viewsOpenView")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => copyLink(view.id)}
                      title={t("panelMode.viewsCopyLink")}
                    >
                      <Copy className="size-3 mr-1" />
                      {t("panelMode.viewsCopyLink")}
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => openEdit(view)} title={t("panelMode.viewsEdit")}>
                      <Pencil className="size-3 mr-1" />
                      {t("panelMode.viewsEdit")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-red-500 hover:text-red-600"
                      onClick={() => setDeleteTarget(view)}
                      title={t("panelMode.viewsDelete")}
                    >
                      <Trash2 className="size-3 mr-1" />
                      {t("panelMode.viewsDelete")}
                    </Button>
                  </div>
                  <Switch
                    checked={view.enabled}
                    onCheckedChange={() => handleToggle(view)}
                    disabled={togglingIds.has(view.id)}
                    size="sm"
                  />
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      {/* ── 创建 / 编辑共用对话框 ── */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {isEditing ? `${t("panelMode.viewsEditTitle")} — ${editingView?.name}` : t("panelMode.viewsCreateTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* 编辑时显示链接 */}
            {isEditing && editingView && (
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span>{t("panelMode.viewsLinkLabel")}:</span>
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
              <Label>{t("panelMode.viewsNameLabel")}</Label>
              <Input
                placeholder={t("panelMode.viewsNamePlaceholder")}
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            {/* 推荐命名（仅创建时） */}
            {!isEditing && (
              <div className="space-y-1.5">
                <Label className="text-xs font-normal text-text-muted">{t("panelMode.viewsSuggestedNames")}</Label>
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTED_NAMES.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setFormName(name)}
                      className={cn(
                        "px-2.5 py-1 text-xs rounded-full border border-border-subtle transition-colors",
                        formName === name
                          ? "bg-brand text-white border-brand"
                          : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary",
                      )}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* 描述 */}
            <div className="space-y-2">
              <Label>{t("panelMode.viewsDescLabel")}</Label>
              <Input
                placeholder={t("panelMode.viewsDescPlaceholder")}
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
              />
            </div>
            {/* 模块配置 */}
            <div className="space-y-1">
              <Label className="text-sm">{t("panelMode.viewsModulesLabel")}</Label>
              <ModuleConfigSection
                enabledMap={formModules}
                onToggle={(key, checked) => setFormModules({ ...formModules, [key]: checked })}
                prodT={prodT}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              {t("panelMode.viewsCancel")}
            </Button>
            <Button onClick={handleSubmit} disabled={submitting || !formName.trim()}>
              {submitting ? "..." : t("panelMode.viewsSave")}
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
