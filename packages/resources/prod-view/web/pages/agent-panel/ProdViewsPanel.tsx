import { agentApi } from "@fenix/agent-config/web";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { cn } from "@fenix/ui-components/lib/cn";
import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { ScrollArea } from "@fenix/ui-components/ui/scroll-area";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Switch } from "@fenix/ui-components/ui/switch";
import { ApiError, unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { Copy, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ProdViewInfo } from "../../api/prod-views";
import { prodViewApi } from "../../api/prod-views";
import { PROD_VIEWS_NS } from "../../i18n/namespace";
import { buildEnabledMap, buildModulesConfig, defaultEnabledMap, PANEL_MODULE_KEYS } from "../../lib/prod-view-modules";

interface ProdViewsPanelProps {
  agentId: string | null;
}

/** 模块配置开关区域（创建 & 编辑共用） */
function ModuleConfigSection({
  enabledMap,
  onToggle,
}: {
  enabledMap: Record<string, boolean>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  // 模块名的键组（`modules.*`）也归本包 prodViews 命名空间，与 panel.* 同源，故只需一次 useTranslation。
  const { t } = useTranslation(PROD_VIEWS_NS);

  const ModuleRow = ({ moduleKey }: { moduleKey: string }) => (
    <div className="flex items-center justify-between rounded bg-gray-50 px-3 py-2">
      <span className="text-sm">{t(`modules.${moduleKey}`)}</span>
      <Switch checked={enabledMap[moduleKey]} onCheckedChange={(checked) => onToggle(moduleKey, checked)} />
    </div>
  );

  return (
    <div className="space-y-4">
      {/* 附加面板 */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold text-text-secondary">{t("panel.moduleSection")}</Label>
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
  const { t } = useTranslation(PROD_VIEWS_NS);

  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  // 列表请求必须经 unwrap 抛出：`request()` 对 HTTP/业务错误是**正常返回** `{ success: false }`，
  // 不 unwrap 时失败响应会退化成空数组，界面渲染成「点击 + 创建」空态——加载失败与确实没有数据不可区分。
  const {
    data: views = [],
    loading,
    error,
    refresh,
  } = useRequest(
    async () => {
      const list = await unwrap(prodViewApi.list({ agentId: agentId! }));
      return (Array.isArray(list) ? list : []) as ProdViewInfo[];
    },
    {
      ready: !!agentId,
      onError: () => {
        toast.error(t("panel.loadFailed"));
      },
    },
  );

  /** 401/403（request 层把两者统一归一为 UNAUTHORIZED）不重试：重试不会改变授权结果，给按钮是无意义的入口。 */
  const unauthorized = error instanceof ApiError && error.code === "UNAUTHORIZED";

  // 加载当前 agent 名称，用于创建时自动填充
  const { data: agentDisplayName } = useRequest(
    async () => {
      if (!agentId) return "";
      const result = await unwrap(agentApi.list());
      const agent = result.agents.find((a) => a.id === agentId);
      return agent?.name ?? "";
    },
    { ready: !!agentId },
  );

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
    setFormName(agentDisplayName ?? "");
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

  const handleSubmit = async () => {
    if (!formName.trim() || !agentId) return;
    setSubmitting(true);
    try {
      const existingModulesConfig = editingView?.modulesConfig;
      if (isEditing) {
        await unwrap(
          prodViewApi.update(editingView!.id, {
            name: formName.trim(),
            description: formDesc.trim() || undefined,
            modulesConfig: buildModulesConfig(existingModulesConfig, formModules),
          }),
        );
        toast.success(t("panel.updateSuccess"));
      } else {
        await unwrap(
          prodViewApi.create({
            name: formName.trim(),
            agentId,
            description: formDesc.trim() || undefined,
            modulesConfig: buildModulesConfig(existingModulesConfig, formModules),
          }),
        );
        toast.success(t("panel.createSuccess"));
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
      toast.success(t("panel.deleteSuccess"));
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
      toast.error(t("panel.toggleFailed"));
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
      () => toast.success(t("panel.linkCopied")),
      () => toast.error(t("panel.copyFailed")),
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
        <span className="text-xs font-medium text-text-primary">{t("panel.listTitle")}</span>
        {/* 纯图标按钮没有可见文本，必须靠 aria-label 命名（title 只作鼠标悬停提示）。 */}
        <Button size="xs" variant="ghost" onClick={openCreate} disabled={!agentId} aria-label={t("panel.createTitle")}>
          <Plus className="size-3.5" />
        </Button>
      </div>

      {/* 内容区 */}
      {loading ? (
        <div className="p-3 space-y-2.5" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 骨架屏是静态装饰、不重排，索引键不会引起元素错位；源文件位于 apps/web 时该包未声明 react 依赖、biome 未启用 react 域规则，本包按 T2e 声明 react 后规则才生效
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : error ? (
        // 持久错误分支（role="alert"）：失败不能落进下面的「点击 + 创建」空态，否则用户分不清
        // 「加载失败」与「确实没有数据」，也没有恢复入口；已解构的 refresh 必须接到这里。
        <div className="flex-1 flex flex-col items-center justify-center gap-3 py-8 px-4" role="alert">
          <p className="text-sm text-text-muted">{unauthorized ? t("noPermission") : t("panel.loadFailed")}</p>
          {unauthorized ? null : (
            <Button size="xs" variant="outline" onClick={refresh}>
              {t("retry")}
            </Button>
          )}
        </div>
      ) : views.length === 0 ? (
        <button
          type="button"
          onClick={openCreate}
          className="flex-1 flex flex-col items-center justify-center py-8 px-4 gap-3 hover:bg-surface-2/30 transition-colors"
        >
          <Plus className="h-8 w-8 text-text-dim" />
          <p className="text-sm text-text-muted">{t("panel.emptyHint")}</p>
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
                  <StatusBadge
                    status={view.enabled ? "enabled" : "disabled"}
                    label={view.enabled ? t("panel.enabled") : t("panel.disabled")}
                    indicator="dot"
                    className="shrink-0 text-[10px] px-1.5 py-px"
                  />
                </div>
                {/* 描述 */}
                {view.description && <p className="text-xs text-text-muted truncate mt-1">{view.description}</p>}
                {/* 底部：操作按钮 + 开关 */}
                <div className="flex items-center justify-between mt-2.5">
                  <div className="flex items-center gap-0.5">
                    <Button variant="ghost" size="xs" onClick={() => openView(view.id)} title={t("panel.openView")}>
                      <ExternalLink className="size-3 mr-1" />
                      {t("panel.openView")}
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => copyLink(view.id)} title={t("panel.copyLink")}>
                      <Copy className="size-3 mr-1" />
                      {t("panel.copyLink")}
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => openEdit(view)} title={t("panel.edit")}>
                      <Pencil className="size-3 mr-1" />
                      {t("panel.edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-red-500 hover:text-red-600"
                      onClick={() => setDeleteTarget(view)}
                      title={t("panel.delete")}
                    >
                      <Trash2 className="size-3 mr-1" />
                      {t("panel.delete")}
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
              {isEditing ? `${t("panel.editTitle")} — ${editingView?.name}` : t("panel.createTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* 编辑时显示链接 */}
            {isEditing && editingView && (
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span>{t("panel.linkLabel")}:</span>
                <code className="text-brand">{`${window.location.origin}/view/${editingView.id}`}</code>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => copyLink(editingView.id)}
                  aria-label={t("panel.copyLink")}
                >
                  <Copy className="h-3 w-3" />
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => openView(editingView.id)}
                  aria-label={t("panel.openView")}
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            )}
            {/* 名称 */}
            <div className="space-y-2">
              <Label>{t("panel.nameLabel")}</Label>
              <Input
                placeholder={t("panel.namePlaceholder")}
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            {/* 描述 */}
            <div className="space-y-2">
              <Label>{t("panel.descLabel")}</Label>
              <Input
                placeholder={t("panel.descPlaceholder")}
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
              />
            </div>
            {/* 模块配置 */}
            <div className="space-y-1">
              <Label className="text-sm">{t("panel.modulesLabel")}</Label>
              <ModuleConfigSection
                enabledMap={formModules}
                onToggle={(key, checked) => setFormModules({ ...formModules, [key]: checked })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              {t("panel.cancel")}
            </Button>
            <Button onClick={handleSubmit} disabled={submitting || !formName.trim()}>
              {submitting ? "..." : t("panel.save")}
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
        title={t("panel.deleteTitle")}
        description={t("panel.deleteConfirm", { name: deleteTarget?.name ?? "" })}
        variant="destructive"
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
