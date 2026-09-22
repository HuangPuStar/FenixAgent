import type { StatusTone } from "@fenix/ui-components/config/StatusBadge";

/**
 * 生产视图的启用状态词表 → 组件库的语义色调。
 *
 * 为什么不给色值：`enabled / disabled` 在本包此前有多套写法——卡片 pill、面板圆点各自声明颜色
 * （圆点至今仍是手写的 `bg-emerald-500 / bg-slate-400`），同一件事两处配色、深色态还要各补一份。
 * 这里只声明「这个词算好消息还是中性」，具体配色（含 dark 变体）由 `StatusBadge` 承担。
 *
 * 为什么库内置词表里已有 `enabled / disabled` 还要在本包写一份：内置表是**库**对通用状态的判断，
 * 与本包对「发布视图启用态」的判断不是同一件事。词表放在包内，库侧调整内置表时本包的语义不变，
 * 将来新增的发布视图状态也有唯一落点，不必去改库。
 *
 * 未知状态落 `neutral`（`getStatusTone` 的兜底语义）：新状态上线时不该先报红。
 */
export const PROD_VIEW_STATUS_TONES: Record<string, StatusTone> = {
  enabled: "success",
  disabled: "neutral",
};
