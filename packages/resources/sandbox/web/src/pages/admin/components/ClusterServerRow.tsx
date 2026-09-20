// web/src/pages/admin/components/ClusterServerRow.tsx
// Cluster Server 行：状态徽标 + 动作按钮，下挂远端沙盒面板。自原 AdminSandboxPage.tsx 拆出。
//
// transportMode / status / healthStatus 是后端枚举值，直接展示原值（不做本地化映射）：
// 它们是运维排障时与后端日志对齐的标识，翻译反而会让两边对不上。

import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../../i18n/namespace";
import type { ClusterServer } from "../../../api/system-sandbox";
import { RemoteSandboxPanel } from "./RemoteSandboxPanel";

interface ClusterServerRowProps {
  server: ClusterServer;
  onEdit: () => void;
  onHealthCheck: () => void;
  onPrepareTunnel: () => void;
  onDownload: () => Promise<void>;
  onDelete: () => void;
}

export function ClusterServerRow({
  server,
  onEdit,
  onHealthCheck,
  onPrepareTunnel,
  onDownload,
  onDelete,
}: ClusterServerRowProps) {
  const { t } = useTranslation(SANDBOX_NS);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 rounded border border-border bg-background p-3 text-xs">
        <Server className="size-3.5 shrink-0 text-text-muted" />
        <span className="font-medium">{server.name}</span>
        <span className="font-mono text-text-muted">{server.id}</span>
        <Badge variant="outline">{server.transportMode}</Badge>
        <Badge variant={server.status === "online" ? "secondary" : "destructive"}>{server.status}</Badge>
        <Badge
          variant={server.healthStatus === "unhealthy" ? "destructive" : "outline"}
          className={server.healthStatus === "healthy" ? "border-green-200 bg-green-50 text-green-700" : undefined}
        >
          {server.healthStatus}
        </Badge>
        <span className="text-text-muted">
          {t("serverSandboxUsage", { current: server.currentSandboxes, max: server.maxSandboxes })}
        </span>
        <span className="ml-auto flex flex-wrap justify-end gap-1">
          <Button size="sm" variant="outline" onClick={onEdit}>
            {t("edit")}
          </Button>
          <Button size="sm" variant="outline" onClick={onHealthCheck}>
            {t("healthCheck")}
          </Button>
          <Button size="sm" variant="outline" onClick={onPrepareTunnel}>
            {t("switchTunnel")}
          </Button>
          {/* 只有 tunnel 模式的 Server 才有可下载的 frpc 配置；direct 模式下按钮不存在。 */}
          {server.transportMode === "tunnel" ? (
            <Button size="sm" variant="outline" onClick={() => void onDownload()}>
              {t("tunnelConfig")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
            onClick={onDelete}
          >
            {t("delete")}
          </Button>
        </span>
      </div>
      <RemoteSandboxPanel server={server} />
    </div>
  );
}
