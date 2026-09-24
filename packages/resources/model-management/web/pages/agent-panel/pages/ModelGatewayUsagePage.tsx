import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@fenix/ui-components/ui/card";
import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { ArrowLeft, Gauge, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { modelGatewayApi } from "../../../api/model-gateway";
import { MODELS_NS } from "../../../i18n/namespace";
import { buildRecentUsageDateRange, classifyUsageFailure } from "../../../lib/model-gateway-usage";
import "./ModelGatewayUsagePage.css";

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

/** 从指定模型 Gateway Provider 卡片进入的当前用户用量总览。 */
export function ModelGatewayUsagePage({ providerId }: { providerId: string }) {
  const { t } = useTranslation(MODELS_NS);
  const navigate = useNavigate();
  const overviewRequest = useRequest(async () => {
    return modelGatewayApi.queryMyUsage(providerId, buildRecentUsageDateRange(30));
  });
  const data = overviewRequest.data;
  // 失败态是持久的页面状态（不是一次性 toast）：无权限与可重试失败分成两支，见 classifyUsageFailure。
  const failure = classifyUsageFailure(overviewRequest.error);
  const totals = useMemo(() => {
    return (data?.records ?? []).reduce(
      (current, record) => ({
        requests: current.requests + record.requests,
        promptTokens: current.promptTokens + record.promptTokens,
        completionTokens: current.completionTokens + record.completionTokens,
      }),
      { requests: 0, promptTokens: 0, completionTokens: 0 },
    );
  }, [data]);
  const budget = data?.budget;
  const remaining =
    budget?.maxBudgetUsd === null ? null : Math.max(0, (budget?.maxBudgetUsd ?? 0) - (budget?.spendUsd ?? 0));
  const progress =
    budget?.maxBudgetUsd && budget.maxBudgetUsd > 0 ? Math.min(100, (budget.spendUsd / budget.maxBudgetUsd) * 100) : 0;
  const exhausted = Boolean(budget && budget.maxBudgetUsd !== null && budget.spendUsd >= budget.maxBudgetUsd);
  const agents = [...(data?.byAgent ?? [])]
    .sort((left, right) => right.spendUsd - left.spendUsd)
    .map((item) => ({
      ...item,
      name:
        item.organizationName && item.agentName ? `${item.organizationName} / ${item.agentName}` : item.agentConfigId,
    }));
  const models = [...(data?.byModel ?? [])].sort((left, right) => right.spendUsd - left.spendUsd);

  return (
    <div className="min-h-full overflow-auto bg-slate-100 px-8 py-7 text-slate-800">
      <button
        type="button"
        onClick={() => void navigate({ to: "/agent/models" })}
        className="mb-5 inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
      >
        <ArrowLeft className="size-4" />
        {t("gateway.backToModels")}
      </button>
      <h1 className="text-3xl font-bold tracking-tight">
        {data?.gatewayProvider
          ? t("gateway.usageTitle", { providerName: data.gatewayProvider.displayName })
          : t("gateway.usageTitleLoading")}
      </h1>
      <p className="mt-2 text-lg text-slate-500">{t("gateway.usageSubtitle")}</p>
      <div className="mt-8 rounded-2xl border border-indigo-200 bg-sky-50 px-6 py-5 text-slate-500">
        <div className="flex gap-3">
          <Gauge className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-semibold">{t("gateway.sharedBudgetTitle")}</p>
            <p className="mt-1 text-sm leading-6">{t("gateway.sharedBudgetDescription")}</p>
          </div>
        </div>
      </div>
      {overviewRequest.loading ? (
        <div className="mt-6 text-sm text-text-muted" role="status" aria-busy="true">
          {t("gateway.loading")}
        </div>
      ) : failure === "forbidden" ? (
        // 401/403 是终态：给出原因即可，重试按钮只会让用户反复撞同一堵墙。
        <div
          className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          role="alert"
        >
          {t("gateway.forbidden")}
        </div>
      ) : failure ? (
        <div
          className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          role="alert"
        >
          <span>{t("gateway.loadError")}</span>
          <Button size="sm" variant="outline" onClick={() => void overviewRequest.refresh()}>
            <RefreshCw className="size-4" />
            {t("actions.retry")}
          </Button>
        </div>
      ) : (
        <div className="model-gateway-usage-panels mt-6 grid gap-6">
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-7">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-slate-500">{t("gateway.budgetUsage")}</p>
                  {budget ? (
                    <p className="mt-7 text-4xl font-bold tracking-tight">
                      ${budget.spendUsd.toFixed(2)}
                      <span className="ml-2 text-xl font-semibold text-slate-500">
                        /{budget.maxBudgetUsd === null ? t("gateway.unlimited") : `$${budget.maxBudgetUsd.toFixed(2)}`}
                      </span>
                    </p>
                  ) : (
                    <p className="mt-7 text-2xl font-semibold text-slate-500">{t("gateway.budgetNotSet")}</p>
                  )}
                </div>
                {budget && (
                  <span
                    className={
                      exhausted
                        ? "rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700"
                        : "rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700"
                    }
                  >
                    {exhausted ? t("gateway.budgetExhausted") : t("gateway.budgetNormal")}
                  </span>
                )}
              </div>
              {budget?.maxBudgetUsd !== null && budget && (
                <div className="mt-7 h-3 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={
                      exhausted
                        ? "h-full rounded-full bg-gradient-to-r from-red-500 to-red-500"
                        : "h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500"
                    }
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
              <div className="mt-6 flex flex-wrap gap-x-10 gap-y-4 text-sm">
                <Info
                  label={t("gateway.remaining")}
                  value={remaining === null ? t("gateway.unlimited") : `$${remaining.toFixed(2)}`}
                />
                <Info
                  label={t("gateway.nextReset")}
                  value={budget?.resetAt ? new Date(budget.resetAt).toLocaleString() : t("gateway.neverReset")}
                />
                <Info label={t("gateway.budgetDuration")} value={budget?.duration ?? t("gateway.once")} />
              </div>
            </CardContent>
          </Card>
          <div className="rounded-xl border border-indigo-200 bg-sky-50 px-5 py-4 text-sm text-slate-500 xl:col-span-2">
            {t("gateway.last30DaysNotice")}
          </div>
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-7">
              <p className="text-sm font-medium text-slate-500">{t("gateway.tokensAndRequests")}</p>
              <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-7">
                <Info
                  label={t("gateway.totalTokens")}
                  value={formatTokens(totals.promptTokens + totals.completionTokens)}
                />
                <Info label={t("gateway.requests")} value={totals.requests.toLocaleString()} />
                <Info label={t("gateway.promptTokens")} value={formatTokens(totals.promptTokens)} />
                <Info label={t("gateway.completionTokens")} value={formatTokens(totals.completionTokens)} />
              </div>
            </CardContent>
          </Card>
          <SpendBreakdown title={t("gateway.byAgent")} items={agents} requestSuffix={t("gateway.requestsSuffix")} />
          <SpendBreakdown title={t("gateway.byModel")} items={models} requestSuffix={t("gateway.requestsSuffix")} />
        </div>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xl font-bold text-slate-800">{value}</p>
      <p className="mt-1 text-sm text-slate-500">{label}</p>
    </div>
  );
}

function SpendBreakdown({
  title,
  items,
  requestSuffix,
}: {
  title: string;
  items: Array<{ name?: string; modelId?: string; spendUsd: number; requests: number }>;
  requestSuffix: string;
}) {
  const { t } = useTranslation(MODELS_NS);
  const maxSpend = Math.max(...items.map((item) => item.spendUsd), 0);
  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader className="border-b border-slate-200 px-7 py-5">
        <CardTitle className="text-xl">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 p-7">
        {items.length === 0 ? (
          <p className="text-sm text-slate-500">{t("gateway.noData")}</p>
        ) : (
          items.map((item) => (
            <div className="flex items-center gap-4" key={item.name ?? item.modelId}>
              <div className="w-96 truncate font-medium">{item.name ?? item.modelId}</div>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-indigo-400"
                  style={{ width: `${maxSpend ? (item.spendUsd / maxSpend) * 100 : 0}%` }}
                />
              </div>
              <div className="w-24 text-right">
                <p className="font-semibold">${item.spendUsd.toFixed(2)}</p>
                <p className="text-xs text-slate-500">
                  {item.requests.toLocaleString()} {requestSuffix}
                </p>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
