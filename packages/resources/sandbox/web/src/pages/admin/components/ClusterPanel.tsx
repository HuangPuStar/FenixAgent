// web/src/pages/admin/components/ClusterPanel.tsx
// Cluster 管理面板：Cluster Pool 列表 + 每个 Pool 下的 Server 行 + 四个对话框。
// 自原 AdminSandboxPage.tsx 拆出；动作执行统一走 props.onAction（由 useSandboxDashboard 提供），
// 本文件只负责收集参数、组织文案与在失败时给出可诊断的提示。

import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@fenix/ui-components/ui/card";
import { ChevronRight, Database, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { SANDBOX_NS } from "../../../../i18n/namespace";
import { type ClusterPool, type ClusterServer, systemSandboxApi } from "../../../api/system-sandbox";
import type { ClusterActionFeedback, ClusterServerForm } from "../sandbox-admin-types";
import { formatHealthCheckResult, toClusterServerForm } from "../sandbox-admin-utils";
import { ClusterPoolDialog, ClusterServerDialog } from "./ClusterDialogs";
import { ClusterServerRow } from "./ClusterServerRow";
import { PanelErrorState, PanelLoadingState } from "./PanelStates";
import { RowDeleteButton } from "./RowDeleteButton";

interface ClusterPanelProps {
  data?: { pools: ClusterPool[]; servers: ClusterServer[] };
  loading: boolean;
  error: Error | undefined;
  onRefresh: () => void;
  onAction: (
    fn: () => Promise<unknown>,
    message: string | ((result: unknown) => string | ClusterActionFeedback),
  ) => Promise<boolean>;
}

export function ClusterPanel({ data, loading, error, onRefresh, onAction }: ClusterPanelProps) {
  const { t } = useTranslation(SANDBOX_NS);
  const [poolForm, setPoolForm] = useState<ClusterPool | null>(null);
  const [serverForm, setServerForm] = useState<ClusterServerForm | null>(null);
  const [poolFormOpen, setPoolFormOpen] = useState(false);
  const [serverFormOpen, setServerFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "pool" | "server"; id: string; name: string } | null>(null);
  const [tunnelTarget, setTunnelTarget] = useState<ClusterServer | null>(null);
  const serversByPool = useMemo(() => {
    const grouped = new Map<string, ClusterServer[]>();
    for (const server of data?.servers ?? []) {
      grouped.set(server.poolId, [...(grouped.get(server.poolId) ?? []), server]);
    }
    return grouped;
  }, [data?.servers]);
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await onAction(
      () =>
        deleteTarget.kind === "pool"
          ? systemSandboxApi.cluster.deletePool(deleteTarget.id)
          : systemSandboxApi.cluster.deleteServer(deleteTarget.id),
      t("deleteSuccess"),
    );
    setDeleteTarget(null);
  };
  const confirmTunnel = async () => {
    if (!tunnelTarget) return;
    await onAction(() => systemSandboxApi.cluster.prepareTunnel(tunnelTarget.id), t("tunnelPrepared"));
    setTunnelTarget(null);
  };
  const openServerCreate = (poolId: string) => {
    setServerForm({
      id: "",
      pool_id: poolId,
      name: "",
      base_url: "",
      workspace_root: "/workspaces",
      max_sandboxes: 10,
      status: "active",
      transport_mode: "direct",
    });
    setServerFormOpen(true);
  };
  /**
   * 下载 frpc 配置。接口返回的是 toml 文本而非 /web 信封，因此失败原因取 request 层抛出的 message；
   * 不把内容写进 state，避免大文件在内存里驻留（点一下就落盘）。
   */
  const downloadTunnelConfig = async (server: ClusterServer) => {
    try {
      const content = await systemSandboxApi.cluster.downloadTunnelConfig(server.id);
      const url = URL.createObjectURL(new Blob([content], { type: "application/toml" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${server.id}.frpc.toml`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      toast.error(t("tunnelConfigDownloadError"), {
        description: cause instanceof Error ? cause.message : undefined,
      });
    }
  };
  // 已有数据时保留面板内容，只在首屏（无 data）时占位，避免刷新闪回骨架（占位块见 PanelStates）。
  if (loading && !data) return <PanelLoadingState />;
  if (error && !data) return <PanelErrorState message={t("clusterError")} onRetry={onRefresh} />;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Database className="size-4" />
            {t("clusterPool")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                setPoolForm({ id: "", name: "", status: "active" });
                setPoolFormOpen(true);
              }}
            >
              <Plus className="size-3.5" />
              {t("createClusterPool")}
            </Button>
          </div>
          {data?.pools.map((pool) => {
            const servers = serversByPool.get(pool.id) ?? [];
            return (
              <details key={pool.id} open className="rounded border border-border">
                <summary className="flex cursor-pointer list-none items-center gap-3 p-3 text-sm [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-4 shrink-0 transition-transform [[open]>&]:rotate-90" />
                  <span className="font-medium">{pool.name}</span>
                  <span className="font-mono text-xs text-text-muted">{pool.id}</span>
                  <Badge variant="outline">{pool.status}</Badge>
                  <span className="text-xs text-text-muted">
                    {servers.length} {t("serverCount")}
                  </span>
                  <span className="text-xs text-text-muted">
                    {t("sandboxUsage", {
                      current: pool.currentSandboxes ?? "-",
                      capacity: pool.capacitySandboxes ?? "-",
                    })}
                  </span>
                  {/* 池级动作按钮在 <summary> 内，必须阻止默认行为，否则点击会连带折叠 Pool。 */}
                  <span className="ml-auto flex gap-1" onClick={(event) => event.preventDefault()}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setPoolForm(pool);
                        setPoolFormOpen(true);
                      }}
                    >
                      {t("edit")}
                    </Button>
                    <RowDeleteButton onClick={() => setDeleteTarget({ kind: "pool", id: pool.id, name: pool.name })} />
                  </span>
                </summary>
                <div className="space-y-2 border-t border-border bg-muted/20 p-3">
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => openServerCreate(pool.id)}>
                      <Plus className="size-3.5" />
                      {t("createServer")}
                    </Button>
                  </div>
                  {servers.length === 0 ? (
                    <p className="px-2 py-3 text-xs text-text-muted" role="status">
                      {t("emptyServers")}
                    </p>
                  ) : (
                    servers.map((server) => (
                      <ClusterServerRow
                        key={server.id}
                        server={server}
                        onEdit={() => {
                          setServerForm(toClusterServerForm(server));
                          setServerFormOpen(true);
                        }}
                        onHealthCheck={() =>
                          void onAction(
                            () => systemSandboxApi.cluster.healthCheck(server.id),
                            (result) => formatHealthCheckResult(result, t),
                          )
                        }
                        onPrepareTunnel={() => setTunnelTarget(server)}
                        onDownload={() => downloadTunnelConfig(server)}
                        onDelete={() => setDeleteTarget({ kind: "server", id: server.id, name: server.name })}
                      />
                    ))
                  )}
                </div>
              </details>
            );
          })}
        </CardContent>
      </Card>
      <ClusterPoolDialog
        open={poolFormOpen}
        pool={poolForm}
        onOpenChange={setPoolFormOpen}
        onSave={async (pool) => {
          await onAction(
            () =>
              poolForm?.id
                ? systemSandboxApi.cluster.updatePool(poolForm.id, { name: pool.name, status: pool.status })
                : systemSandboxApi.cluster.createPool(pool),
            t("saveSuccess"),
          );
          setPoolFormOpen(false);
        }}
      />
      <ClusterServerDialog
        open={serverFormOpen}
        server={serverForm}
        onOpenChange={setServerFormOpen}
        onSave={async (server, apiKey) => {
          const body = { ...server, ...(apiKey ? { api_key: apiKey } : {}) };
          delete (body as Record<string, unknown>).id;
          await onAction(
            () =>
              serverForm?.id
                ? systemSandboxApi.cluster.updateServer(serverForm.id, body)
                : systemSandboxApi.cluster.createServer({ ...body, id: server.id, api_key: apiKey }),
            t("saveSuccess"),
          );
          setServerFormOpen(false);
        }}
      />
      <ConfirmDialog
        open={tunnelTarget !== null}
        onOpenChange={(open) => !open && setTunnelTarget(null)}
        title={t("confirmTunnelTitle")}
        description={
          tunnelTarget ? t("confirmTunnelDescription", { name: tunnelTarget.name }) : t("confirmTunnelGeneric")
        }
        confirmLabel={t("switchTunnel")}
        variant="destructive"
        onConfirm={() => void confirmTunnel()}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t("confirmDeleteTitle")}
        description={t("confirmDeleteDescription", { name: deleteTarget?.name ?? "" })}
        confirmLabel={t("delete")}
        variant="destructive"
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
