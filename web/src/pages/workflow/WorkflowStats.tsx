import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyCount, FailedRun, StatsOverview, StatsRange, TokenDaily } from "../../api/workflow-stats";
import { workflowStatsApi } from "../../api/workflow-stats";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-base p-4">
      <div className="text-xs text-text-secondary">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-text-primary">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-text-tertiary">{sub}</div>}
    </div>
  );
}

const RANGES: StatsRange[] = ["7d", "30d", "all"];

export function WorkflowStats() {
  const { t } = useTranslation("workflows");
  const [range, setRange] = useState<StatsRange>("7d");
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  const [trend, setTrend] = useState<DailyCount[]>([]);
  const [tokens, setTokens] = useState<TokenDaily[]>([]);
  const [failedRuns, setFailedRuns] = useState<FailedRun[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, tr, tk, fr] = await Promise.all([
        workflowStatsApi.overview(range),
        workflowStatsApi.trend(range),
        workflowStatsApi.tokens(range),
        workflowStatsApi.failedRuns(),
      ]);
      setOverview(ov);
      setTrend(tr);
      setTokens(tk);
      setFailedRuns(fr);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (loading && !overview) {
    return (
      <div className="flex flex-1 items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-brand" />
        <span className="ml-2 text-sm text-text-secondary">{t("stats_loading")}</span>
      </div>
    );
  }

  const rangeLabel: Record<StatsRange, string> = {
    "7d": t("stats_7d"),
    "30d": t("stats_30d"),
    all: t("stats_all"),
  };

  return (
    <div className="flex flex-col gap-6 p-6 overflow-y-auto flex-1">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text-primary">{t("page.tab_stats")}</h2>
        <div className="flex items-center gap-1 rounded-lg border border-border-subtle p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                range === r
                  ? "bg-brand text-white"
                  : "text-text-secondary hover:text-text-primary hover:bg-surface-secondary"
              }`}
            >
              {rangeLabel[r]}
            </button>
          ))}
        </div>
      </div>

      {/* Metric Cards */}
      {overview && (
        <div className="grid grid-cols-4 gap-4">
          <MetricCard
            label={t("stats_total_runs")}
            value={String(overview.totalRuns)}
            sub={`${overview.successRuns} success / ${overview.failedRuns} failed`}
          />
          <MetricCard label={t("stats_success_rate")} value={`${overview.successRate.toFixed(1)}%`} />
          <MetricCard label={t("stats_avg_duration")} value={formatDuration(overview.avgDurationMs)} />
          <MetricCard
            label={t("stats_total_tokens")}
            value={formatTokens(overview.totalInputTokens + overview.totalOutputTokens)}
            sub={`${t("stats_input")}: ${formatTokens(overview.totalInputTokens)} / ${t("stats_output")}: ${formatTokens(overview.totalOutputTokens)}`}
          />
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-2 gap-4">
        {/* Run Trend */}
        <div className="rounded-lg border border-border-subtle bg-surface-base p-4">
          <h3 className="mb-3 text-sm font-medium text-text-primary">{t("stats_trend_title")}</h3>
          {trend.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle, #e2e8f0)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary, #94a3b8)" />
                <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary, #94a3b8)" />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="success" stroke="#22c55e" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="failed" stroke="#ef4444" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-60 items-center justify-center text-sm text-text-tertiary">{t("stats_no_data")}</div>
          )}
        </div>

        {/* Token Consumption */}
        <div className="rounded-lg border border-border-subtle bg-surface-base p-4">
          <h3 className="mb-3 text-sm font-medium text-text-primary">{t("stats_tokens_title")}</h3>
          {tokens.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={tokens}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle, #e2e8f0)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary, #94a3b8)" />
                <YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-tertiary, #94a3b8)" />
                <Tooltip />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="inputTokens"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="outputTokens"
                  stroke="#8b5cf6"
                  fill="#8b5cf6"
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-60 items-center justify-center text-sm text-text-tertiary">{t("stats_no_data")}</div>
          )}
        </div>
      </div>

      {/* Recent Failures */}
      <div className="rounded-lg border border-border-subtle bg-surface-base p-4">
        <h3 className="mb-3 text-sm font-medium text-text-primary">{t("stats_failed_title")}</h3>
        {failedRuns.length > 0 ? (
          <div className="flex flex-col gap-2">
            {failedRuns.map((run) => (
              <div key={run.runId} className="flex items-center gap-3 rounded-md border border-border-subtle px-3 py-2">
                <AlertTriangle size={14} className="shrink-0 text-red-500" />
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm font-medium text-text-primary">{run.workflowName}</div>
                  <div className="text-xs text-text-tertiary">
                    {run.startedAt}
                    {run.durationMs != null ? ` · ${formatDuration(run.durationMs)}` : ""}
                  </div>
                </div>
                <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">
                  {run.dagStatus}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-tertiary">
            <Inbox size={16} />
            {t("stats_no_data")}
          </div>
        )}
      </div>
    </div>
  );
}
