import { agentApi } from "@fenix/agent-config/web";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { cn } from "@fenix/ui-components/lib/cn";
import { Button } from "@fenix/ui-components/ui/button";
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
import {
  copyProdViewLink,
  openProdView,
  ProdViewDeleteDialog,
  ProdViewFormDialog,
  useProdViewDelete,
  useProdViewEditor,
} from "../../components/prod-view-editor";
import { PROD_VIEWS_NS } from "../../i18n/namespace";
import { PROD_VIEW_STATUS_TONES } from "../../lib/status-tones";

interface ProdViewsPanelProps {
  agentId: string | null;
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

  // 表单与删除流程与整页外壳共用（`components/prod-view-editor`）：面板的 agent 由 props 固定，
  // 因此打开创建弹窗时把当前 agent 名预填进名称，弹窗里不再有 agent 选择器。
  const editor = useProdViewEditor({
    boundAgentId: agentId,
    messages: {
      createSuccess: t("panel.createSuccess"),
      updateSuccess: t("panel.updateSuccess"),
      saveFailed: t("panel.saveFailed"),
    },
    onSaved: refresh,
  });
  const deletion = useProdViewDelete({
    successMessage: t("panel.deleteSuccess"),
    failureMessage: t("panel.deleteFailed"),
    onDeleted: refresh,
  });

  const copyLink = (id: string) =>
    copyProdViewLink(id, { copied: t("panel.linkCopied"), failed: t("panel.copyFailed") });

  const openCreate = () => editor.openCreate(agentDisplayName ?? "");

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
        // 401/403（UNAUTHORIZED）不给重试：重试不会改变授权结果。
        <EmptyState
          tone="danger"
          role="alert"
          title={unauthorized ? t("noPermission") : t("panel.loadFailed")}
          action={unauthorized ? undefined : { label: t("retry"), onClick: refresh }}
          className="flex flex-1 flex-col justify-center px-4"
        />
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
        // `min-h-0` 不是修饰：本 ScrollArea 根是列向 flex 的子项（`flex-1`），不写它时 CSS 的自动最小尺寸
        // （`min-height: auto`）会把它撑到**整个列表的内容高度**，视口于是与内容等高、永远没有可滚动溢出，
        // 外层 `overflow-hidden` 只是把超出部分裁掉（表现为「视图一多就滚不动、也看不到滚动条」）。
        // 实测：可用高 876px、40 张卡片时根被撑到 3648px，视口 clientHeight == scrollHeight == 3648，
        // 滚轮与 `scrollTop` 赋值均无效、Radix thumb 不挂载；补 `min-h-0` 后根 842.5px、视口 843:3648，可滚动。
        <ScrollArea className="flex-1 min-h-0">
          <div className="flex flex-col gap-2 p-3">
            {views.map((view) => (
              <div
                key={view.id}
                className={cn(
                  "rounded-lg border border-border/40 bg-surface-1 p-3 transition-colors",
                  !view.enabled && "opacity-50",
                )}
              >
                {/* 头部：名称 + 启用 badge（状态圆点由 badge 的 `indicator` 提供，不再另画一个手写色值的圆点） */}
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-text-primary truncate">{view.name}</span>
                  <StatusBadge
                    status={view.enabled ? "enabled" : "disabled"}
                    label={view.enabled ? t("panel.enabled") : t("panel.disabled")}
                    toneMap={PROD_VIEW_STATUS_TONES}
                    indicator="dot"
                    className="shrink-0 text-3xs px-1.5 py-px"
                  />
                </div>
                {/* 描述 */}
                {view.description && <p className="text-xs text-text-muted truncate mt-1">{view.description}</p>}
                {/* 底部：操作按钮 + 开关 */}
                <div className="flex items-center justify-between mt-2.5">
                  <div className="flex items-center gap-0.5">
                    <Button variant="ghost" size="xs" onClick={() => openProdView(view.id)} title={t("panel.openView")}>
                      <ExternalLink className="size-3 mr-1" />
                      {t("panel.openView")}
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => copyLink(view.id)} title={t("panel.copyLink")}>
                      <Copy className="size-3 mr-1" />
                      {t("panel.copyLink")}
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => editor.openEdit(view)} title={t("panel.edit")}>
                      <Pencil className="size-3 mr-1" />
                      {t("panel.edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deletion.request(view)}
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
      {/* 结构与请求在 `components/prod-view-editor`；文案逐项用本外壳的 `panel.*` 键翻译后传入，
          不传 agentField——面板的 agent 由 props 固定，创建时不需要选择器。 */}
      <ProdViewFormDialog
        editor={editor}
        labels={{
          editTitle: t("panel.editTitle"),
          createTitle: t("panel.createTitle"),
          linkLabel: t("panel.linkLabel"),
          nameLabel: t("panel.nameLabel"),
          namePlaceholder: t("panel.namePlaceholder"),
          descLabel: t("panel.descLabel"),
          descPlaceholder: t("panel.descPlaceholder"),
          modulesLabel: t("panel.modulesLabel"),
          moduleSection: t("panel.moduleSection"),
          copyLink: t("panel.copyLink"),
          openView: t("panel.openView"),
          cancel: t("panel.cancel"),
          save: t("panel.save"),
        }}
        onCopyLink={copyLink}
        onOpenView={openProdView}
      />

      {/* ── 删除确认 ── */}
      <ProdViewDeleteDialog
        state={deletion}
        title={t("panel.deleteTitle")}
        description={t("panel.deleteConfirm", { name: deletion.target?.name ?? "" })}
      />
    </div>
  );
}
