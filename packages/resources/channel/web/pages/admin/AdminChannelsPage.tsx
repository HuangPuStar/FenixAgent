/**
 * 管理台的「消息通道」页（`/admin/channels`）。
 *
 * 数据面是系统 master key（`RCS_SYSTEM_API_KEYS`）保护的 `/api/system/channels`：admin 页面没有登录会话与
 * active organization，控制面的 `/web/channels/langbot/*` 在这里调不到（会 401）。凭据由
 * `AdminKeyGate` 收取并存进当前标签页的 sessionStorage，401 走 `useAdminKeyGate().fail` 清 key 回门。
 *
 * 页面内容 = 原「消息通道 → 诊断」页签的能力（LangBot 连通性、通道、会话表）加上跨组织的
 * 「组织 → 用户 → 通道 → 实例」拓扑：通道/会话的归属问题只有在跨组织视角下才看得出来。
 */

import { AdminKeyGate } from "@fenix/ui-components/config/AdminKeyGate";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@fenix/ui-components/ui/card";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { ApiError } from "@fenix/web-runtime/api/request";
import { useAdminKeyGate } from "@fenix/web-runtime/hooks/use-admin-key-gate";
import { useRequest } from "ahooks";
import { AlertTriangle, MessageSquare, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type ChannelAdminStatus, channelAdminApi } from "../../api/admin";
import { CHANNELS_NS } from "../../i18n/namespace";
import { ChannelInstanceTable, flattenChannelInstances } from "./components/channel-instance-table";
import { ChannelTopologyTree } from "./components/channel-topology-tree";

/** 面板轮询间隔（ms），与观察中心一致：排障时既不能一直手动刷，也不该每次请求都打上游。 */
const POLLING_INTERVAL_MS = 15_000;

export function AdminChannelsPage() {
  const { t } = useTranslation(CHANNELS_NS);
  const gate = useAdminKeyGate(t("langbot.admin.loginError"));

  return (
    <AdminKeyGate
      unlocked={gate.unlocked}
      error={gate.error}
      onUnlock={gate.unlock}
      title={t("langbot.admin.loginTitle")}
      description={t("langbot.admin.loginDescription")}
      inputPlaceholder={t("langbot.admin.loginPlaceholder")}
      submitLabel={t("langbot.admin.loginSubmit")}
    >
      <ChannelsDashboard onAuthFailure={gate.fail} />
    </AdminKeyGate>
  );
}

function ChannelsDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { t } = useTranslation(CHANNELS_NS);
  const { data, loading, error, refresh } = useRequest(() => channelAdminApi.fetchSnapshot(), {
    pollingInterval: POLLING_INTERVAL_MS,
    onError: (err) => {
      // 401 → master key 失效：清 key 回门；其余错误保留页面上的错误态，旧数据继续展示。
      if (err instanceof ApiError && err.code === "UNAUTHORIZED") onAuthFailure();
    },
  });

  const organizations = data?.organizations ?? [];
  const rows = useMemo(() => flattenChannelInstances(organizations), [organizations]);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card/80 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">{t("langbot.admin.title")}</h1>
          <p className="text-xs text-text-muted">{t("langbot.admin.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className="size-3.5" />
          {t("langbot.common.refresh")}
        </Button>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-6">
        {data ? (
          <>
            <ConnectivityCard status={data.status} />
            {organizations.length === 0 ? (
              <EmptyState
                icon={<MessageSquare />}
                title={t("langbot.admin.emptyTitle")}
                description={t("langbot.admin.emptyDescription")}
                className="rounded-md border border-border bg-card px-4 py-10"
              />
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">{t("langbot.admin.topologyTitle")}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ChannelTopologyTree organizations={organizations} />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">{t("langbot.admin.tableTitle")}</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <ChannelInstanceTable rows={rows} />
                  </CardContent>
                </Card>
              </>
            )}
          </>
        ) : loading ? (
          <LoadingSkeleton />
        ) : (
          <EmptyState
            icon={<AlertTriangle />}
            tone="danger"
            role="alert"
            title={error?.message || t("langbot.common.loadFailed")}
            action={{ label: t("langbot.common.retry"), onClick: refresh, icon: <RefreshCw /> }}
            className="rounded-md border border-destructive/40 bg-card px-4 py-10"
          />
        )}
      </main>
    </div>
  );
}

function ConnectivityCard({ status }: { status: ChannelAdminStatus }) {
  const { t } = useTranslation(CHANNELS_NS);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t("langbot.admin.connectivityTitle")}</CardTitle>
        <CardAction>
          <StatusBadge
            status={status.reachable ? "reachable" : "unreachable"}
            toneMap={{ reachable: "success", unreachable: "danger" }}
            label={status.reachable ? t("langbot.admin.reachable") : t("langbot.admin.unreachable")}
            indicator="dot"
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <div>
            <dt className="text-xs text-text-muted">{t("langbot.admin.version")}</dt>
            <dd className="text-text-secondary">{status.version ?? t("langbot.common.unknown")}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">{t("langbot.admin.edition")}</dt>
            <dd className="text-text-secondary">{status.edition ?? t("langbot.common.unknown")}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted">{t("langbot.admin.wizard")}</dt>
            <dd className="text-text-secondary">{status.wizardStatus ?? t("langbot.common.unknown")}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
