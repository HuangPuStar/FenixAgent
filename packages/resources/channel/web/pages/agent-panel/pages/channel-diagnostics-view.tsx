import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge, type StatusTone } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { Activity, AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { langbotApi } from "../../../api/langbot";
import { channelDisplayName, formatDateTime, resolveChannelListViewState } from "../../../lib/channel-page-state";

const PAGE_SIZE = 10;

const CONNECTIVITY_TONES: Record<string, StatusTone> = { reachable: "success", unreachable: "danger" };

/**
 * 诊断视图：LangBot 连通性、会话映射与最近事件入口。
 *
 * 控制面没有事件查询接口（规格 §4.2 只定义 conversations），因此「最近事件」只说明不可用，
 * 不用会话字段拼一条看似事件的伪列表——那会让排障者把会话的最后活跃时间当成投递状态。
 */
export function ChannelDiagnosticsView() {
  const { t, i18n } = useTranslation(NS.CHANNELS);
  const [page, setPage] = useState(1);

  const statusRequest = useRequest(() => unwrap(langbotApi.status()));
  // Bot 只用于把会话行里的 channelId 换成名称；失败不阻塞会话表，退回短 ID。
  const botsRequest = useRequest(() => unwrap(langbotApi.listBots()));
  const conversationsRequest = useRequest(() => unwrap(langbotApi.listConversations({ page, pageSize: PAGE_SIZE })), {
    refreshDeps: [page],
  });

  const status = statusRequest.data;
  const unreachable = Boolean(statusRequest.error) || status?.reachable === false;
  const bots = botsRequest.data ?? [];
  const conversations = conversationsRequest.data?.items ?? [];
  const total = conversationsRequest.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const viewState = resolveChannelListViewState({
    loading: conversationsRequest.loading,
    error: conversationsRequest.error,
    itemCount: conversations.length,
  });

  const refreshAll = () => {
    statusRequest.refresh();
    botsRequest.refresh();
    conversationsRequest.refresh();
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border-subtle bg-surface-1 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-text-bright">{t("langbot.diagnostics.statusTitle")}</h2>
          <div className="flex items-center gap-2">
            {statusRequest.loading && !status ? (
              <Skeleton className="h-5 w-16" />
            ) : (
              <StatusBadge
                status={unreachable ? "unreachable" : "reachable"}
                toneMap={CONNECTIVITY_TONES}
                label={unreachable ? t("langbot.diagnostics.unreachable") : t("langbot.diagnostics.reachable")}
                indicator="dot"
              />
            )}
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={statusRequest.loading}>
              <RefreshCw />
              {t("langbot.common.refresh")}
            </Button>
          </div>
        </div>

        {statusRequest.loading && !status ? (
          <div className="mt-3 space-y-2" aria-busy="true">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
              <div>
                <dt className="text-xs text-text-muted">{t("langbot.diagnostics.version")}</dt>
                <dd className="text-text-secondary">{status?.version ?? t("langbot.diagnostics.unknown")}</dd>
              </div>
              <div>
                <dt className="text-xs text-text-muted">{t("langbot.diagnostics.edition")}</dt>
                <dd className="text-text-secondary">{status?.edition ?? t("langbot.diagnostics.unknown")}</dd>
              </div>
              <div>
                <dt className="text-xs text-text-muted">{t("langbot.diagnostics.wizard")}</dt>
                <dd className="text-text-secondary">{status?.wizardStatus ?? t("langbot.diagnostics.unknown")}</dd>
              </div>
            </dl>
            {statusRequest.error ? (
              // 503 表示控制面未配置 LangBot；这里贴原始消息，排障者需要知道是缺配置还是网络不通。
              <p className="mt-3 text-xs leading-5 text-status-error">{statusRequest.error.message}</p>
            ) : null}
          </>
        )}
      </section>

      <section className="rounded-xl border border-border-subtle bg-surface-1 px-4 py-3">
        <h2 className="text-sm font-medium text-text-bright">{t("langbot.diagnostics.eventsTitle")}</h2>
        <EmptyState
          icon={<Activity />}
          title={t("langbot.diagnostics.eventsUnavailableTitle")}
          description={t("langbot.diagnostics.eventsUnavailableDescription")}
        />
      </section>

      <section className="overflow-hidden rounded-xl border border-border-subtle bg-surface-1">
        <div className="border-b border-border-subtle px-4 py-3">
          <h2 className="text-sm font-medium text-text-bright">{t("langbot.diagnostics.conversationsTitle")}</h2>
        </div>

        {viewState === "loading" ? (
          <div className="space-y-2 p-4" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : null}

        {viewState === "unauthorized" ? (
          <EmptyState
            icon={<ShieldAlert />}
            tone="danger"
            role="alert"
            title={t("langbot.common.unauthorizedTitle")}
            description={t("langbot.common.unauthorizedDescription")}
          />
        ) : null}

        {viewState === "error" ? (
          <EmptyState
            icon={<AlertTriangle />}
            tone="danger"
            role="alert"
            title={t("langbot.diagnostics.loadFailed")}
            description={conversationsRequest.error?.message}
            action={{
              label: t("langbot.common.retry"),
              onClick: conversationsRequest.refresh,
              icon: <RefreshCw />,
              disabled: conversationsRequest.loading,
            }}
          />
        ) : null}

        {viewState === "empty" ? (
          <EmptyState
            icon={<Activity />}
            title={t("langbot.diagnostics.conversationsEmptyTitle")}
            description={t("langbot.diagnostics.conversationsEmptyDescription")}
          />
        ) : null}

        {viewState === "ready" ? (
          <>
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs text-text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    {t("langbot.diagnostics.channel")}
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    {t("langbot.diagnostics.chat")}
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    {t("langbot.diagnostics.session")}
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    {t("langbot.diagnostics.agent")}
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    {t("langbot.diagnostics.lastEventAt")}
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    {t("langbot.diagnostics.lastReplyAt")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {conversations.map((conversation) => {
                  const lastEventAt = formatDateTime(conversation.lastEventAt, i18n.language);
                  const lastReplyAt = formatDateTime(conversation.lastReplyAt, i18n.language);
                  return (
                    <tr key={conversation.id} className="border-t border-border-subtle">
                      <td className="px-4 py-3 text-text-secondary">
                        {channelDisplayName(conversation.channelId, bots)}
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-text-secondary">{conversation.chatId}</p>
                        <p className="text-xs text-text-dim">
                          {conversation.chatType === "group"
                            ? t("langbot.routes.chatTypeGroup")
                            : t("langbot.routes.chatTypePerson")}
                        </p>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-text-muted">{conversation.sessionId}</td>
                      <td className="px-4 py-3 font-mono text-xs text-text-muted">{conversation.agentConfigId}</td>
                      <td className="px-4 py-3 text-text-secondary">{lastEventAt ?? t("langbot.common.never")}</td>
                      <td className="px-4 py-3 text-text-secondary">{lastReplyAt ?? t("langbot.common.never")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-4 py-3 text-xs text-text-muted">
              <span>{t("langbot.diagnostics.page", { page, total: totalPages })}</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={page <= 1 || conversationsRequest.loading}
                >
                  <ChevronLeft />
                  {t("langbot.diagnostics.prev")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  disabled={page >= totalPages || conversationsRequest.loading}
                >
                  {t("langbot.diagnostics.next")}
                  <ChevronRight />
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
