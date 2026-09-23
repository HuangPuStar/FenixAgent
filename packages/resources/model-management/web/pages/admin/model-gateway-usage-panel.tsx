/**
 * 模型网关管理页的「用量」Tab：范围与四路筛选、指标卡、四个分组明细（组织 / 模型 / 用户 / Agent）。
 *
 * §4.7 拆分（2026-09-23）：整块从 `AdminModelGatewayPage.tsx` 里移出，只做渲染——范围、筛选与请求由
 * `useModelGatewayUsage` 持有（回见该文件对「为什么是 hook 而不是面板内 state」的说明）。三路下拉的取数、
 * 标签与「先取消旧请求再记关键词」的策略在页面侧统一处理，这里只收成品选项与回调。
 *
 * 本 Tab 的页内组件 `UsageBreakdown`（一条名字 + 进度条 + 金额）只有本文件在用，故留在本文件；
 * 指标卡 `Metric` 与两个格式化函数则由概览 Tab 共用，分别落在 `model-gateway-shared.tsx` 与
 * `web/lib/model-gateway-format.ts`。
 */
import { SearchableUsageFilter } from "@fenix/resource-sandbox/web";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent } from "@fenix/ui-components/ui/card";
import { Progress } from "@fenix/ui-components/ui/progress";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ModelSyncStatus } from "../../api/model-gateway";
import { MODELS_NS } from "../../i18n/namespace";
import { formatCompactNumber, formatUsd } from "../../lib/model-gateway-format";
import { FILTER_FIELD_CLASS, Metric } from "./model-gateway-shared";
import type { ModelGatewayFilterOption } from "./use-model-gateway-dashboard";
import type { ModelGatewayUsageController } from "./use-model-gateway-usage";

