/**
 * 工单列表页：项目上下文、关键词/状态筛选、游标翻页、四态、索引降级提示与创建入口。
 *
 * 取数全部在 `useTicketList`（编排层），本文件只做分支与排版。分支的**顺序即优先级**，四态各有落点：
 * 首屏骨架 → 项目总览失败 → 未开通 → 列表失败（无权限不给重试）→ 正常（加载中骨架 / 表格 / 两种空态）。
 * 两条容易走错的边界：
 * 1. 请求失败**不得**落进「未开通」或「暂无工单」：前者会让人去联系管理员，后者会让用户以为确实没有工单；
 * 2. 筛选后的空结果与「确实没有工单」是两种空态，前者不给创建 CTA（用户要找的是已有工单，不是再建一条）。
 *
 * 202 的「提交结果确认中」是本页的持久提示（不是成功提示）：关弹窗、留在列表、给手动刷新入口，不轮询、
 * 不自动重试创建，直到用户手动刷新或下一次成功创建。文案与成功提示共用 `toast.createAccepted`，避免
 * 同一种状态在两处各写一句。
 *
 * 筛选与分页不落 URL query：地址栏只表达「当前组织的默认项目」，工单详情的稳定链接由显式 `projectId` +
 * 工单号承载（见 `web/hooks/use-ticket-list.ts` 的文件头）。
 */

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ChevronLeft, ChevronRight, Plus, RefreshCw, TicketSlash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TicketDetail } from "../../../api/tickets";
import { useTicketList } from "../../../hooks/use-ticket-list";
import { TICKETS_NS } from "../../../i18n/namespace";
import { isUnauthorizedError } from "../../../lib/ticket-errors";
import { TicketCreateDialog } from "../components/ticket-create-dialog";
import { TicketFilterBar } from "../components/ticket-filter-bar";
import { TicketListTable } from "../components/ticket-list-table";

/** 首屏与翻页等待期的骨架行数：够撑满一屏，又不至于在慢网络下一直往下长。 */
const SKELETON_ROW_COUNT = 6;

