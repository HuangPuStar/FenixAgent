// web/src/pages/admin/components/SandboxDashboard.tsx
// 沙盒管理面板外壳：标题栏、两个 Tab（资源池 / Cluster）与四个对话框的装配。
// 自原 AdminSandboxPage.tsx 拆出；状态与请求编排全部在 useSandboxDashboard，本文件只做渲染与 a11y 语义。
//
// Tab 用 Button + role="tab"/role="tabpanel" 手工实现（而非引入 ui/tabs 的 Radix Tabs）：
// 原实现是「次级按钮 + 条件渲染」，换成 Tabs 组件会重写 DOM 与切换动画，属于拆分范围外的行为变更。

import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { Button } from "@fenix/ui-components/ui/button";
import { Database, RefreshCw, Server } from "lucide-react";

import { useSandboxDashboard } from "../use-sandbox-dashboard";
import { ClusterPanel } from "./ClusterPanel";
import { InstanceDetailDialog } from "./InstanceDetailDialog";
import { PoolDialog } from "./PoolDialog";
import { PoolTree } from "./PoolTree";
import { ProviderPayloadDialog } from "./ProviderPayloadDialog";

export function SandboxDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const dashboard = useSandboxDashboard(onAuthFailure);
  const { t } = dashboard;
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{t("title")}</h1>
            <p className="text-xs text-text-muted">{t("subtitle")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-label={t("states.refresh")}
            onClick={() => void (dashboard.tab === "pools" ? dashboard.refreshPools() : dashboard.refreshCluster())}
          >
            <RefreshCw className="size-3.5" />
            {t("states.refresh")}
          </Button>
        </header>
        <div role="tablist" aria-label={t("title")} className="flex gap-2 border-b border-border">
          <Button
            role="tab"
            id="sandbox-tab-pools"
            aria-selected={dashboard.tab === "pools"}
            aria-controls="sandbox-panel-pools"
            variant={dashboard.tab === "pools" ? "secondary" : "ghost"}
            onClick={() => dashboard.setTab("pools")}
          >
            <Database className="size-4" />
            {t("poolsTab")}
          </Button>
          <Button
            role="tab"
            id="sandbox-tab-cluster"
            aria-selected={dashboard.tab === "cluster"}
            aria-controls="sandbox-panel-cluster"
            variant={dashboard.tab === "cluster" ? "secondary" : "ghost"}
            onClick={() => {
              dashboard.setTab("cluster");
              dashboard.ensureClusterLoaded();
            }}
          >
            <Server className="size-4" />
            {t("clusterTab")}
          </Button>
        </div>
        {dashboard.tab === "pools" ? (
          <div role="tabpanel" id="sandbox-panel-pools" aria-labelledby="sandbox-tab-pools">
            <PoolTree
              pools={dashboard.pools}
              instancesByPool={dashboard.instancesByPool}
              loading={dashboard.poolsLoading}
              error={dashboard.poolsError}
              onRetry={dashboard.refreshPools}
              onCreatePool={dashboard.openCreatePool}
              onPoolDetail={dashboard.openPoolDetail}
              onPoolDelete={dashboard.requestPoolDelete}
              onPoolRebuild={dashboard.requestPoolRebuild}
              onInstanceDetail={dashboard.openInstanceDetail}
              onProviderPayload={dashboard.openProviderPayload}
              onInstanceDelete={dashboard.requestInstanceDelete}
              onInstanceRebuild={dashboard.requestInstanceRebuild}
            />
          </div>
        ) : (
          <div role="tabpanel" id="sandbox-panel-cluster" aria-labelledby="sandbox-tab-cluster">
            <ClusterPanel
              data={dashboard.clusterData}
              loading={dashboard.clusterLoading}
              error={dashboard.clusterError}
              onRefresh={() => void dashboard.refreshCluster()}
              onAction={dashboard.runClusterAction}
            />
          </div>
        )}
      </div>
      <PoolDialog
        open={dashboard.poolFormOpen}
        pool={dashboard.poolForm}
        organizations={dashboard.organizations}
        onOpenChange={dashboard.closePoolForm}
        onSave={dashboard.savePool}
      />
      <InstanceDetailDialog
        instance={dashboard.instanceDetail}
        editMode={dashboard.instanceEditMode}
        loading={dashboard.actionLoading}
        onOpenChange={(open) => {
          if (!open) dashboard.closeInstanceDetail();
        }}
        onSave={async (patch) => {
          if (!dashboard.instanceDetail) return;
          dashboard.requestInstanceUpdate(dashboard.instanceDetail.id, patch);
        }}
      />
      <ProviderPayloadDialog
        target={dashboard.providerPayload}
        onOpenChange={(open) => !open && dashboard.closeProviderPayload()}
      />
      <ConfirmDialog
        open={dashboard.rebuildTarget !== null}
        onOpenChange={(open) => !open && dashboard.closeRebuild()}
        title={t("confirmRebuildTitle")}
        description={t("confirmRebuildDescription")}
        confirmLabel={t("rebuild")}
        variant="destructive"
        onConfirm={() => void dashboard.confirmRebuild()}
        loading={dashboard.actionLoading}
      />
      <ConfirmDialog
        open={dashboard.instanceUpdateTarget !== null}
        onOpenChange={(open) => !open && dashboard.closeInstanceUpdate()}
        title={t("confirmResourceUpdateTitle")}
        description={t("confirmResourceUpdateDescription")}
        confirmLabel={t("save")}
        variant="destructive"
        onConfirm={() => void dashboard.confirmInstanceUpdate()}
        loading={dashboard.actionLoading}
      />
      <ConfirmDialog
        open={dashboard.deleteTarget !== null}
        onOpenChange={(open) => !open && dashboard.closeDelete()}
        title={t("confirmDeleteTitle")}
        description={t("confirmDeleteDescription", { name: dashboard.deleteTarget?.name ?? "" })}
        confirmLabel={t("delete")}
        variant="destructive"
        onConfirm={() => void dashboard.confirmDelete()}
        loading={dashboard.actionLoading}
      />
    </div>
  );
}
