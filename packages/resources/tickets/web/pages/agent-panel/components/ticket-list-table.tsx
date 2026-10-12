/**
 * 工单列表表格：索引行的只读渲染（纯展示，取数与分页由列表页与 `useTicketList` 负责）。
 *
 * 行内链接用**行自带**的 `projectId` 拼路径，不用页面当前的项目：默认项目一旦切换，用页面项目拼出的
 * 链接会把同一条目的点击带去另一个仓库（方案 §8 要求所有工单资源 URL 显式带 projectId）。
 * `issueNumber` 全程按字符串传递（外部数字 ID 在协议里不退化），因此这里不做 `String()`/`Number()` 转换。
 *
 * 作者列在 `source === "external"` 时并排挂一个「外部来源／待核对」角标：归属是否可信由服务端用受信记录
 * 核验，列表页至少要让读者看见「这条的作者没有可信凭据」，而不是把外部自填的名字当既有事实。
 */

import { Badge } from "@fenix/ui-components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { TicketSummary } from "../../../api/tickets";
import { TICKETS_NS } from "../../../i18n/namespace";
import { formatTicketTime } from "./ticket-format";
import { TicketStateBadge } from "./ticket-state-badge";

export interface TicketListTableProps {
  items: TicketSummary[];
}

export function TicketListTable({ items }: TicketListTableProps) {
  const { t, i18n } = useTranslation(TICKETS_NS);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface-1">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-24">{t("list.columnNumber")}</TableHead>
            <TableHead>{t("list.columnTitle")}</TableHead>
            <TableHead className="w-24">{t("list.columnState")}</TableHead>
            <TableHead className="w-48">{t("list.columnAuthor")}</TableHead>
            <TableHead className="w-40">{t("list.columnAssignee")}</TableHead>
            <TableHead className="w-44">{t("list.columnUpdatedAt")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.issueNumber}>
              <TableCell className="text-text-muted tabular-nums">#{item.issueNumber}</TableCell>
              <TableCell>
                <Link
                  className="text-brand hover:underline"
                  params={{ projectId: item.projectId, number: item.issueNumber }}
                  to="/agent/tickets/$projectId/$number"
                >
                  {item.title}
                </Link>
              </TableCell>
              <TableCell>
                <TicketStateBadge state={item.state} />
              </TableCell>
              <TableCell className="text-text-secondary">
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{item.author.name}</span>
                  {item.author.source === "external" ? (
                    <Badge variant="outline">{t("detail.externalAuthor")}</Badge>
                  ) : null}
                </span>
              </TableCell>
              <TableCell className="text-text-secondary">
                {item.assignee === null ? t("list.unassigned") : item.assignee.name}
              </TableCell>
              <TableCell className="text-text-secondary whitespace-nowrap">
                {formatTicketTime(item.providerUpdatedAt, i18n.language)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