export function ModelGatewayUsagePanel({
  usage,
  models,
  organizationOptions,
  userOptions,
  agentOptions,
  onUserSearchChange,
  onAgentSearchChange,
}: {
  /** 本 Tab 的状态与请求：由 `useModelGatewayUsage` 在页面侧调用后整包传入。 */
  usage: ModelGatewayUsageController;
  /** 模型筛选的下拉项取自当前模型目录（`status.models`），不另发请求。 */
  models: ModelSyncStatus["models"];
  organizationOptions: ModelGatewayFilterOption[];
  userOptions: ModelGatewayFilterOption[];
  agentOptions: ModelGatewayFilterOption[];
  onUserSearchChange: (keyword: string) => void;
  onAgentSearchChange: (keyword: string) => void;
}) {
  const { i18n, t } = useTranslation(MODELS_NS);
  // 解构一次，下面整段 JSX 与拆分前逐字一致（只把三路下拉的选项与搜索回调换成上面传进来的）。
  const {
    usageRange,
    setUsageRange,
    customStart,
    setCustomStart,
    customEnd,
    setCustomEnd,
    usageFilters,
    setUsageFilters,
    usageRequest,
  } = usage;

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="grid flex-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <select
              className={FILTER_FIELD_CLASS}
              value={usageRange}
              onChange={(event) => setUsageRange(event.target.value)}
            >
              <option value="30d">{t("modelGateway.usagePage.ranges.last30d")}</option>
              <option value="7d">{t("modelGateway.usagePage.ranges.last7d")}</option>
              <option value="custom">{t("modelGateway.usagePage.ranges.custom")}</option>
            </select>
            {usageRange === "custom" && (
              <>
                <input
                  className={FILTER_FIELD_CLASS}
                  type="date"
                  value={customStart}
                  onChange={(event) => setCustomStart(event.target.value)}
                />
                <input
                  className={FILTER_FIELD_CLASS}
                  type="date"
                  value={customEnd}
                  onChange={(event) => setCustomEnd(event.target.value)}
                />
              </>
            )}
            {(
              [
                ["organizationId", "organization"],
                ["userId", "user"],
                ["agentConfigId", "agent"],
                ["modelId", "model"],
              ] as const
            ).map(([key, subject]) => {
              const allLabel = t("modelGateway.usagePage.allSubjects", {
                subject: t(`modelGateway.usagePage.filters.${subject}`),
              });
              if (key !== "modelId") {
                const options =
                  key === "organizationId" ? organizationOptions : key === "userId" ? userOptions : agentOptions;
                return (
                  <SearchableUsageFilter
                    key={key}
                    allLabel={allLabel}
                    emptyLabel={t("modelGateway.usagePage.noMatches")}
                    options={options}
                    searchPlaceholder={t("modelGateway.usagePage.searchSubject", {
                      subject: t(`modelGateway.usagePage.filters.${subject}`),
                    })}
                    value={usageFilters[key]}
                    onSearchChange={
                      key === "userId" ? onUserSearchChange : key === "agentConfigId" ? onAgentSearchChange : undefined
                    }
                    onValueChange={(value) => setUsageFilters((current) => ({ ...current, [key]: value }))}
                  />
                );
              }
              return (
                <select
                  key={key}
                  className={FILTER_FIELD_CLASS}
                  value={usageFilters[key]}
                  onChange={(event) => setUsageFilters((current) => ({ ...current, [key]: event.target.value }))}
                >
                  <option value="">{allLabel}</option>
                  {(models ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName ?? item.id}
                    </option>
                  ))}
                </select>
              );
            })}
          </div>
          <Button
            size="sm"
            onClick={() => usageRequest.run()}
            disabled={usageRequest.loading || (usageRange === "custom" && (!customStart || !customEnd))}
          >
            <Search className={usageRequest.loading ? "size-3.5 animate-spin" : "size-3.5"} />
            {usageRequest.loading ? t("modelGateway.usagePage.querying") : t("modelGateway.query")}
          </Button>
        </div>
        <p className="mb-4 rounded-md border bg-muted/20 px-3 py-2 text-sm text-text-muted">
          {t("modelGateway.usagePage.rangeHint")}
        </p>
        {!usageRequest.data && <p className="text-sm text-text-muted">{t("modelGateway.queryHint")}</p>}
        {usageRequest.data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric
                label={t("modelGateway.usagePage.metrics.spend")}
                value={formatUsd(usageRequest.data.totalSpendUsd, i18n.language)}
                foot={t("modelGateway.usagePage.metrics.gatewayOnly")}
              />
              <Metric
                label={t("modelGateway.usagePage.metrics.tokens")}
                value={formatCompactNumber(
                  usageRequest.data.records.reduce(
                    (total, record) => total + record.promptTokens + record.completionTokens,
                    0,
                  ),
                  i18n.language,
                )}
                foot={t("modelGateway.usagePage.metrics.tokenDetail", {
                  prompt: formatCompactNumber(
                    usageRequest.data.records.reduce((total, record) => total + record.promptTokens, 0),
                    i18n.language,
                  ),
                  completion: formatCompactNumber(
                    usageRequest.data.records.reduce((total, record) => total + record.completionTokens, 0),
                    i18n.language,
                  ),
                })}
              />
              <Metric
                label={t("modelGateway.usagePage.metrics.requests")}
                value={new Intl.NumberFormat(i18n.language).format(
                  usageRequest.data.records.reduce((total, record) => total + record.requests, 0),
                )}
              />
              <Metric
                label={t("modelGateway.usagePage.metrics.activeAgents")}
                value={(usageRequest.data.byAgent ?? []).length}
                foot={t("modelGateway.usagePage.metrics.coveredUsers", {
                  count: usageRequest.data.activeUserCount,
                })}
              />
            </div>
            <div className="mt-4 space-y-4 text-sm">
              <UsageBreakdown
                title={t("modelGateway.usagePage.breakdowns.organization")}
                items={(usageRequest.data.byOrganization ?? []).map((item) => [
                  item.organizationName ? `${item.organizationName}（${item.organizationId}）` : item.organizationId,
                  item.spendUsd,
                ])}
              />
              <UsageBreakdown
                title={t("modelGateway.usagePage.breakdowns.model")}
                items={(usageRequest.data.byModel ?? []).map((item) => [item.modelId, item.spendUsd])}
              />
              <UsageBreakdown
                title={t("modelGateway.usagePage.breakdowns.user")}
                items={(usageRequest.data.byUser ?? []).map((item) => [
                  item.userName && item.userEmail
                    ? t("modelGateway.usagePage.userOption", {
                        name: item.userName,
                        email: item.userEmail,
                      })
                    : (item.userName ?? item.userEmail ?? item.userId),
                  item.spendUsd,
                ])}
              />
              <UsageBreakdown
                title={t("modelGateway.usagePage.breakdowns.agent")}
                items={(usageRequest.data.byAgent ?? []).map((item) => [
                  item.organizationName && item.agentName
                    ? `${item.organizationName} / ${item.agentName}`
                    : (item.agentName ?? item.agentConfigId),
                  item.spendUsd,
                ])}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** 一条分组明细：名字 + 相对最高值的进度条 + 金额。只有本 Tab 在用，故不上升为共享件。 */
function UsageBreakdown({ title, items }: { title: string; items: Array<[string, number]> }) {
  const { t } = useTranslation(MODELS_NS);
  const maxSpend = Math.max(...items.map(([, spend]) => spend), 0);
  return (
    <div className="rounded-md border p-3">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="font-medium">{title}</p>
        <span className="text-xs text-text-muted">USD</span>
      </div>
      {items.length === 0 ? (
        <p className="text-text-muted">{t("modelGateway.usagePage.noData")}</p>
      ) : (
        <div className="space-y-4">
          {items.map(([name, spend]) => (
            <div className="model-gateway-usage-row grid items-center gap-4" key={name}>
              <span className="truncate font-medium" title={name}>
                {name}
              </span>
              <Progress
                className="h-2 bg-muted [&>[data-slot=progress-indicator]]:bg-gradient-to-r [&>[data-slot=progress-indicator]]:from-blue-500 [&>[data-slot=progress-indicator]]:to-indigo-500"
                value={maxSpend > 0 ? (spend / maxSpend) * 100 : 0}
              />
              <span className="min-w-20 text-right tabular-nums text-text-muted">${spend.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
