// 卡片只消费真实列表字段：名称用于识别，发布态与版本用于判断发布情况，时间明确标注为登记信息更新时间。
// 画布、日志与菜单使用彼此独立的原生按钮，不再在可点击整卡内嵌交互控件。

import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Card } from "@fenix/ui-components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@fenix/ui-components/ui/dropdown-menu";
import {
  Activity,
  ArrowUpRight,
  Clock3,
  MoreHorizontal,
  Pencil,
  ScrollText,
  Trash2,
  Webhook,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorkflowV2WorkflowItem } from "../../api/workflows";
import { WORKFLOW_NS } from "../../i18n/namespace";
import {
  describeWorkflowStatus,
  resolveUpdatedAt,
  WORKFLOW_GRID_CLASS,
  WORKFLOW_STATUS_HINT_KEYS,
} from "./workflow-list-model";

/** 卡片只分派目标对象；请求、导航与弹窗生命周期归页面。 */
export interface WorkflowListCardsProps {
  readonly items: readonly WorkflowV2WorkflowItem[];
  readonly onOpenCanvas: (item: WorkflowV2WorkflowItem) => void;
  readonly onRename: (item: WorkflowV2WorkflowItem) => void;
  readonly onDelete: (item: WorkflowV2WorkflowItem) => void;
  readonly onOpenLogs: (item: WorkflowV2WorkflowItem) => void;
  readonly onOpenRunLogs: (item: WorkflowV2WorkflowItem) => void;
  readonly onOpenApi: (item: WorkflowV2WorkflowItem) => void;
}

/** 响应式工作流目录；日志入口始终可见，不依赖 hover 或菜单展开。 */
export function WorkflowListCards({
  items,
  onOpenCanvas,
  onRename,
  onDelete,
  onOpenLogs,
  onOpenRunLogs,
  onOpenApi,
}: WorkflowListCardsProps) {
  const { t, i18n } = useTranslation(WORKFLOW_NS);
  const locale = i18n.resolvedLanguage ?? i18n.language;

  return (
    <div className={WORKFLOW_GRID_CLASS}>
      {items.map((item) => {
        const status = describeWorkflowStatus(item);
        const deleting = item.syncState === "pending_delete";
        const time = resolveUpdatedAt(item.updatedAt, Date.now());
        const updatedAt =
          time.kind === "date" ? new Date(time.iso).toLocaleDateString(locale) : t(time.key, { count: time.count });

        return (
          <Card
            key={item.id}
            className="group min-w-0 gap-0 overflow-hidden py-0 shadow-none transition-shadow hover:shadow-md focus-within:ring-2 focus-within:ring-ring/30"
          >
            <div className="flex items-start gap-3 p-5 pb-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/5 text-primary">
                <Workflow className="size-5" aria-hidden="true" />
              </div>
              <h2 className="min-w-0 flex-1 self-center text-base font-semibold leading-6 text-text-bright">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => onOpenCanvas(item)}
                  aria-label={t("list.open_card", { name: item.name })}
                  className="line-clamp-2 w-full cursor-pointer rounded-sm text-left break-all outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-text-muted"
                  title={item.name}
                >
                  {item.name}
                </button>
              </h2>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={t("list.more_for", { name: item.name })}>
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onOpenLogs(item)}>
                    <ScrollText />
                    {t("list.log")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onOpenApi(item)}>
                    <Webhook />
                    {t("api.entry")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={deleting} onClick={() => onRename(item)}>
                    <Pencil />
                    {t("list.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={deleting} variant="destructive" onClick={() => onDelete(item)}>
                    <Trash2 />
                    {t("list.delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex flex-1 flex-col px-5 pb-4">
              <div className="flex min-h-7 flex-wrap items-center gap-2">
                <StatusBadge status={status.labelKey} label={t(status.labelKey)} tone={status.tone} />
                {/* 上游版本已带 v 前缀；未知与未发布不猜版本。 */}
                {status.version !== null ? (
                  <span
                    className="max-w-full truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-text-secondary"
                    title={t("list.published_version", { version: status.version })}
                  >
                    {status.version}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 min-h-10 text-xs leading-5 text-text-secondary">
                {t(WORKFLOW_STATUS_HINT_KEYS[deleting ? "pending_delete" : item.publishState])}
              </p>
              <div className="mt-3 flex items-center gap-1.5 text-xs text-text-muted" title={t("list.updated_hint")}>
                <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
                <span>{t("list.updated_label")}</span>
                <time dateTime={item.updatedAt} title={new Date(item.updatedAt).toLocaleString(locale)}>
                  {updatedAt}
                </time>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-surface-1/60 px-4 py-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpenRunLogs(item)}
                aria-label={t("list.run_logs_for", { name: item.name })}
              >
                <Activity aria-hidden="true" />
                {t("run.entry")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={deleting}
                onClick={() => onOpenCanvas(item)}
                aria-label={t("list.open_card", { name: item.name })}
              >
                {t("list.open_canvas")}
                <ArrowUpRight aria-hidden="true" />
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
