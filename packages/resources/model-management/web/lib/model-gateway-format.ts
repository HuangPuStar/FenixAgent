/**
 * 模型网关页面的两个数字呈现：金额（USD）与紧凑计数（token / 请求数）。
 *
 * 拆出来的理由：它们是**纯函数**（`Intl` 的薄封装，无状态、无 DOM），原先私有在
 * `pages/admin/AdminModelGatewayPage.tsx` 的末尾，按 §4.7 该文件按职责拆开后，消费方跨两个面板
 * ——概览面板（近七天花费、趋势图 tooltip）与用量面板（四张指标卡）——留在任一组件里都会让另一侧反向导入。
 * 落 `web/lib` 与 `lib/model-gateway-usage.ts` 相邻：都是本包模型网关域的纯逻辑（§5.5）。
 *
 * `locale` 由调用方给（各面板取 `i18n.language`）：本模块不持有 i18n 上下文，便于单独断言。
 */

/** 金额呈现：按 locale 的货币格式渲染 USD。 */
export function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
  }).format(value);
}

/** 紧凑计数呈现：`1.2万` / `12K` 这类缩写，保留一位小数。 */
export function formatCompactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
