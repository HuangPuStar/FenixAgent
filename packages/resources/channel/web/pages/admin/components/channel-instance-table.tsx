/**
 * 管理台的会话实例表：把拓扑里的实例拍平成一行一个实例，客户端分页。
 *
 * 树适合看归属，表适合扫时间：排障时常常先问「最近活跃的是哪几个会话」，那需要按列横向比较，而不是逐层
 * 展开。数据仍只有一份（来自同一次 `/api/system/channels`），翻页与轮询都不会再发请求。
 */

import { Button } from "@fenix/ui-components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChannelAdminInstance, ChannelAdminOrganization } from "../../../api/admin";
import { CHANNELS_NS } from "../../../i18n/namespace";
import { formatDateTime } from "../../../lib/channel-page-state";

const PAGE_SIZE = 10;

/** 一行实例的展示字段；组织名不进表列（表按通道/用户定位，组织已在拓扑里表达）。 */
export interface ChannelInstanceRow {
  /** 会话映射 id 在全局唯一，可直接作 React key。 */
  readonly conversationId: string;
  readonly channelName: string;
  readonly userName: string;
  readonly instance: ChannelAdminInstance;
}

/** 拍平拓扑：顺序沿用树里的顺序（组织 → 用户 → 通道 → 实例），翻页不会因为重排而跳动。 */
export function flattenChannelInstances(organizations: readonly ChannelAdminOrganization[]): ChannelInstanceRow[] {
  const rows: ChannelInstanceRow[] = [];
  for (const organization of organizations) {
    for (const user of organization.users) {
      for (const channel of user.channels) {
        for (const instance of channel.instances) {
          rows.push({
            conversationId: instance.conversationId,
            channelName: channel.name,
            userName: user.name,
            instance,
          });
        }
      }
    }
  }
  return rows;
}

function Cell({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <td className="px-4 py-3 text-text-secondary" title={title}>
      {children}
    </td>
  );
}

export function ChannelInstanceTable({ rows }: { rows: readonly ChannelInstanceRow[] }) {
  const { t, i18n } = useTranslation(CHANNELS_NS);
  const [page, setPage] = useState(1);
  // 轮询后数据可能变短：页码在渲染时收敛，避免停在一个已不存在的页上显示空表。
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div data-testid="channel-instance-table">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface-2 text-xs text-text-muted">
          <tr>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("langbot.admin.table.channel")}
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("langbot.admin.table.user")}
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("langbot.admin.table.chat")}
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("langbot.admin.table.chatId")}
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("langbot.admin.table.agent")}
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("langbot.admin.table.session")}
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("langbot.admin.table.instance")}
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("langbot.admin.table.lastEventAt")}
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              {t("langbot.admin.table.lastReplyAt")}
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={row.conversationId} className="border-t border-border-subtle">
              <Cell>{row.channelName}</Cell>
              <Cell>{row.userName}</Cell>
              <Cell>
                {row.instance.chatType === "group"
                  ? t("langbot.routes.chatTypeGroup")
                  : t("langbot.routes.chatTypePerson")}
              </Cell>
              <Cell title={row.instance.chatId}>{row.instance.chatId}</Cell>
              <Cell title={row.instance.agentConfigId}>{row.instance.agentConfigId}</Cell>
              <Cell title={row.instance.sessionId}>
                <span className="font-mono text-xs text-text-muted">{row.instance.sessionId}</span>
              </Cell>
              <Cell>
                <span className="font-mono text-xs text-text-primary">{row.instance.instanceName}</span>
              </Cell>
              <Cell>{formatDateTime(row.instance.lastEventAt, i18n.language) ?? t("langbot.common.never")}</Cell>
              <Cell>{formatDateTime(row.instance.lastReplyAt, i18n.language) ?? t("langbot.common.never")}</Cell>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-2 text-xs text-text-muted">
        <span>{t("langbot.admin.page", { page: currentPage, total: totalPages })}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage(currentPage - 1)}
          disabled={currentPage <= 1}
          aria-label={t("langbot.admin.prev")}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage(currentPage + 1)}
          disabled={currentPage >= totalPages}
          aria-label={t("langbot.admin.next")}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
