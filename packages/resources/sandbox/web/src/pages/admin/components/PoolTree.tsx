// web/src/pages/admin/components/PoolTree.tsx
// 资源池树：池列表与池内实例行。自原 AdminSandboxPage.tsx 拆出（拆分理由见 sandbox-admin-types.ts）。
//
// 状态语义（本包组件统一约定）：加载 → role="status"（sr-only 文案，屏幕阅读器可闻）；
// 错误 → role="alert" + 重试按钮；空态 → role="status"；成功/失败反馈走 sonner toast（自带 aria-live）。

import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent } from "@fenix/ui-components/ui/card";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { ChevronRight, Database, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../../i18n/namespace";
import type { SandboxInstance, SandboxPool } from "../../../api/system-sandbox";
import { InstanceRow } from "./InstanceRow";

interface PoolTreeProps {
  pools: SandboxPool[];
  instancesByPool: Map<string, SandboxInstance[]>;
  loading: boolean;
  error: Error | undefined;
  onRetry: () => void;
  onCreatePool: (template?: SandboxPool) => void;
  onPoolDetail: (pool: SandboxPool) => void;
  onPoolDelete: (pool: SandboxPool) => void;
  onPoolRebuild: (id: string) => void;
  onInstanceDetail: (instance: SandboxInstance) => void;
  onProviderPayload: (instance: SandboxInstance) => void;
  onInstanceDelete: (instance: SandboxInstance) => void;
  onInstanceRebuild: (poolId: string, instanceId: string) => void;
}

export function PoolTree({
  pools,
  instancesByPool,
  loading,
  error,
  onRetry,
  onCreatePool,
  onPoolDetail,
  onPoolDelete,
  onPoolRebuild,
  onInstanceDetail,
  onProviderPayload,
  onInstanceDelete,
  onInstanceRebuild,
}: PoolTreeProps) {
  const { t } = useTranslation(SANDBOX_NS);
  // 已有数据时保留列表、把刷新状态交给 header 的按钮（避免整屏闪回骨架）；只有首屏加载才占位。
  if (loading && pools.length === 0)
    return (
      <div aria-busy="true">
        <Skeleton className="h-72 w-full" />
        <span className="sr-only" role="status">
          {t("states.loading")}
        </span>
      </div>
    );
  if (error && pools.length === 0)
    return (
      <Card>
        <CardContent className="space-y-3 py-8 text-center">
          <p className="text-sm text-destructive" role="alert">
            {t("error")}
          </p>
          <p className="text-xs text-text-muted">{t("errorHint")}</p>
          <Button variant="outline" onClick={onRetry}>
            {t("states.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => onCreatePool()}>
          <Plus className="size-3.5" />
          {t("createPool")}
        </Button>
      </div>
      {pools.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-text-muted" role="status">
            {t("empty")}
          </CardContent>
        </Card>
      ) : (
        pools.map((pool) => (
          <Card key={pool.id}>
            <details open>
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                <ChevronRight className="size-4 transition-transform open:rotate-90" />
                <Database className="size-4 text-brand" />
                <span className="font-medium">{pool.name}</span>
                <Badge variant="outline">{pool.providerKey}</Badge>
                <span className="text-xs text-text-muted">
                  {instancesByPool.get(pool.id)?.length ?? 0} {t("instances")}
                </span>
                {/* 池级动作按钮放在 <summary> 内：点击必须阻止 details 折叠，否则每次操作都会收起列表。 */}
                <span className="ml-auto flex gap-1" onClick={(event) => event.preventDefault()}>
                  <Button size="sm" variant="outline" onClick={() => onPoolDetail(pool)}>
                    {t("detail")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onCreatePool(pool)}>
                    {t("copy")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onPoolRebuild(pool.id)}>
                    {t("rebuildAction")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                    onClick={() => onPoolDelete(pool)}
                  >
                    {t("delete")}
                  </Button>
                </span>
              </summary>
              <div className="overflow-x-auto border-t border-border px-4 py-2">
                <div className="min-w-[850px]">
                  {(instancesByPool.get(pool.id) ?? []).map((instance) => (
                    <InstanceRow
                      key={instance.id}
                      instance={instance}
                      onDetail={() => onInstanceDetail(instance)}
                      onProviderPayload={() => onProviderPayload(instance)}
                      onDelete={() => onInstanceDelete(instance)}
                      onRebuild={() => onInstanceRebuild(pool.id, instance.id)}
                    />
                  ))}
                </div>
              </div>
            </details>
          </Card>
        ))
      )}
    </div>
  );
}
