import { envApi } from "@fenix/agent-runtime/web/api/environments";
import { AgentCardList } from "@fenix/ui-components/components/AgentCardList";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { z } from "zod/v4";
import { type ChannelBinding, channelApi } from "../../../api/channels";
import { resolveChannelListState } from "../../../lib/channel-list-state";
import {
  ChannelBindingForm,
  type ChannelBindingFormValues,
  channelBindingFormSchema,
} from "../components/ChannelBindingForm";

type EnvironmentSummary = { id: string; name: string };

export function AgentChannelsPage() {
  const { t } = useTranslation("channels");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // 表单字段由 `FormDialog` 内部的 `useForm` 持有，页面只保留这个「每次打开换一个 `key`」的计数
  // （§4.2 / §4.3）：`key` 变化 = 强制重挂载 = 全新表单实例，因此关闭后再打开必定是干净的表单，
  // 不需要在 `onOpenChange` 里手工清三个字段。
  const [formResetKey, setFormResetKey] = useState(0);

  // 当前已渲染的绑定条数镜像：`onError` 用它区分两种失败场景，见下方反馈口径。
  const bindingCountRef = useRef(0);

  // 列表查询：并行拉取通道绑定 + 环境汇总
  const {
    data: listData,
    loading,
    error,
    refresh,
  } = useRequest(() => Promise.all([unwrap(channelApi.listBindings()), unwrap(envApi.list())]), {
    onError: (err) => {
      console.error("Failed to load channels", err);
      // 反馈口径：同一次失败只报一次。无数据时页面渲染持久错误页（role="alert" + 重试按钮），
      // 失败已经可见，再 toast 一次就是重复上报；只有「已有数据后刷新失败」时列表被保留、
      // 没有持久错误页，必须用 toast 兜底，否则这次刷新失败对用户完全不可见。
      // 判据与 lib/channel-list-state 的 `error && itemCount === 0` 同源；此处按条数而非按
      // 渲染分支判断：ahooks 在失败前置 loading 为 true，onError 看到的上一轮分支是 loading。
      if (bindingCountRef.current > 0) toast.error(t("loadBindingsFailed"));
    },
  });
  const bindings: ChannelBinding[] = Array.isArray(listData?.[0]) ? listData[0] : [];
  const environments: EnvironmentSummary[] = Array.isArray(listData?.[1]) ? listData[1] : [];
  bindingCountRef.current = bindings.length;
  // 分支判定见 lib/channel-list-state：失败必须落到持久错误态，不能在列表里显示「暂无绑定」。
  const listState = resolveChannelListState({ loading, error, itemCount: bindings.length });

  // 创建绑定：仅成功时 toast 提示
  const { run: runCreate, loading: formSaving } = useRequest(
    (platform: string, chatId: string, agentId: string) =>
      unwrap(channelApi.createBinding({ platform: platform.trim(), chatId: chatId.trim() || "", agentId })),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("bindingCreated"));
        setDialogOpen(false);
        refresh();
      },
      onError: (err) => {
        console.error("Save failed", err);
        toast.error(t("createBindingFailed"));
      },
    },
  );

  // 删除绑定：成功后 toast 反馈（字典里的 bindingDeleted 在此之前没有消费点）
  const { run: runDelete } = useRequest((id: string) => unwrap(channelApi.deleteBinding({ id })), {
    manual: true,
    onSuccess: () => {
      toast.success(t("bindingDeleted"));
      setConfirmOpen(false);
      setDeleteTarget(null);
      refresh();
    },
    onError: (err) => {
      console.error("Delete failed", err);
      toast.error(t("deleteBindingFailed"));
    },
  });

  const handleCreate = () => {
    setFormResetKey((key) => key + 1);
    setDialogOpen(true);
  };

  // 表单配置：schema 只判合不合法、文案在字段体内按字段取 i18n 键；`onFormSubmit` 的入参是
  // `Record<string, unknown>`（`FormDialog` 的契约），按本页的域类型收窄后再用。
  const formConfig = useMemo(
    () => ({
      schema: channelBindingFormSchema as z.ZodType<Record<string, unknown>>,
      defaultValues: {
        platform: "",
        chatId: "",
        // 默认选中第一个环境：此前这段默认值写在 `handleCreate` 里，现在由「每次打开重挂载」的表单实例
        // 在 mount 时读到，语义一致。
        agentId: environments[0]?.id ?? "",
      } as unknown as Record<string, unknown>,
      onFormSubmit: (values: Record<string, unknown>) => {
        const { platform, chatId, agentId } = values as unknown as ChannelBindingFormValues;
        runCreate(platform, chatId, agentId);
      },
    }),
    [environments, runCreate],
  );

  if (listState === "loading") {
    return (
      <AppPage busy>
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <Skeleton className="h-5.5 w-28 rounded-md" />
            <Skeleton className="mt-1.5 h-3 w-56 rounded-md" />
          </div>
          <Skeleton className="h-10 w-28 rounded-lg" />
        </div>
        <div className="mb-3.5 h-px bg-slate-200" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // Static skeleton placeholders have no domain identifier.
            // biome-ignore lint/suspicious/noArrayIndexKey: 骨架屏是静态装饰、不重排，索引键不会引起元素错位；源文件位于 apps/web 时未声明 react 依赖、biome 未启用 react 域规则，本包按 T2e 声明 react 后该规则才生效
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </AppPage>
    );
  }

  // 持久错误态：带 role="alert" 让读屏播报，且绝不落回 AgentCardList 的「暂无绑定」空态。
  // 鉴权失败（401/403）单独一个分支：重试按钮对「没有权限」没有意义，因此不给。
  if (listState === "unauthorized" || listState === "error") {
    return (
      <AppPage>
        <EmptyState
          tone="danger"
          role="alert"
          icon={<AlertTriangle />}
          title={listState === "unauthorized" ? t("unauthorized") : t("loadBindingsFailed")}
          description={
            listState === "unauthorized"
              ? t("unauthorizedHint")
              : error instanceof Error
                ? error.message
                : t("unknownError")
          }
          action={
            listState === "unauthorized"
              ? undefined
              : { label: t("retry"), icon: <RefreshCw />, onClick: refresh, disabled: loading }
          }
          className="flex min-h-96 flex-col items-center justify-center"
        />
      </AppPage>
    );
  }

  return (
    <AppPage>
      <AppHeader title={t("title")} actions={<Button onClick={handleCreate}>{t("newBinding")}</Button>} />
      <AgentCardList
        items={bindings}
        cardKey={(b) => b.id}
        searchPlaceholder={t("table.searchPlaceholder")}
        searchFn={(b, q) => b.platform.toLowerCase().includes(q) || (b.agentName?.toLowerCase().includes(q) ?? false)}
        emptyMessage={t("table.emptyMessage")}
        renderCard={(binding) => (
          <div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{binding.platform}</Badge>
                  <span className="text-sm font-medium text-text-bright">{binding.agentName ?? binding.agentId}</span>
                  {binding.chatId && <span className="text-xs text-text-muted">({binding.chatId})</span>}
                </div>
              </div>
              {/* group-focus-within：操作只随 hover 显形时，键盘 Tab 到按钮会聚焦一个不可见元素 */}
              <div className="flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    setDeleteTarget(binding.id);
                    setConfirmOpen(true);
                  }}
                >
                  {t("actions.delete")}
                </Button>
              </div>
            </div>
          </div>
        )}
      />

      <FormDialog
        key={formResetKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("dialog.title")}
        formConfig={formConfig}
        loading={formSaving}
      >
        <ChannelBindingForm environments={environments} />
      </FormDialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.deleteTitle")}
        description={t("confirm.deleteDescription")}
        variant="destructive"
        onConfirm={() => runDelete(deleteTarget!)}
      />
    </AppPage>
  );
}
