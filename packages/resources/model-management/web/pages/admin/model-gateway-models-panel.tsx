/**
 * 模型网关管理页的「模型」Tab：LiteLLM 配置入口 + 模型目录表（搜索 / 同步态筛选 / 同步与检查按钮）。
 *
 * §4.7 拆分（2026-09-23）：整块从 `AdminModelGatewayPage.tsx` 里移出，只留渲染职责。搜索词与筛选值
 * **仍由页面持有**（两个 `useState` + 一对 setter 从上面传下来）：拆分前它们与其余四块共用同一个长生命周期的
 * 组件，切走再切回不会丢——把状态搬进本文件会让「离开 Tab 再回来」变成重新开始，属于行为变更。
 * 检查结果、配置与「检查 / 同步」两个动作同样来自页面侧的 `useModelGatewayDashboard`：概览 Tab 也读它们。
 */

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@fenix/ui-components/ui/card";
import { ExternalLink, Info, RefreshCw, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ModelGatewayConfiguration, ModelSyncStatus } from "../../api/model-gateway";
import { MODELS_NS } from "../../i18n/namespace";
import { MODEL_GATEWAY_SYNC_TONES } from "../../lib/model-gateway-status-tones";
import {
  FILTER_FIELD_CLASS,
  GatewayRefreshButton,
  ModelGatewayEmptyRow,
  ModelGatewayTable,
} from "./model-gateway-shared";

export function ModelGatewayModelsPanel({
  status,
  config,
  checking,
  syncing,
  busy,
  modelSearch,
  modelFilter,
  onModelSearchChange,
  onModelFilterChange,
  onCheck,
  onSync,
}: {
  status: ModelSyncStatus | null;
  config: ModelGatewayConfiguration | undefined;
  checking: boolean;
  syncing: boolean;
  busy: boolean;
  modelSearch: string;
  modelFilter: string;
  onModelSearchChange: (keyword: string) => void;
  onModelFilterChange: (filter: string) => void;
  onCheck: () => void;
  onSync: () => void;
}) {
  const { t } = useTranslation(MODELS_NS);

  const displayedModels = useMemo(() => {
    const models = status?.models ?? [];
    return models.filter((model) => {
      const matchesSearch = !modelSearch.trim() || model.id.toLowerCase().includes(modelSearch.trim().toLowerCase());
      const change = status?.changes.find((item) => item.modelId === model.id);
      const matchesFilter = modelFilter === "all" || (modelFilter === "pending" ? Boolean(change) : !change);
      return matchesSearch && matchesFilter;
    });
  }, [modelFilter, modelSearch, status]);

  return (
    <div className="space-y-4">
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="flex flex-wrap items-center gap-4 py-4">
          <Info className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-primary">{t("modelGateway.modelsPage.litellmConfig.title")}</p>
            <p className="mt-1 text-sm text-text-muted">{t("modelGateway.modelsPage.litellmConfig.description")}</p>
          </div>
          {config?.adminUiUrl ? (
            <Button asChild size="sm">
              <a href={config.adminUiUrl} target="_blank" rel="noreferrer">
                {t("modelGateway.modelsPage.litellmConfig.action")}
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          ) : (
            <Button size="sm" disabled>
              {t("modelGateway.modelsPage.litellmConfig.action")}
              <ExternalLink className="size-3.5" />
            </Button>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm">{t("modelGateway.modelsPage.title")}</CardTitle>
            <p className="mt-1 text-xs text-text-muted">{t("modelGateway.modelsPage.description")}</p>
          </div>
          <div className="flex gap-2">
            <GatewayRefreshButton loading={checking} disabled={busy} onClick={onCheck}>
              {t("modelGateway.check")}
            </GatewayRefreshButton>
            <Button
              size="sm"
              onClick={onSync}
              disabled={busy || (status?.status !== "pending" && !status?.providerBaseUrlChanged)}
            >
              <RefreshCw className={syncing ? "size-3.5 animate-spin" : "size-3.5"} />
              {t("modelGateway.sync")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap gap-2">
            <input
              className="h-8 min-w-56 rounded-md border bg-background px-2 text-sm"
              placeholder={t("modelGateway.modelsPage.searchPlaceholder")}
              value={modelSearch}
              onChange={(event) => onModelSearchChange(event.target.value)}
            />
            <select
              className={FILTER_FIELD_CLASS}
              value={modelFilter}
              onChange={(event) => onModelFilterChange(event.target.value)}
            >
              <option value="all">{t("modelGateway.modelsPage.filters.all")}</option>
              <option value="pending">{t("modelGateway.modelsPage.filters.pending")}</option>
              <option value="synced">{t("modelGateway.modelsPage.filters.synced")}</option>
            </select>
          </div>
          {!status ? (
            <EmptyState title={t("modelGateway.checkHint")} className="py-8" />
          ) : status.status === "unknown" ? (
            <EmptyState
              tone="danger"
              role="alert"
              icon={<TriangleAlert />}
              title={status.error ?? t("modelGateway.unknown")}
              className="py-8"
            />
          ) : (
            <ModelGatewayTable
              head={
                <>
                  <th className="px-3 py-2">{t("modelGateway.modelsPage.columns.model")}</th>
                  <th className="px-3 py-2">{t("modelGateway.modelsPage.columns.source")}</th>
                  <th className="px-3 py-2">{t("modelGateway.modelsPage.columns.syncStatus")}</th>
                </>
              }
            >
              {displayedModels.map((model) => {
                const change = status.changes.find((item) => item.modelId === model.id);
                return (
                  <tr key={model.id}>
                    <td className="px-3 py-2 font-medium">{model.displayName ?? model.id}</td>
                    <td className="px-3 py-2 text-text-muted">LiteLLM</td>
                    <td className="px-3 py-2">
                      {change ? (
                        <Badge variant="outline">{t(`modelGateway.change.${change.kind}`)}</Badge>
                      ) : (
                        <StatusBadge
                          status="synced"
                          label={t("modelGateway.synced")}
                          toneMap={MODEL_GATEWAY_SYNC_TONES}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
              {displayedModels.length === 0 && (
                <ModelGatewayEmptyRow colSpan={3} title={t("modelGateway.modelsPage.noMatches")} />
              )}
            </ModelGatewayTable>
          )}
          {status && (status.changes.length > 0 || status.providerBaseUrlChanged) && (
            <p className="mt-3 text-sm text-amber-700">
              {status.providerBaseUrlChanged
                ? t("modelGateway.modelsPage.providerBaseUrlChanged")
                : t("modelGateway.modelsPage.catalogChanges", {
                    count: status.changes.length,
                  })}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
