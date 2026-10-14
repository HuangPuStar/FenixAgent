/**
 * 工单列表的筛选条：关键词 + 状态两个控件（纯展示，筛选值由列表页持有）。
 *
 * 只上报变化、不持有筛选状态，也不碰路由：筛选是会话内状态、**不落 URL query**（`/agent/tickets` 只表达
 * 「当前组织的默认项目」；工单数一多，把筛选写进地址栏反而会让刷新与分享各自带出不同的列表语义）。
 * 重置筛选不需要额外入口——清空关键词、状态选回「全部」即可。
 *
 * 状态筛选的取值用类型守卫收口而不是 `as TicketStateFilter`：Radix 的 `onValueChange` 给的是 `string`，
 * 断言会把「新增状态却忘了加选项」直接变成运行时错值，而守卫会在编译期之外把它挡在状态机入口。
 */

import { Input } from "@fenix/ui-components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TicketStateFilter } from "../../../api/tickets";
import { TICKETS_NS } from "../../../i18n/namespace";

const STATE_FILTERS: readonly TicketStateFilter[] = ["all", "open", "closed"];

/** `string` → `TicketStateFilter` 的收口；不在取值集合内一律退回「全部」。 */
function toStateFilter(value: string): TicketStateFilter {
  return STATE_FILTERS.find((candidate) => candidate === value) ?? "all";
}

export interface TicketFilterBarProps {
  query: string;
  stateFilter: TicketStateFilter;
  onQueryChange: (value: string) => void;
  onStateFilterChange: (value: TicketStateFilter) => void;
}

export function TicketFilterBar({ query, stateFilter, onQueryChange, onStateFilterChange }: TicketFilterBarProps) {
  const { t } = useTranslation(TICKETS_NS);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-dim"
        />
        <Input
          aria-label={t("filter.searchLabel")}
          className="pl-8"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("filter.searchPlaceholder")}
          type="search"
          value={query}
        />
      </div>
      <Select value={stateFilter} onValueChange={(value) => onStateFilterChange(toStateFilter(value))}>
        {/* 触发器自身没有可见文本（值来自 `SelectValue`），可访问名由 `aria-label` 提供。 */}
        <SelectTrigger aria-label={t("filter.stateLabel")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("filter.all")}</SelectItem>
          <SelectItem value="open">{t("filter.open")}</SelectItem>
          <SelectItem value="closed">{t("filter.closed")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
