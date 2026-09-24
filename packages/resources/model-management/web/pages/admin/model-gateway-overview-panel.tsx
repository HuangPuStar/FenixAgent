/**
 * 模型网关管理页的「概览」Tab：三张指标卡 + 网关连接状态与近七天花费趋势。
 *
 * §4.7 拆分（2026-09-23）：整块从 `AdminModelGatewayPage.tsx` 移出，**props 与拆分前逐字一致**——
 * 它一直是纯展示件（状态、配置、用量、加载与错误都由调用方给），只是原先与另外四个 Tab 的 JSX 同处一文件，
 * 改一处趋势图要翻过整页的密钥表、预算表与用量筛选条。
 *
 * `OverviewUsage` 是本面板自己声明的**结构化子集**（只要展示用得上的字段），不反向依赖域模块的完整响应类型：
 * 这正是它此前能接收 `GatewayUsage` 的原因，也是它与用量 Tab 的区别（后者直接用完整响应）。
 */
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@fenix/ui-components/ui/card";
import { ChartContainer } from "@fenix/ui-components/ui/chart";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import type { ModelGatewayConfiguration, ModelSyncStatus } from "../../api/model-gateway";
import { MODELS_NS } from "../../i18n/namespace";
import { formatCompactNumber, formatUsd } from "../../lib/model-gateway-format";
import { MODEL_GATEWAY_SYNC_TONES } from "../../lib/model-gateway-status-tones";
import { buildSevenDayUsageTrend } from "./model-gateway-overview";
import { GatewayRefreshButton, Metric } from "./model-gateway-shared";

type OverviewUsage = {
  totalSpendUsd: number;
  records: Array<{
    date: string;
    spendUsd: number;
    requests: number;
    promptTokens: number;
    completionTokens: number;
  }>;
  activeUserCount: number;
};

export function OverviewPanel({
  status,
  config,
  usage,
  loading,
  error,
  onRefresh,
  onModels,
}: {
  status: ModelSyncStatus | null;
  config: ModelGatewayConfiguration | undefined;
  usage: OverviewUsage | undefined;
  loading: boolean;
  error: Error | undefined;
  onRefresh: () => void;
  onModels: () => void;
}) {
  const { i18n, t } = useTranslation(MODELS_NS);
  const trend = useMemo(() => buildSevenDayUsageTrend(usage?.records ?? []), [usage?.records]);
  const trendData = useMemo(() => trend.map(([date, value]) => ({ date, spend: value.spend })), [trend]);
  const provider = config?.provider;
  const statusLabel =
    status?.status === "synced"
      ? t("modelGateway.overview.connected")
      : status?.status === "pending"
        ? t("modelGateway.pending")
        : t("modelGateway.overview.notChecked");
  const totalPromptTokens = (usage?.records ?? []).reduce((total, record) => total + record.promptTokens, 0);
  const totalCompletionTokens = (usage?.records ?? []).reduce((total, record) => total + record.completionTokens, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label={t("modelGateway.overview.recent7dSpend")}
          value={usage ? formatUsd(usage.totalSpendUsd, i18n.language) : loading ? t("admin.loading") : "—"}
          foot={
            usage
              ? t("modelGateway.overview.tokenSummary", {
                  prompt: formatCompactNumber(totalPromptTokens, i18n.language),
                  completion: formatCompactNumber(totalCompletionTokens, i18n.language),
                })
              : t("modelGateway.overview.onlyGateway")
          }
        />
        <Metric
          label={t("modelGateway.overview.activeUsers")}
          value={usage ? usage.activeUserCount : loading ? t("admin.loading") : "—"}
          foot={t("modelGateway.overview.activeUsersFoot7d")}
        />
        <Metric
          label={t("modelGateway.overview.configuredModels")}
          value={provider ? provider.modelCount : loading ? t("admin.loading") : "—"}
          foot={
            status?.status === "synced"
              ? t("modelGateway.overview.modelsSynced")
              : t("modelGateway.overview.modelsPending")
          }
        />
      </div>

      {error && (
        <EmptyState
          tone="danger"
          role="alert"
          icon={<TriangleAlert />}
          // 标题只取字典（§9.3）：原先直接把 `ApiError.message`（后端错误信封原文）当标题
          title={t("modelGateway.overview.loadFailed")}
          className="py-8"
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="text-sm">{t("modelGateway.overview.usageTrend")}</CardTitle>
              <p className="mt-1 text-xs text-text-muted">{t("modelGateway.overview.recent7dGateway")}</p>
            </div>
            <div className="text-xs text-text-muted">{t("modelGateway.overview.amountUsd")}</div>
          </CardHeader>
          <CardContent>
            {!usage ? (
              loading ? (
                <Spinner label={t("admin.loading")} className="flex py-12" />
              ) : (
                <EmptyState title={t("modelGateway.overview.noUsage")} className="py-12" />
              )
            ) : (
              <div className="h-52">
                <ChartContainer>
                  <BarChart data={trendData} margin={{ top: 8, right: 8, left: 0 }}>
                    <CartesianGrid stroke="var(--color-border)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(date: string) => date.slice(5)}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: "var(--color-text-muted)", fontSize: 10 }}
                    />
                    <YAxis
                      width={56}
                      tickFormatter={(value: number) => String(value)}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: "var(--color-text-muted)", fontSize: 10 }}
                    />
                    <Tooltip
                      formatter={(value) => formatUsd(Number(value), i18n.language)}
                      labelFormatter={(date) => String(date)}
                    />
                    <Bar
                      dataKey="spend"
                      fill="var(--color-brand)"
                      name={t("modelGateway.overview.amountUsd")}
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ChartContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="text-sm">{t("modelGateway.overview.gatewayProvider")}</CardTitle>
            </div>
            <StatusBadge
              status={status?.status ?? "unknown"}
              label={statusLabel}
              toneMap={MODEL_GATEWAY_SYNC_TONES}
              indicator="dot"
            />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-md bg-brand text-lg font-semibold text-white">
                G
              </div>
              <div>
                <p className="font-medium">{provider?.displayName ?? t("modelGateway.overview.defaultProviderName")}</p>
                <p className="text-xs text-text-muted">{provider?.name ?? "—"}</p>
              </div>
            </div>
            <dl className="model-gateway-overview-facts mt-4 grid gap-x-4 gap-y-2 text-sm">
              <dt className="text-text-muted">{t("modelGateway.overview.owner")}</dt>
              <dd>{provider ? `${provider.owner.email} / ${provider.owner.organizationSlug}` : "—"}</dd>
              <dt className="text-text-muted">{t("modelGateway.overview.gatewayType")}</dt>
              <dd>
                {provider?.gatewayType === "litellm"
                  ? t("modelGateway.overview.gatewayTypes.litellm")
                  : (provider?.gatewayType ?? "—")}
              </dd>
              <dt className="text-text-muted">{t("modelGateway.overview.connectionAddress")}</dt>
              <dd className="truncate" title={provider?.baseUrl ?? undefined}>
                {provider?.baseUrl ?? "—"}
              </dd>
            </dl>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" size="sm" onClick={onModels}>
                {t("modelGateway.overview.manageModels")}
              </Button>
              <GatewayRefreshButton loading={loading} onClick={onRefresh}>
                {t("modelGateway.overview.refreshStatus")}
              </GatewayRefreshButton>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
