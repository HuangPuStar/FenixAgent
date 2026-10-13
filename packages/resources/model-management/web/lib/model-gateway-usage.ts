import { ApiError } from "@fenix/web-runtime/api/request";

/** 模型网关日汇总接口使用的首尾包含 UTC 日期范围。 */
export interface ModelGatewayUsageDateRange {
  startAt: string;
  endAt: string;
}

/**
 * 用量请求失败的呈现分支。
 *
 * `UNAUTHORIZED` 是 `request` 层对 401/403 的归一码（见 `@fenix/web-runtime/api/request` 的
 * `statusToCode` 与 `normalizeErrorCode`）：401（会话失效）与 403（Provider 不可见，由
 * `/web/model-gateway/:providerId/usage` 显式返回）都归到它。对当前用户而言「这份用量看不到」是终态，
 * 重试按钮只会反复失败，因此单独成支；其余失败（网络、5xx、上游/网关类 400）都可能自愈，要留重试入口。
 * `null` 表示当前没有失败。
 *
 * 判定放在这里而不是组件内，是为了让「哪种失败给不给重试」成为可单测的规则，而不是散在 JSX 里的三元。
 */
export function classifyUsageFailure(error: unknown): "forbidden" | "error" | null {
  if (!error) return null;
  return error instanceof ApiError && error.code === "UNAUTHORIZED" ? "forbidden" : "error";
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