export function AgentTicketsPage() {
  const { t } = useTranslation(TICKETS_NS);
  const navigate = useNavigate();
  const list = useTicketList();
  const projectId = list.projectId;

  const [createOpen, setCreateOpen] = useState(false);
  /** 弹窗重置键：每次打开换代。`FormDialog` 在自身组件体里建 `useForm`，只改 `open` 不会重建表单实例。 */
  const [createFormKey, setCreateFormKey] = useState(0);
  /** 202 受理后的持久提示：用户手动刷新或下一次成功创建时清除。 */
  const [acceptedPending, setAcceptedPending] = useState(false);

  const openCreate = () => {
    setCreateFormKey((key) => key + 1);
    setCreateOpen(true);
  };

  /** 手动刷新：同时撤掉 202 提示——它的文案就是「稍后刷新查看结果」，刷新即已回应用户动作。 */
  const handleRefresh = () => {
    setAcceptedPending(false);
    list.refresh();
  };

  const handleCreated = (ticket: TicketDetail) => {
    toast.success(t("toast.created"));
    setAcceptedPending(false);
    list.refresh();
    // 跳转用**返回行自带**的 projectId：创建落点就是它，不依赖页面当前默认项目（切换竞态下同样稳定）。
    void navigate({
      to: "/agent/tickets/$projectId/$number",
      params: { projectId: ticket.projectId, number: ticket.issueNumber },
    });
  };

  const handleAccepted = () => {
    toast.warning(t("toast.createAccepted"));
    setAcceptedPending(true);
    list.refresh();
  };

  // 1) 首屏骨架：只在「项目总览还没回来、列表也还没开始」时铺；筛选/翻页时列表已有内容，再铺整页骨架
  //    会让界面每次筛选都闪一下。
  if (list.projectsLoading && list.state === null) {
    return (
      <AppPage busy>
        <AppHeader subtitle={t("subtitle")} title={t("title")} />
        <div className="mt-6 flex flex-col gap-2">
          {Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 骨架屏是静态装饰、不重排，索引键不会引起元素错位。
            <Skeleton className="h-10 w-full" key={index} />
          ))}
        </div>
      </AppPage>
    );
  }

  // 2) 项目总览失败：与「组织确实没开通」分开。把失败画成未开通会让用户去联系管理员，而真正要做的是重试。
  if (list.projectsError && list.state === null) {
    const unauthorized = isUnauthorizedError(list.projectsError);
    return (
      <AppPage>
        <AppHeader subtitle={t("subtitle")} title={t("title")} />
        <EmptyState
          action={
            unauthorized
              ? undefined
              : {
                  label: t("loadState.retry"),
                  icon: <RefreshCw className="size-3.5" />,
                  onClick: handleRefresh,
                  disabled: list.projectsLoading,
                }
          }
          description={unauthorized ? t("loadState.unauthorizedHint") : undefined}
          icon={<AlertTriangle className="size-6" />}
          role="alert"
          title={unauthorized ? t("loadState.unauthorizedTitle") : t("loadState.failed")}
          tone="danger"
        />
      </AppPage>
    );
  }

  // 3) 未开通或没有默认项目：`useTicketList` 的 `ready` 已挡住列表请求，这里只给持久说明，不伪装成空列表。
  if (list.state === null || list.state === "unconfigured" || projectId === null) {
    return (
      <AppPage>
        <AppHeader subtitle={t("subtitle")} title={t("title")} />
        <EmptyState
          description={t("disabled.hint")}
          icon={<TicketSlash className="size-6" />}
          title={t("disabled.title")}
        />
      </AppPage>
    );
  }

  // 4) 列表失败：持久 `role="alert"` 分支。无权限不给重试——授权是持久状态，重试只会再拿一个 403；
  //    其余失败（网络、5xx、项目暂停）保留重试入口。
  if (list.error) {
    const unauthorized = isUnauthorizedError(list.error);
    return (
      <AppPage>
        <AppHeader subtitle={t("subtitle")} title={t("title")} />
        <EmptyState
          action={
            unauthorized
              ? undefined
              : {
                  label: t("loadState.retry"),
                  icon: <RefreshCw className="size-3.5" />,
                  onClick: handleRefresh,
                  disabled: list.loading,
                }
          }
          description={unauthorized ? t("loadState.unauthorizedHint") : undefined}
          icon={<AlertTriangle className="size-6" />}
          role="alert"
          title={unauthorized ? t("loadState.unauthorizedTitle") : t("loadState.failed")}
          tone="danger"
        />
      </AppPage>
    );
  }

  const hasFilters = list.query.trim() !== "" || list.stateFilter !== "all";
  const showListSkeleton = list.loading && list.items.length === 0;

  return (
    <AppPage>
      <AppHeader
        actions={
          <>
            <Button disabled={list.loading} onClick={handleRefresh} variant="outline">
              <RefreshCw className="size-4" />
              {t("action.refresh")}
            </Button>
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              {t("action.create")}
            </Button>
          </>
        }
        subtitle={t("subtitle")}
        title={t("title")}
      />

      <div className="mt-4 flex flex-col gap-3">
        <TicketFilterBar
          onQueryChange={list.setQuery}
          onStateFilterChange={list.setStateFilter}
          query={list.query}
          stateFilter={list.stateFilter}
        />

        {acceptedPending ? (
          <div
            className="flex flex-wrap items-center gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text"
            role="status"
          >
            <span>{t("toast.createAccepted")}</span>
            <Button disabled={list.loading} onClick={handleRefresh} size="xs" variant="outline">
              <RefreshCw className="size-3" />
              {t("action.refresh")}
            </Button>
          </div>
        ) : null}

        {/* 索引降级：行级 `stale` 派生，此时列表可能不是最新，但**仍然可用**，因此只提示不拦截。 */}
        {list.syncDegraded ? (
          <p className="text-xs text-status-warning" role="status">
            {t("sync.degraded")}
          </p>
        ) : null}

        {showListSkeleton ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {Array.from({ length: SKELETON_ROW_COUNT }).map((_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 骨架屏是静态装饰、不重排，索引键不会引起元素错位。
              <Skeleton className="h-10 w-full" key={index} />
            ))}
          </div>
        ) : list.items.length > 0 ? (
          <TicketListTable items={list.items} />
        ) : hasFilters ? (
          <EmptyState description={t("empty.searchHint")} title={t("empty.searchTitle")} />
        ) : (
          <EmptyState
            action={{ label: t("action.create"), icon: <Plus className="size-3.5" />, onClick: openCreate }}
            description={t("empty.hint")}
            title={t("empty.title")}
          />
        )}

        {/* 有内容、或停在靠后的空页时才给翻页：空列表的第一页上「上一页」没有意义。 */}
        {list.items.length > 0 || list.hasPrevPage ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-text-muted">{t("list.loadedCount", { count: list.items.length })}</span>
            <div className="flex items-center gap-2">
              <Button
                disabled={!list.hasPrevPage || list.loading}
                onClick={list.goPrevPage}
                size="sm"
                variant="outline"
              >
                <ChevronLeft className="size-3.5" />
                {t("action.prevPage")}
              </Button>
              <Button
                disabled={list.nextCursor === null || list.loading}
                onClick={list.goNextPage}
                size="sm"
                variant="outline"
              >
                {t("action.nextPage")}
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <TicketCreateDialog
        key={`create-${createFormKey}`}
        onAccepted={handleAccepted}
        onCreated={handleCreated}
        onOpenChange={setCreateOpen}
        open={createOpen}
        projectId={projectId}
      />
    </AppPage>
  );
}
