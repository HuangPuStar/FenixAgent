/**
 * 工单时间的展示格式化：列表表格与详情页共用的**唯一**实现。
 *
 * 后端两个时间字段都是 ISO 字符串（`syncedAt` 必有、`providerUpdatedAt` 可空，见
 * `TicketSummaryViewSchema`），界面按**当前界面语言**渲染：写死格式会让中英文界面显示同一种时间排布，
 * 用户也看不出这是本地时区。语言由调用方从 `useTranslation()` 的 `i18n.language` 传入，本模块不读全局
 * 状态，因此可以在没有 i18n 实例的用例里直接断言。
 *
 * 不可解析的值与 `null` 回退成同一个占位符：两种情况在界面上没有可区分的含义（要么上游没给时间、要么
 * 给了个非法串），拆成两种文案只会让用户去猜它们的差别。
 *
 * 放在 `pages/agent-panel/components/` 而不是 `web/lib/`：`web/lib/**` 是写路径的纯逻辑（幂等键、错误
 * 分类），改它要动到 H1 的产物；本文件只服务这两个视图。
 */

/** 时间缺失或不可解析时的占位符；不是文案，不参与 i18n。 */
export const TICKET_TIME_PLACEHOLDER = "—";

/** 把 ISO 时间串按当前语言渲染成 `dateStyle: medium` + `timeStyle: short`。 */
export function formatTicketTime(value: string | null, locale: string): string {
  if (value === null) return TICKET_TIME_PLACEHOLDER;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return TICKET_TIME_PLACEHOLDER;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}
