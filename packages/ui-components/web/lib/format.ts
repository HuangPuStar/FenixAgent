/**
 * 时间值 → 展示串的格式化原语。
 *
 * 机制最小化：**只做「把后端给的日期值渲染成本地化串」**——不含 i18n、不含颜色 / 图标 / 布局，
 * 除回退文案外不决定任何展示形态。
 *
 * 为什么库内不读 i18n：`locale` 缺省为 `undefined`，即**运行时默认区域**（浏览器 / Node 的 `Intl`
 * 默认），与不传参的 `Date.prototype.toLocaleString()` 行为一致；要跟随界面语言时由调用方显式传
 * `i18n.language`（如 API 密钥页）。库内取 i18n 会把本包与某个命名空间绑死，同一处文案在两侧各留
 * 一份（同 §4.1 对 `ScopeFilterBar` 不接 i18n 的裁定）。
 *
 * 时区口径：一律**运行时本地时区**。`timeZone` 只为可测性存在（用例显式传 `"UTC"` 让断言不随运行
 * 环境漂移），生产调用点不要传——传了就与用户所在时区不一致。
 *
 * 空值 / 无效值：`null` / `undefined` / `""`，以及 `new Date(...)` 得到 `Invalid Date` 的输入，
 * 一律回退 `fallback`（缺省 `"—"`）：既不抛错，也不把 `"Invalid Date"` 渲染给用户。值既可能是 ISO
 * 串也可能是 epoch 毫秒（API 密钥契约即 `number | string | null`），两者都接受。
 *
 * 与 `lib/clipboard` 同层：`web/lib/` 下的原语只做纯机制，反馈形态与文案归调用方。
 */

const DEFAULT_FALLBACK = "—";

/** 可格式化的时间值：ISO 串、epoch 毫秒、`Date`，以及表示「没有值」的 `null` / `undefined` / `""`。 */
export type TimeFormatValue = string | number | Date | null | undefined;

/** 三个格式化函数共用的选项。 */
export interface TimeFormatOptions {
  /** BCP 47 区域标识；缺省为运行时默认区域（不读 i18n）。 */
  locale?: string;
  /** 空值 / 无效值的回退文案；缺省 `"—"`。 */
  fallback?: string;
  /** 展示时区；缺省为运行时本地时区，仅供测试显式指定。 */
  timeZone?: string;
}

/** 值 → 可格式化的 `Date`；空值与无效值回退 `null`（调用方据此给 `fallback`）。 */
function toDate(value: TimeFormatValue): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 日期 + 时刻（`zh-CN` 下形如 `2026/9/22 15:04:05`）；等价于不传参的 `Date.prototype.toLocaleString()`。
 * 此前是 observer 平坦表 / 日志页与 sandbox 面板 / 实例行的四处逐字重复。
 */
export function formatDateTime(value: TimeFormatValue, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? DEFAULT_FALLBACK;
  return date.toLocaleString(options.locale, { timeZone: options.timeZone });
}

/** 仅时刻（`zh-CN` 下形如 `15:04:05`）；等价于不传参的 `Date.prototype.toLocaleTimeString()`。 */
export function formatClockTime(value: TimeFormatValue, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? DEFAULT_FALLBACK;
  return date.toLocaleTimeString(options.locale, { timeZone: options.timeZone });
}

/**
 * 仅日期，固定 `{ year: "numeric", month: "short", day: "numeric" }` 样式（`zh-CN` 下 `2026年9月22日`、
 * `en-US` 下 `Sep 22, 2026`）。
 *
 * 字段选择与参数语义取自 `packages/platform/identity` 原先的 `formatApiKeyDate(value, locale, emptyLabel)`：
 * 区域由调用方给、空值回退由调用方给。`month: "short"` 是刻意的——纯数字月日在多语言表格里分不出
 * 「月/日」还是「日/月」，缩写月名没有这个歧义。
 */
export function formatDate(value: TimeFormatValue, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? DEFAULT_FALLBACK;
  return date.toLocaleDateString(options.locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: options.timeZone,
  });
}
