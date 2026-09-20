import { agentApi } from "@fenix/agent-config/web";
import { AgentCardList } from "@fenix/ui-components/components/AgentCardList";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Switch } from "@fenix/ui-components/ui/switch";
import { ApiError, unwrap } from "@fenix/web-runtime/api/request";
import type { AgentInfo } from "@fenix/web-runtime/types/config";
import { useRequest } from "ahooks";
import { AlertTriangle, Copy, ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type ProdViewInfo, prodViewApi } from "../../../api/prod-views";
import { PROD_VIEWS_NS } from "../../../i18n/namespace";
import {
  buildEnabledMap,
  buildModulesConfig,
  defaultEnabledMap,
  PANEL_MODULE_KEYS,
} from "../../../lib/prod-view-modules";

/** 模块配置开关区域 */
function ModuleConfigSection({
  enabledMap,
  onToggle,
}: {
  enabledMap: Record<string, boolean>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  const { t } = useTranslation(PROD_VIEWS_NS);

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
  const { t } = useTranslation(PROD_VIEWS_NS);

  const {
    data: views = [],
    loading,
    error: loadError,
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

  const handleSubmit = async () => {
    if (!formName.trim()) return;
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
            modulesConfig: buildModulesConfig(existingModulesConfig, formModules),
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

  /** 401/403（request 层把两者统一归一为 UNAUTHORIZED）不重试：重试不会改变授权结果，给按钮是无意义的入口。 */
  const unauthorized = loadError instanceof ApiError && loadError.code === "UNAUTHORIZED";

  if (loading) {
    return (
      <AppPage busy>
        <Skeleton className="h-[22px] w-28 rounded-md" />
        <Skeleton className="mt-1.5 h-3 w-56 rounded-md" />
        <div className="mt-6 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 骨架屏是静态装饰、不重排，索引键不会引起元素错位；源文件位于 apps/web 时该包未声明 react 依赖、biome 未启用 react 域规则，本包按 T2e 声明 react 后规则才生效
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </AppPage>
    );
  }

  // 加载失败必须落到持久分支：只弹 toast 会让「加载失败」与「确实没有数据」在界面上不可区分
  // （toast 消失后两者都渲染成 noViews 空态），用户既不知道原因也没有恢复入口。
  if (loadError) {
    return (
      <AppPage>
        <AppHeader title={t("title")} subtitle={t("subtitle")} />
        <div className="mt-6 flex flex-col items-center gap-3 py-12" role="alert">
          <AlertTriangle className="h-8 w-8 text-text-dim" />
          <p className="text-sm font-medium text-text-bright">
            {unauthorized ? t("noPermission") : t("loadError", { message: loadError.message })}
          </p>
          {unauthorized ? (
            <p className="text-xs text-text-muted">{t("noPermissionHint")}</p>
          ) : (
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t("retry")}
            </Button>
          )}
        </div>
      </AppPage>
    );
  }

  return (
    <AppPage>
      <AppHeader
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
              {/* 行内操作全是纯图标按钮：可见文本为空时屏幕阅读器只能靠 aria-label 命名（title 只作鼠标悬停提示）。 */}
              <Button
                size="xs"
                variant="ghost"
                onClick={() => openView(view.id)}
                title={t("openView")}
                aria-label={t("openView")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
              <Button size="xs" variant="ghost" onClick={() => openEdit(view)} aria-label={t("edit")}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button size="xs" variant="ghost" onClick={() => copyLink(view.id)} aria-label={t("copyLink")}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="text-red-500 hover:text-red-600"
                onClick={() => setDeleteTarget(view)}
                aria-label={t("delete")}
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
                <Button size="xs" variant="ghost" onClick={() => copyLink(editingView.id)} aria-label={t("copyLink")}>
                  <Copy className="h-3 w-3" />
                </Button>
                <Button size="xs" variant="ghost" onClick={() => openView(editingView.id)} aria-label={t("openView")}>
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
    </AppPage>
  );
}
