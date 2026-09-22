import type { StatusTone } from "@fenix/ui-components/config/StatusBadge";

/**
 * 知识库 / 知识资源状态词表 → 组件库的语义色调。
 *
 * 为什么不直接给色值：同一个 `ready / processing / error` 此前在本包被写成 5 份互不相同的配色
 * （两份逐字相同的 CSS 类映射 `statusClass`、详情头部的 `getStatusBadge` / `getStatusDot`、
 * chunk 卡片的行内三元），`ready` 一处是 `#ecfdf5` 一处是 `emerald-50`，深色态更是各写各的。
 * 收敛后本包只声明「这个词算好消息还是坏消息」，具体配色（含 dark 变体）由 `StatusBadge` 承担。
 *
 * 未知状态落到 `neutral` 而不是 `danger`：新状态上线时不该先报红。
 */
export const KB_STATUS_TONES: Record<string, StatusTone> = {
  ready: "success",
  processing: "info",
  indexing: "info",
  pending: "neutral",
  error: "danger",
};

/**
 * 状态文案：查字典 `status.<status>`，未收录的状态回退成后端原文——不吞信息，
 * 也避免把不认识的失败翻译成一句看似精确的承诺（与 `reparse.*` 错误码映射同一取舍）。
 */
export function kbStatusLabel(t: (key: string, opts: { defaultValue: string }) => string, status: string): string {
  return t(`status.${status}`, { defaultValue: status });
}
