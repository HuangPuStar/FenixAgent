/**
 * 云盘页面的展示格式化原语：字节数与文件类型图标。
 *
 * 与 `@fenix/ui-components/lib/format` 同层：只做纯机制，不读 i18n、不出文案。字节单位（B / KB / …）
 * 属协议量纲，语言无关，直接拼在串里；本地化只影响数字部分的小数分隔符（由调用方传 `locale`）。
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** 1099511627776（1 TiB）以内的配额与文件大小都够用；超出后仍按 PB 显示，不引入新单位。 */
const BYTE_BASE = 1024;

/**
 * 字节数 → 人读文本（1024 进制，最多一位小数）。
 *
 * 0 显示 `0 B`；负数与 NaN 按 0 处理（配额字段是 nonnegative，但展示层不为此抛错）。
 */
export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${BYTE_UNITS[0]}`;

  let value = bytes;
  let unitIndex = 0;
  while (value >= BYTE_BASE && unitIndex < BYTE_UNITS.length - 1) {
    value /= BYTE_BASE;
    unitIndex += 1;
  }

  const maximumFractionDigits = unitIndex === 0 ? 0 : 1;
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
  return `${formatted} ${BYTE_UNITS[unitIndex]}`;
}

/** 上传进度百分比（0-100 的整数）；除零与越界都收敛到合法区间。 */
export function uploadPercent(uploadedBytes: number, totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  const percent = Math.round((uploadedBytes / totalBytes) * 100);
  return Math.min(100, Math.max(0, percent));
}
