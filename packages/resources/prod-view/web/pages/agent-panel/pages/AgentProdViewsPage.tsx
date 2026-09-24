import { agentApi } from "@fenix/agent-config/web";
import { AgentCardList } from "@fenix/ui-components/components/AgentCardList";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import { Label } from "@fenix/ui-components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { ApiError, unwrap } from "@fenix/web-runtime/api/request";
import type { AgentInfo } from "@fenix/web-runtime/types/config";
import { useRequest } from "ahooks";
import { AlertTriangle, Copy, ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type ProdViewInfo, prodViewApi } from "../../../api/prod-views";
import {
  copyProdViewLink,
  openProdView,
  ProdViewDeleteDialog,
  ProdViewFormDialog,
  useProdViewDelete,
  useProdViewEditor,
} from "../../../components/prod-view-editor";
import { PROD_VIEWS_NS } from "../../../i18n/namespace";
import { PROD_VIEW_STATUS_TONES } from "../../../lib/status-tones";

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
        // 原始 error 进日志，上屏只给字典文案（§9.3）：`err.message` 是 `ApiError.message`（后端信封原文）。
        console.error("[prod-view] Failed to load production views", err);
        toast.error(t("loadError"));
      },
    },
  );

  const { data: agentOptions = [] } = useRequest(async () => {
    const result = await unwrap(agentApi.list());
    return result?.agents ?? [];
  });

  const copyLink = (id: string) => copyProdViewLink(id, { copied: t("linkCopied"), failed: t("copyFailed") });

  // 表单与删除流程与面板外壳共用（`components/prod-view-editor`）：整页外壳没有固定的 agent，
  // 绑定选择器由下面的 agentField 注入弹窗，且只在创建态渲染。
  const editor = useProdViewEditor({
    messages: {
      createSuccess: t("createSuccess"),
      updateSuccess: t("updateSuccess"),
      saveFailed: t("saveFailed"),
      agentRequired: t("agentRequired"),
    },
    onSaved: refresh,
  });
  const deletion = useProdViewDelete({
    successMessage: t("deleteSuccess"),
    failureMessage: t("deleteFailed"),
    onDeleted: refresh,
  });

  /** 401/403（request 层把两者统一归一为 UNAUTHORIZED）不重试：重试不会改变授权结果，给按钮是无意义的入口。 */
  const unauthorized = loadError instanceof ApiError && loadError.code === "UNAUTHORIZED";

  if (loading) {
    return (
      <AppPage busy>
        <Skeleton className="h-5.5 w-28 rounded-md" />
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
        <EmptyState
          tone="danger"
          role="alert"
          icon={<AlertTriangle />}
          // 标题只取字典（§9.3）：原先把 `loadError.message` 插进 `{{message}}` 槽位，等于回显后端原文
          title={unauthorized ? t("noPermission") : t("loadError")}
          description={unauthorized ? t("noPermissionHint") : undefined}
          action={
            unauthorized ? undefined : { label: t("retry"), icon: <RefreshCw />, onClick: refresh, disabled: loading }
          }
          className="flex min-h-96 flex-col items-center justify-center"
        />
      </AppPage>
    );
  }

  return (
    <AppPage>
      <AppHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button size="sm" onClick={() => editor.openCreate()}>
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
                <StatusBadge
                  status={view.enabled ? "enabled" : "disabled"}
                  label={view.enabled ? t("enabled") : t("disabled")}
                  toneMap={PROD_VIEW_STATUS_TONES}
                  className="text-xs px-1.5 py-0.5"
                />
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
                onClick={() => openProdView(view.id)}
                title={t("openView")}
                aria-label={t("openView")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
              <Button size="xs" variant="ghost" onClick={() => editor.openEdit(view)} aria-label={t("edit")}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button size="xs" variant="ghost" onClick={() => copyLink(view.id)} aria-label={t("copyLink")}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => deletion.request(view)}
                aria-label={t("delete")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      />

      {/* ── 创建 / 编辑共用对话框 ── */}
      {/* 结构与请求在 `components/prod-view-editor`；文案逐项用本外壳的裸键翻译后传入。
          agentField 仅在创建态渲染：agent 绑定不随编辑变化，后端 update 也不接收 agentId。 */}
      <ProdViewFormDialog
        editor={editor}
        labels={{
          editTitle: t("editTitle"),
          createTitle: t("createTitle"),
          linkLabel: t("viewLink"),
          nameLabel: t("name"),
          namePlaceholder: t("namePlaceholder"),
          descLabel: t("description"),
          descPlaceholder: t("descriptionPlaceholder"),
          modulesLabel: t("modulesConfig"),
          moduleSection: t("modulePanelSection"),
          copyLink: t("copyLink"),
          openView: t("openView"),
          cancel: t("cancel"),
          save: t("save"),
        }}
        onCopyLink={copyLink}
        onOpenView={openProdView}
        agentField={
          <div className="space-y-2">
            <Label>{t("agent")}</Label>
            <Select
              value={editor.formAgentId}
              onValueChange={(v) => {
                editor.setFormAgentId(v);
                const selectedAgent = agentOptions.find((a: AgentInfo) => a.id === v);
                if (selectedAgent && !editor.formName.trim()) {
                  editor.setFormName(String(selectedAgent.name));
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
        }
      />

      {/* ── 删除确认 ── */}
      <ProdViewDeleteDialog
        state={deletion}
        title={t("deleteTitle")}
        description={t("deleteDescription", { name: deletion.target?.name ?? "" })}
      />
    </AppPage>
  );
}
