import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { ArrowLeft, Gauge } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { queryMyModelGatewayUsage } from "../../../api/model-gateway";
import { buildRecentUsageDateRange } from "../../../lib/model-gateway-usage";

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

/** 从指定模型 Gateway Provider 卡片进入的当前用户用量总览。 */
export function ModelGatewayUsagePage({ providerId }: { providerId: string }) {
  const { t } = useTranslation("models");
  const navigate = useNavigate();
  const overviewRequest = useRequest(async () => {
    return queryMyModelGatewayUsage(providerId, buildRecentUsageDateRange(30));
  });
  const data = overviewRequest.data;
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
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <button
        type="button"
        onClick={() => void navigate({ to: "/agent/models" })}
        className="mb-5 inline-flex h-10 items-center gap-1.5 rounded-lg border border-[#dce5ef] bg-white px-4 text-sm font-semibold text-[#24344d] shadow-sm hover:bg-[#f8fafc]"
      >
        <ArrowLeft className="size-4" />
        {t("gateway.backToModels")}
      </button>
      <h1 className="text-[30px] font-bold tracking-tight">
        {data?.gatewayProvider
          ? t("gateway.usageTitle", { providerName: data.gatewayProvider.displayName })
          : t("gateway.usageTitleLoading")}
      </h1>
      <p className="mt-2 text-lg text-[#71839d]">{t("gateway.usageSubtitle")}</p>
      <div className="mt-8 rounded-2xl border border-[#cbdcff] bg-[#f4f7ff] px-6 py-5 text-[#426193]">
        <div className="flex gap-3">
          <Gauge className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-semibold">{t("gateway.sharedBudgetTitle")}</p>
            <p className="mt-1 text-sm leading-6">{t("gateway.sharedBudgetDescription")}</p>
          </div>
        </div>
      </div>
      {overviewRequest.loading ? (
        <div className="mt-6 text-sm text-text-muted">{t("gateway.loading")}</div>
      ) : overviewRequest.error ? (
        <div className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {t("gateway.loadError")}
        </div>
      ) : (
        <div className="mt-6 grid gap-6 xl:grid-cols-[2fr_0.92fr]">
          <Card className="border-[#e1e7f0] shadow-sm">
            <CardContent className="p-7">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-[#71839d]">{t("gateway.budgetUsage")}</p>
                  {budget ? (
                    <p className="mt-7 text-4xl font-bold tracking-tight">
                      ${budget.spendUsd.toFixed(2)}
                      <span className="ml-2 text-xl font-semibold text-[#71839d]">
                        /{budget.maxBudgetUsd === null ? t("gateway.unlimited") : `$${budget.maxBudgetUsd.toFixed(2)}`}
                      </span>
                    </p>
                  ) : (
                    <p className="mt-7 text-2xl font-semibold text-[#71839d]">{t("gateway.budgetNotSet")}</p>
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
                <div className="mt-7 h-3 overflow-hidden rounded-full bg-[#edf1f7]">
                  <div
                    className={
                      exhausted
                        ? "h-full rounded-full bg-gradient-to-r from-[#ef4444] to-[#dc2626]"
                        : "h-full rounded-full bg-gradient-to-r from-[#4b7df3] to-[#7565e8]"
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
          <div className="rounded-xl border border-[#cbdcff] bg-[#f4f7ff] px-5 py-4 text-sm text-[#426193] xl:col-span-2">
            {t("gateway.last30DaysNotice")}
          </div>
          <Card className="border-[#e1e7f0] shadow-sm">
            <CardContent className="p-7">
              <p className="text-sm font-medium text-[#71839d]">{t("gateway.tokensAndRequests")}</p>
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
      <p className="text-xl font-bold text-[#14213d]">{value}</p>
      <p className="mt-1 text-sm text-[#71839d]">{label}</p>
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
  const { t } = useTranslation("models");
  const maxSpend = Math.max(...items.map((item) => item.spendUsd), 0);
  return (
    <Card className="border-[#e1e7f0] shadow-sm">
      <CardHeader className="border-b border-[#e8edf4] px-7 py-5">
        <CardTitle className="text-xl">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 p-7">
        {items.length === 0 ? (
          <p className="text-sm text-[#71839d]">{t("gateway.noData")}</p>
        ) : (
          items.map((item) => (
            <div className="flex items-center gap-4" key={item.name ?? item.modelId}>
              <div className="w-96 truncate font-medium">{item.name ?? item.modelId}</div>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-[#edf1f7]">
                <div
                  className="h-full rounded-full bg-[#5c7ff0]"
                  style={{ width: `${maxSpend ? (item.spendUsd / maxSpend) * 100 : 0}%` }}
                />
              </div>
              <div className="w-24 text-right">
                <p className="font-semibold">${item.spendUsd.toFixed(2)}</p>
                <p className="text-xs text-[#71839d]">
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
