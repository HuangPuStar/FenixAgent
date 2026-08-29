/** 模型网关日汇总接口使用的首尾包含 UTC 日期范围。 */
export interface ModelGatewayUsageDateRange {
  startAt: string;
  endAt: string;
}

/** 将当前时间锚定为用量统计使用的 UTC 自然日。 */
export function toUsageDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** 构造首尾均包含的最近 N 个 UTC 自然日查询范围。 */
export function buildRecentUsageDateRange(days: number, now = new Date()): ModelGatewayUsageDateRange {
  const endDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    startAt: new Date(endDay - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    endAt: toUsageDate(now),
  };
}
