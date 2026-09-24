// web/src/pages/admin/AdminObserverPage.tsx
// Observer 观察中心仪表盘壳（docs/arch/21 §5）：
// - useRequest 拉取 acp-link 快照 + 定时轮询（15s）+ 手动刷新；
// - kind tab、概览卡、归属树 / machine 树 / 平坦表、一致性告警区；
// - 请求 401（UNAUTHORIZED）→ clearAdminKey() 回门（`useAdminKeyGate().fail`）；
// - 覆盖 loading / empty / error / retry 状态。

import { integrityRows, machineReverseIndex, mergeFlatRows } from "@fenix/resource-sandbox/web";
import { AdminKeyGate } from "@fenix/ui-components/config/AdminKeyGate";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { formatClockTime } from "@fenix/ui-components/lib/format";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@fenix/ui-components/ui/card";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fenix/ui-components/ui/tabs";
import { ApiError } from "@fenix/web-runtime/api/request";
import { useAdminKeyGate } from "@fenix/web-runtime/hooks/use-admin-key-gate";
import { useRequest } from "ahooks";
import { LogOut, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AcpLinkSnapshot, observerApi } from "../../api/observer";
import { ObserverFlatTable } from "./components/ObserverFlatTable";
import { ObserverIntegrityAlert } from "./components/ObserverIntegrityAlert";
import { ObserverMachineTree } from "./components/ObserverMachineTree";
import { ObserverOrgTree } from "./components/ObserverOrgTree";

/** 面板定时轮询间隔（ms），与 AgentSidebarTree 的 15s 对齐。 */
const POLLING_INTERVAL_MS = 15_000;

export function AdminObserverPage() {
  const { t } = useTranslation("observer");
  const gate = useAdminKeyGate(t("login.error"));

  return (
    <AdminKeyGate
      unlocked={gate.unlocked}
      error={gate.error}
      onUnlock={gate.unlock}
      title={t("login.title")}
      description={t("login.description")}
      inputPlaceholder={t("login.inputPlaceholder")}
      submitLabel={t("login.submit")}
    >
      <ObserverDashboard onAuthFailure={gate.fail} />
    </AdminKeyGate>
  );
}

function ObserverDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { t } = useTranslation("observer");
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);

  const { data, loading, error, refresh } = useRequest(() => observerApi.fetchAcpLinkSnapshot(), {
    pollingInterval: POLLING_INTERVAL_MS,
    onError: (err) => {
      // 401 → master key 失效：清 key 回门；其余错误保留面板展示错误态
      if (err instanceof ApiError && err.code === "UNAUTHORIZED") {
        onAuthFailure();
      }
    },
  });

  const reverseIndex = useMemo(() => (data ? machineReverseIndex(data) : new Map<string, string[]>()), [data]);
  const highlightedLeafIds = useMemo(() => {
    if (!selectedMachineId) return new Set<string>();
    return new Set(reverseIndex.get(selectedMachineId) ?? []);
  }, [selectedMachineId, reverseIndex]);
  const flatRows = useMemo(() => (data ? mergeFlatRows(data) : []), [data]);
  const mismatchRows = useMemo(() => (data ? integrityRows(data) : []), [data]);

  // 退出即失效：走与 401 同一条失败路径（清 key → 带提示回门），避免两处各写一遍清理顺序。
  const logout = () => {
    onAuthFailure();
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card/80 px-6 py-3 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">{t("title")}</h1>
          <p className="text-xs text-text-muted">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className="size-3.5" />
            {t("states.refresh")}
          </Button>
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut className="size-3.5" />
            {t("login.logout")}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-6">
        {data ? (
          <ObserverContent
            view={data}
            flatRows={flatRows}
            mismatchRows={mismatchRows}
            highlightedLeafIds={highlightedLeafIds}
            selectedMachineId={selectedMachineId}
            onSelectMachine={setSelectedMachineId}
          />
        ) : loading ? (
          <LoadingSkeleton />
        ) : error ? (
          <EmptyState
            title={t("states.error")}
            tone="danger"
            role="alert"
            action={{ label: t("states.retry"), onClick: refresh, icon: <RefreshCw /> }}
            className="rounded-md border border-destructive/40 bg-card px-4 py-10"
          />
        ) : (
          <EmptyState title={t("tree.noData")} className="rounded-md border border-border bg-card px-4 py-6" />
        )}
      </main>
    </div>
  );
}

function ObserverContent({
  view,
  flatRows,
  mismatchRows,
  highlightedLeafIds,
  selectedMachineId,
  onSelectMachine,
}: {
  view: AcpLinkSnapshot;
  flatRows: ReturnType<typeof mergeFlatRows>;
  mismatchRows: ReturnType<typeof integrityRows>;
  highlightedLeafIds: Set<string>;
  selectedMachineId: string | null;
  onSelectMachine: (machineId: string | null) => void;
}) {
  const { t } = useTranslation("observer");

  // 无观察数据（total=0）时展示空状态
  if (view.total === 0) {
    return <EmptyState title={t("tree.noData")} className="rounded-md border border-border bg-card px-4 py-6" />;
  }

  return (
    <div className="space-y-6">
      <OverviewCards view={view} />
      <ObserverIntegrityAlert rows={mismatchRows} checked={view.integrity.checked} />

      <Tabs defaultValue="org">
        <div className="flex items-center gap-3">
          <TabsList>
            <TabsTrigger value="org">{t("tree.orgTree")}</TabsTrigger>
            <TabsTrigger value="machine">{t("tree.machineTree")}</TabsTrigger>
            <TabsTrigger value="flat">{t("tree.flatTable")}</TabsTrigger>
          </TabsList>
          <Badge variant="secondary">{t("kind.acpLink")}</Badge>
        </div>

        <TabsContent value="org">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("tree.orgTree")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ObserverOrgTree orgs={view.trees.byOrg} highlightedLeafIds={highlightedLeafIds} names={view.names} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="machine">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("tree.machineTree")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-text-muted">{t("tree.selectMachine")}</p>
              <ObserverMachineTree
                machines={view.trees.byEntity}
                selectedMachineId={selectedMachineId}
                onSelectMachine={onSelectMachine}
                names={view.names}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="flat">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("tree.flatTable")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ObserverFlatTable rows={flatRows} names={view.names} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OverviewCards({ view }: { view: AcpLinkSnapshot }) {
  const { t } = useTranslation("observer");
  const cards = [
    { label: t("overview.total"), value: view.total },
    { label: t("overview.machines"), value: view.trees.byEntity.length },
    { label: t("overview.mismatched"), value: view.integrity.mismatched },
    { label: t("overview.lastUpdated"), value: formatClockTime(view.generatedAt) },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="space-y-1">
            <p className="text-xs text-text-muted">{card.label}</p>
            <p className="text-2xl font-semibold text-text-primary">{card.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
