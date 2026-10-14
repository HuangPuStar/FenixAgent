/**
 * 平台工单列表（管理面）：跨组织工单索引的只读渲染与取数编排。
 *
 * 与 `/agent/tickets` 的列表页是三处刻意的不同，其余（状态角标、时间格式、空/错误文案）全部复用：
 * 1. **凭据**：这里走 `/api/system/tickets`（系统 master key）。凭据失效（401）不回「无权查看」的稳定结论页，
 *    而是清 key 并由 `AdminTicketsPage` 的门请人重输——结论页在这里只会让人以为是平台坏了。
 * 2. **范围**：没有「当前组织」这个概念，因此没有项目总览、没有创建入口；筛选只有「标题关键词 + 状态」。
 * 3. **分页**：页码语义（上一页/下一页 + 总数），不是工单号游标——跨项目时工单号不构成全局序。
 *
 * 状态落点与列表页同口径（顺序即优先级）：首屏骨架 → 失败（带重试）→ 空态（无筛选 / 有筛选两种文案）→ 表格。
 * 请求失败**不得**落进空态：那会让人以为平台里确实没有工单。
 *
 * `organizationId` / `projectId` 两个服务端筛选参数本页不下发：下拉数据源需要额外一条组织/项目名录接口，
 * 而管理面当前的需求是「看见全部」。参数留在协议面上（`web/api/system-tickets.ts`），谁需要谁传。
 */

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent } from "@fenix/ui-components/ui/card";
import { Input } from "@fenix/ui-components/ui/input";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { ApiError, unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { AlertCircle, ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SystemTicketSummary } from "../../../api/system-tickets";
import { systemTicketsApi } from "../../../api/system-tickets";
import type { TicketStateFilter } from "../../../api/tickets";
import { TICKETS_NS } from "../../../i18n/namespace";
import { formatTicketTime } from "../../agent-panel/components/ticket-format";
import { TicketStateBadge } from "../../agent-panel/components/ticket-state-badge";

/** 每页条数：取 `/api/system/*` 分页的老默认值（`ApiSystemPaginationQuerySchema` 的 pageSize 缺省 20、上限 200）。 */
const PAGE_SIZE = 20;

/** 首屏与翻页等待期的骨架行（长度即行数；常量数组而不是 `Array.from` 的索引，避免用下标当 key）。 */
const SKELETON_ROWS = [1, 2, 3, 4, 5, 6] as const;

/** 状态筛选三态；与列表页共用 `TicketStateFilter` 取值域。 */
const STATE_FILTERS: readonly { readonly value: TicketStateFilter; readonly labelKey: string }[] = [
  { value: "all", labelKey: "filter.all" },
  { value: "open", labelKey: "filter.open" },
  { value: "closed", labelKey: "filter.closed" },
];

export interface PlatformTicketListProps {
  /** 凭据失效（401）时回门；由 `AdminTicketsPage` 接 `useAdminKeyGate().fail`。 */
  onAuthFailure: () => void;
}

export function PlatformTicketList({ onAuthFailure }: PlatformTicketListProps) {
  const { t, i18n } = useTranslation(TICKETS_NS);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [appliedKeyword, setAppliedKeyword] = useState("");
  const [stateFilter, setStateFilter] = useState<TicketStateFilter>("all");

  const { data, loading, error, refresh } = useRequest(
    async () =>
      unwrap(
        systemTicketsApi.list({
          page,
          pageSize: PAGE_SIZE,
          q: appliedKeyword.trim() || undefined,
          state: stateFilter === "all" ? undefined : stateFilter,
        }),
      ),
    {
      refreshDeps: [page, appliedKeyword, stateFilter],
      onError: (err: Error) => {
        // 401 回门（门上已有明确提示），其余失败由页面里的持久失败分支承担反馈；日志保留原始错误。
        if (err instanceof ApiError && err.code === "UNAUTHORIZED") onAuthFailure();
        else console.error("system tickets load failed", err);
      },
    },
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtering = appliedKeyword.trim().length > 0 || stateFilter !== "all";
  const firstLoad = loading && data === undefined;

  /** 换筛选条件必须回到第一页：留在第 3 页会把「筛选后一条都没有」误报成空结果。 */
  const applyFilter = (next: { keyword?: string; state?: TicketStateFilter }) => {
    if (next.keyword !== undefined) setAppliedKeyword(next.keyword);
    if (next.state !== undefined) setStateFilter(next.state);
    setPage(1);
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{t("admin.title")}</h1>
            <p className="text-xs text-text-muted">{t("admin.subtitle")}</p>
          </div>
          <Button disabled={loading} onClick={refresh} variant="outline">
            <RefreshCw />
            {t("action.refresh")}
          </Button>
        </header>

        <Card>
          <CardContent className="flex flex-wrap items-center gap-2 pt-6">
            <Input
              aria-label={t("admin.searchPlaceholder")}
              className="w-64"
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyFilter({ keyword });
              }}
              placeholder={t("admin.searchPlaceholder")}
              value={keyword}
            />
            <Button onClick={() => applyFilter({ keyword })} variant="secondary">
              <Search />
              {t("filter.searchLabel")}
            </Button>
            <div className="flex items-center gap-1" role="group" aria-label={t("filter.stateLabel")}>
              {STATE_FILTERS.map((option) => (
                <Button
                  key={option.value}
                  onClick={() => applyFilter({ state: option.value })}
                  size="sm"
                  variant={stateFilter === option.value ? "default" : "outline"}
                >
                  {t(option.labelKey)}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {firstLoad ? <TicketListSkeleton /> : null}

        {!firstLoad && error !== undefined ? (
          <EmptyState
            action={{ label: t("loadState.retry"), onClick: refresh, icon: <RefreshCw />, disabled: loading }}
            description={t("loadState.failed", { message: error.message })}
            icon={<AlertCircle />}
            role="alert"
            title={t("admin.loadFailedTitle")}
            tone="danger"
          />
        ) : null}

        {!firstLoad && error === undefined ? (
          items.length === 0 ? (
            <EmptyState
              description={filtering ? t("empty.searchHint") : t("admin.emptyHint")}
              title={filtering ? t("empty.searchTitle") : t("admin.emptyTitle")}
            />
          ) : (
            <PlatformTicketTable items={items} locale={i18n.language} />
          )
        ) : null}

        {!firstLoad && error === undefined && total > 0 ? (
          <footer className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-text-muted">{t("admin.pageIndicator", { page, totalPages, total })}</p>
            <div className="flex gap-2">
              <Button disabled={page <= 1 || loading} onClick={() => setPage(page - 1)} variant="outline">
                <ChevronLeft />
                {t("action.prevPage")}
              </Button>
              <Button disabled={page >= totalPages || loading} onClick={() => setPage(page + 1)} variant="outline">
                {t("action.nextPage")}
                <ChevronRight />
              </Button>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function TicketListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {SKELETON_ROWS.map((row) => (
        <Skeleton className="h-10 w-full" key={`skeleton-row-${row}`} />
      ))}
    </div>
  );
}

/** 列表行的只读渲染。坐标列是管理面独有的信息：没有它，两个组织的同名工单号无法区分。 */
function PlatformTicketTable({
  items,
  locale,
}: {
  readonly items: readonly SystemTicketSummary[];
  readonly locale: string;
}) {
  const { t } = useTranslation(TICKETS_NS);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface-1">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-24">{t("list.columnNumber")}</TableHead>
            <TableHead>{t("list.columnTitle")}</TableHead>
            <TableHead className="w-24">{t("list.columnState")}</TableHead>
            <TableHead className="w-40">{t("admin.columnOrganization")}</TableHead>
            <TableHead className="w-48">{t("admin.columnRepository")}</TableHead>
            <TableHead className="w-40">{t("list.columnAuthor")}</TableHead>
            <TableHead className="w-44">{t("detail.syncedAtLabel")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={`${item.projectId}:${item.issueNumber}`}>
              <TableCell className="text-text-muted tabular-nums">#{item.issueNumber}</TableCell>
              <TableCell className="text-text-primary">{item.title}</TableCell>
              <TableCell>
                <TicketStateBadge state={item.state} />
              </TableCell>
              <TableCell className="text-text-secondary">{item.organizationName}</TableCell>
              <TableCell className="text-text-secondary">{`${item.projectOwner}/${item.projectName}`}</TableCell>
              <TableCell className="text-text-secondary">{item.author.name}</TableCell>
              <TableCell className="text-text-secondary whitespace-nowrap">
                {formatTicketTime(item.syncedAt, locale)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
