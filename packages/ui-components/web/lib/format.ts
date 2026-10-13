/**
 * 展示串格式化原语：时间值 / 时长与数量 / 文本截断 → 人读文本。
 *
 * 机制最小化：**只做「把后端给的值渲染成本地化串」**——不含 i18n、不含颜色 / 图标 / 布局，
 * 除回退文案外不决定任何展示形态。
 *
 * 单位与符号（`ms` / `s` / `m`、`$`、`1.2k`）是协议量纲的一部分，语言无关，直接拼在串里；需要本地化
 * 的措辞（「令牌数」「耗时」这类标签）由调用方 `t()` 提供，本模块不出文案。
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

/** 三个时间格式化函数共用的选项。 */
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

/** 可格式化的时长 / 数量值：缺失用 `null` / `undefined` 表示，没有「空串即缺失」的口径。 */
export type QuantityFormatValue = number | null | undefined;

/** 时长 / 数量格式化函数共用的选项。 */
export interface QuantityFormatOptions {
  /** 缺失 / 无效值的回退文案；缺省 `"—"`。 */
  fallback?: string;
  /** BCP 47 区域标识；只影响 `formatTokens` 的紧凑计数，缺省为运行时默认区域（不读 i18n）。 */
  locale?: string;
}

/**
 * 毫秒 → `"812 ms"` / `"2.0 s"` / `"1m 5s"`。
 *
 * 缺失、`NaN` / `Infinity` 与负数一律回退 `fallback`（缺省 `"—"`）：负时长只可能来自时钟回拨或上游脏数据，
 * 按「没有值」处理比渲染 `-3 ms` 更能提示问题。量级切换按**原值**判断，`999.6` 因此是 `"1000 ms"` 而不是跳成
 * `"1.0 s"`——两位数毫秒的四舍五入不该让单位跳档。
 */
export function formatDurationMs(ms: QuantityFormatValue, options: QuantityFormatOptions = {}): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return options.fallback ?? DEFAULT_FALLBACK;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/**
 * 秒 → 与 {@link formatDurationMs} 同口径的时长串：上游以秒计量的耗时字段（`latency`、`timeToFirstToken`）
 * 用它，省去调用方各自乘 1000。
 */
export function formatSeconds(seconds: QuantityFormatValue, options: QuantityFormatOptions = {}): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return options.fallback ?? DEFAULT_FALLBACK;
  return formatDurationMs(seconds * 1000, options);
}

/**
 * 两个时间点之差 → 时长（取值口径同 {@link TimeFormatValue}）；任一缺失 / 非法或时钟倒挂（`end < start`）
 * 回退 `fallback`。
 */
export function formatInterval(
  start: TimeFormatValue,
  end: TimeFormatValue,
  options: QuantityFormatOptions = {},
): string {
  const startDate = toDate(start);
  const endDate = toDate(end);
  if (!startDate || !endDate) return options.fallback ?? DEFAULT_FALLBACK;
  return formatDurationMs(endDate.getTime() - startDate.getTime(), options);
}

/**
 * 令牌数 → `"1.2K"` 这类紧凑表示（`Intl` 的 `compact` 计数，区域规则随 `locale`——`zh-CN` 下万 / 亿为刻度）。
 *
 * `0` 是有效值，照常渲染；只有缺失才回退。
 */
export function formatTokens(count: QuantityFormatValue, options: QuantityFormatOptions = {}): string {
  if (count === null || count === undefined) return options.fallback ?? DEFAULT_FALLBACK;
  return new Intl.NumberFormat(options.locale, { notation: "compact", maximumFractionDigits: 1 }).format(count);
}

/**
 * 美元金额 → `"$0.00213"` / `"$1.20"`；缺失、非有限数与负数回退 `fallback`。
 *
 * 小于 1 美分时改用 3 位有效数字：按 `toFixed(2)` 会把一次真实计费显示成 `$0.00`，与「免费」无法区分。
 * 币种符号写死为 `$`——上游计量接口（模型用量）以美元计价，需要多币种展示时应另立原语，不要在这里加分支。
 */
export function formatCost(cost: QuantityFormatValue, options: QuantityFormatOptions = {}): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost < 0)
    return options.fallback ?? DEFAULT_FALLBACK;
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toPrecision(3)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * 单行截断（预览文本用）：超过 `max` 个 UTF-16 单元即切分并补 `"…"`，未超长则原样返回。
 *
 * 按 UTF-16 单元切分即可，预览不需要字符簇级精度；超长文本的多行展示（折叠 / 展开全文）不属于本原语，
 * 那是组件的形态决策。
 *
 * 2026-10-10 合并：本包 `web/chat/lib/tool-call-utils.ts` 与 trace 面板各存一份逐字实现，收敛到此处，
 * 两处原调用点改为引用本模块。
 */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
