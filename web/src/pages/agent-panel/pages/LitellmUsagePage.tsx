import { useRequest } from "ahooks";
import { ChartBarBig, Coins, Hash, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { type DailySummary, providerApi, type UsageReport } from "@/src/api/providers";
import { unwrap } from "@/src/api/request";
import { NS } from "../../../i18n";
import { AgentPageHeader } from "../shared/AgentPageHeader";

/** 格式化 USD 金额 */
function fmtUSD(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** 格式化大数字 (加千分位) */
function fmtNum(value: number): string {
  return value.toLocaleString();
}

/** 紧凑数字格式（如 952.2M） */
function fmtCompact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toLocaleString();
}

/** 模型用量聚合条目（用于表格） */
interface ModelUsageRow {
  model: string;
  spend: number;
  requests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
}

/** 从 UsageReport 构建模型用量表格 */
function buildModelUsageTable(entries: UsageReport["entries"]): ModelUsageRow[] {
  const map = new Map<string, ModelUsageRow>();
  for (const e of entries) {
    const existing = map.get(e.model);
    if (existing) {
      existing.spend += e.spend;
      existing.requests += e.apiRequests;
      existing.totalTokens += e.totalTokens;
      existing.promptTokens += e.promptTokens;
      existing.completionTokens += e.completionTokens;
    } else {
      map.set(e.model, {
        model: e.model,
        spend: e.spend,
        requests: e.apiRequests,
        totalTokens: e.totalTokens,
        promptTokens: e.promptTokens,
        completionTokens: e.completionTokens,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.spend - a.spend);
}

/** Agent 用量聚合条目 */
interface AgentUsageRow {
  agentName: string;
  spend: number;
  requests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** 该 agent 下各模型的用量 */
  models: ModelUsageRow[];
}

/** 从 UsageReport 构建 agent 级用量表格（按 agentName 聚合） */
function buildAgentUsageTable(entries: UsageReport["entries"]): AgentUsageRow[] {
  const map = new Map<string, AgentUsageRow>();
  for (const e of entries) {
    const existing = map.get(e.agentName);
    if (existing) {
      existing.spend += e.spend;
      existing.requests += e.apiRequests;
      existing.totalTokens += e.totalTokens;
      existing.promptTokens += e.promptTokens;
      existing.completionTokens += e.completionTokens;
      // 合并模型级明细
      const modelExisting = existing.models.find((m) => m.model === e.model);
      if (modelExisting) {
        modelExisting.spend += e.spend;
        modelExisting.requests += e.apiRequests;
        modelExisting.totalTokens += e.totalTokens;
        modelExisting.promptTokens += e.promptTokens;
        modelExisting.completionTokens += e.completionTokens;
      } else {
        existing.models.push({
          model: e.model,
          spend: e.spend,
          requests: e.apiRequests,
          totalTokens: e.totalTokens,
          promptTokens: e.promptTokens,
          completionTokens: e.completionTokens,
        });
      }
    } else {
      map.set(e.agentName, {
        agentName: e.agentName,
        spend: e.spend,
        requests: e.apiRequests,
        totalTokens: e.totalTokens,
        promptTokens: e.promptTokens,
        completionTokens: e.completionTokens,
        models: [
          {
            model: e.model,
            spend: e.spend,
            requests: e.apiRequests,
            totalTokens: e.totalTokens,
            promptTokens: e.promptTokens,
            completionTokens: e.completionTokens,
          },
        ],
      });
    }
  }
  return [...map.values()].sort((a, b) => b.spend - a.spend);
}

/** 日期格式化为 M-D 短格式 */
function shortDate(d: string): string {
  const parts = d.split("-");
  if (parts.length >= 3) return `${Number.parseInt(parts[1])}-${Number.parseInt(parts[2])}`;
  return d;
}

export function LitellmUsagePage() {
  const { t } = useTranslation("models");
  const { t: tCommon } = useTranslation(NS.COMMON);
  const [days, setDays] = useState(7);

  const {
    data: report,
    loading,
    run: refresh,
  } = useRequest(
    async () => {
      const data = await unwrap(providerApi.getLitellmUsage(days));
      return data as UsageReport;
    },
    {
      refreshDeps: [days],
      onError: (err) => {
        toast.error(t("usage.loadError", { message: err instanceof Error ? err.message : String(err) }));
      },
    },
  );

  const modelUsage = useMemo(() => (report ? buildModelUsageTable(report.entries) : []), [report]);
  const agentUsage = useMemo(() => (report ? buildAgentUsageTable(report.entries) : []), [report]);

  const avgTokensPerReq =
    report && report.totalRequests > 0 ? Math.round(report.totalTokens / report.totalRequests) : 0;
  const avgSpendPerReq = report && report.totalRequests > 0 ? report.totalSpend / report.totalRequests : 0;

  // 图表用的归一化日期数组
  const chartDaily = (report?.dailySummary ?? []) as DailySummary[];
  const allDates = chartDaily.map((d) => shortDate(d.date));

  // 共用图表的 tooltip 格式化函数
  const chartTooltipStyle = {
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    background: "var(--surface)",
    boxShadow: "var(--shadow-md)",
    fontSize: "12px",
    lineHeight: "1.4",
  };

  return (
    <div className="flex flex-col flex-1 overflow-auto p-5">
      <AgentPageHeader title={t("usage.title")} subtitle={t("usage.subtitle")} />

      {/* 周期选择 */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs text-text-muted">{t("usage.period")}:</span>
        {[7, 14, 30].map((d) => (
          <Button
            key={d}
            size="xs"
            variant={days === d ? "default" : "outline"}
            onClick={() => setDays(d)}
            disabled={loading}
          >
            {d} {t("usage.days")}
          </Button>
        ))}
        <Button size="xs" variant="ghost" onClick={() => refresh()} disabled={loading}>
          {loading ? tCommon("loading") : tCommon("refresh")}
        </Button>
      </div>

      {loading && <UsageSkeleton />}

      {!loading && !report && (
        <div className="flex flex-1 items-center justify-center text-sm text-text-muted">{t("usage.empty")}</div>
      )}

      {!loading && report && (
        <>
          {/* ── 汇总卡片 ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <SummaryCard
              icon={<Hash className="w-4 h-4" />}
              label={t("usage.totalRequests")}
              value={fmtNum(report.totalRequests)}
            />
            <SummaryCard
              icon={<Zap className="w-4 h-4" />}
              label={t("usage.totalTokens")}
              value={fmtCompact(report.totalTokens)}
              subtitle={avgTokensPerReq > 0 ? `${fmtNum(avgTokensPerReq)} avg per request` : undefined}
            />
            <SummaryCard
              icon={<Coins className="w-4 h-4" />}
              label={t("usage.totalSpend")}
              value={fmtUSD(report.totalSpend)}
              subtitle={avgSpendPerReq > 0 ? `${fmtUSD(avgSpendPerReq)} per request` : undefined}
            />
            <SummaryCard
              icon={<ChartBarBig className="w-4 h-4" />}
              label={t("usage.period")}
              value={`${report.periodDays} ${t("usage.days")}`}
            />
          </div>

          {/* ── Agent 用量表格 ── */}
          {agentUsage.length > 0 && (
            <div className="mb-5">
              <h2 className="text-base font-semibold text-text-bright mb-3">{t("usage.agentUsage")}</h2>
              <div className="overflow-x-auto rounded-lg border border-border-light">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-2 text-text-muted">
                      <th className="text-left px-3 py-2 font-medium">{t("usage.colAgent")}</th>
                      <th className="text-right px-3 py-2 font-medium">{t("usage.colCost")}</th>
                      <th className="text-right px-3 py-2 font-medium">{t("usage.colRequests")}</th>
                      <th className="text-right px-3 py-2 font-medium">{t("usage.colTokens")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentUsage.map((row) => (
                      <tr key={row.agentName} className="border-t border-border-light hover:bg-surface-hover">
                        <td className="px-3 py-2 font-medium text-text-bright">{row.agentName}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtUSD(row.spend)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.requests)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(row.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── 模型用量表格 ── */}
          {modelUsage.length > 0 && (
            <div className="mb-5">
              <h2 className="text-base font-semibold text-text-bright mb-3">{t("usage.modelUsage")}</h2>
              <div className="overflow-x-auto rounded-lg border border-border-light">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-2 text-text-muted">
                      <th className="text-left px-3 py-2 font-medium">{t("usage.colModel")}</th>
                      <th className="text-right px-3 py-2 font-medium">{t("usage.colCost")}</th>
                      <th className="text-right px-3 py-2 font-medium">{t("usage.colRequests")}</th>
                      <th className="text-right px-3 py-2 font-medium">{t("usage.colTokens")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelUsage.map((row) => (
                      <tr key={row.model} className="border-t border-border-light hover:bg-surface-hover">
                        <td className="px-3 py-2 font-medium text-text-bright">{row.model}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtUSD(row.spend)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.requests)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(row.totalTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── 图表区域 ── */}
          {chartDaily.length > 0 && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mb-5">
              {/* Spend per day */}
              <ChartCard title={t("usage.chartSpendPerDay")}>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartDaily} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorSpend" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--brand)" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="var(--brand)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={shortDate}
                      tick={{ fontSize: 11 }}
                      stroke="var(--text-muted)"
                    />
                    <YAxis
                      tickFormatter={(v: number) => fmtUSD(v)}
                      tick={{ fontSize: 11 }}
                      stroke="var(--text-muted)"
                      width={60}
                    />
                    <Tooltip
                      contentStyle={chartTooltipStyle}
                      formatter={((value: number) => [fmtUSD(value), t("usage.totalSpend")]) as any}
                      labelFormatter={shortDate as any}
                    />
                    <Area
                      type="monotone"
                      dataKey="spend"
                      stroke="var(--brand)"
                      fill="url(#colorSpend)"
                      strokeWidth={2}
                      name={t("usage.totalSpend")}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>

              {/* Tokens per day */}
              <ChartCard title={t("usage.chartTokensPerDay")}>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartDaily} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={shortDate}
                      tick={{ fontSize: 11 }}
                      stroke="var(--text-muted)"
                    />
                    <YAxis
                      tickFormatter={(v: number) => fmtCompact(v)}
                      tick={{ fontSize: 11 }}
                      stroke="var(--text-muted)"
                      width={60}
                    />
                    <Tooltip
                      contentStyle={chartTooltipStyle}
                      formatter={((value: number, name: string) => [fmtCompact(value), name]) as any}
                      labelFormatter={shortDate as any}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Area
                      type="monotone"
                      dataKey="totalTokens"
                      stroke="#3b82f6"
                      fill="#3b82f620"
                      strokeWidth={2}
                      name={t("usage.totalTokens")}
                    />
                    <Area
                      type="monotone"
                      dataKey="promptTokens"
                      stroke="#f59e0b"
                      fill="#f59e0b20"
                      strokeWidth={2}
                      name={t("usage.promptTokens")}
                    />
                    <Area
                      type="monotone"
                      dataKey="completionTokens"
                      stroke="#10b981"
                      fill="#10b98120"
                      strokeWidth={2}
                      name={t("usage.completionTokens")}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>

              {/* Requests per day */}
              <ChartCard title={t("usage.chartRequestsPerDay")}>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartDaily} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={shortDate}
                      tick={{ fontSize: 11 }}
                      stroke="var(--text-muted)"
                    />
                    <YAxis
                      tickFormatter={(v: number) => fmtCompact(v)}
                      tick={{ fontSize: 11 }}
                      stroke="var(--text-muted)"
                      width={60}
                    />
                    <Tooltip
                      contentStyle={chartTooltipStyle}
                      formatter={((value: number) => [fmtNum(value), t("usage.chartRequestsPerDay")]) as any}
                      labelFormatter={shortDate as any}
                    />
                    <Bar
                      dataKey="apiRequests"
                      fill="var(--brand)"
                      radius={[4, 4, 0, 0]}
                      name={t("usage.chartRequestsPerDay")}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              {/* Cache metrics */}
              <ChartCard title={t("usage.chartCacheMetrics")}>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartDaily} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={shortDate}
                      tick={{ fontSize: 11 }}
                      stroke="var(--text-muted)"
                    />
                    <YAxis
                      tickFormatter={(v: number) => fmtCompact(v)}
                      tick={{ fontSize: 11 }}
                      stroke="var(--text-muted)"
                      width={65}
                    />
                    <Tooltip
                      contentStyle={chartTooltipStyle}
                      formatter={((value: number, name: string) => [fmtCompact(value), name]) as any}
                      labelFormatter={shortDate as any}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Area
                      type="monotone"
                      dataKey="cacheReadInputTokens"
                      stroke="#8b5cf6"
                      fill="#8b5cf620"
                      strokeWidth={2}
                      name={t("usage.cacheReadInputTokens")}
                    />
                    <Area
                      type="monotone"
                      dataKey="cacheCreationInputTokens"
                      stroke="#ec4899"
                      fill="#ec489920"
                      strokeWidth={2}
                      name={t("usage.cacheCreationInputTokens")}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 汇总卡片 */
function SummaryCard({
  icon,
  label,
  value,
  subtitle,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-lg bg-surface-2 border border-border-light">
      <div className="flex items-center gap-1.5 text-xs text-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-lg font-semibold text-text-bright">{value}</div>
      {subtitle && <div className="text-[11px] text-text-muted">{subtitle}</div>}
    </div>
  );
}

/** 图表卡片容器 */
function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-surface-2 border border-border-light p-3">
      <h3 className="text-xs font-medium text-text-muted mb-3">{title}</h3>
      {children}
    </div>
  );
}

/** 加载骨架屏 */
function UsageSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-40 rounded-lg" />
      <div className="grid grid-cols-2 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-56 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
