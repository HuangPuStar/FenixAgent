import { buildRecentUsageDateRange } from "../../lib/model-gateway-usage";

export interface ModelGatewayUsageQueryInput {
  startAt: string;
  endAt: string;
}

export interface ModelGatewayDailyUsageRecord {
  date: string;
  spendUsd: number;
  requests: number;
}

/** 构造概览固定使用的近七天网关用量查询，避免首页自动读取过长时间范围。 */
export function buildModelGatewayOverviewUsageQuery(now = new Date()): ModelGatewayUsageQueryInput {
  return buildRecentUsageDateRange(7, now);
}

/** 将仅返回有调用日期的统计结果补齐为完整近七天时间轴。 */
export function buildSevenDayUsageTrend(
  records: ModelGatewayDailyUsageRecord[],
  endAt = new Date(),
): Array<[string, { spend: number; requests: number }]> {
  const daily = new Map<string, { spend: number; requests: number }>();
  for (const record of records) {
    const current = daily.get(record.date) ?? { spend: 0, requests: 0 };
    current.spend += record.spendUsd;
    current.requests += record.requests;
    daily.set(record.date, current);
  }

  const endDay = Date.UTC(endAt.getUTCFullYear(), endAt.getUTCMonth(), endAt.getUTCDate());
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(endDay - (6 - index) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return [date, daily.get(date) ?? { spend: 0, requests: 0 }];
  });
}
