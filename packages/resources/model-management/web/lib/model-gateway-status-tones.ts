import type { StatusTone } from "@fenix/ui-components/config/StatusBadge";

/**
 * 模型网关同步状态词表 → 组件库的语义色调。
 *
 * 为什么不直接给色值：同一个 `synced` 此前在本包被写成两套配色——概览卡片的
 * `variant={status === "synced" ? "default" : "secondary"}` 与模型表里的 `text-green-700`，
 * 一处是主色徽标、一处是绿字，深色态还各补一份。这里只声明「这个词算好消息还是待办」，
 * 具体配色（含 dark 变体）由 `StatusBadge` 承担。
 *
 * `pending` 落 `neutral` 而不是 `warning`：它表示「配置有变更待同步」，与既有的 `secondary`
 * 徽标同义，不把一次未同步升级成告警色；`unknown`（从未检查成功）同样落 `neutral`
 * ——未知状态不该先报红（与 `getStatusTone` 的兜底语义一致）。
 */
export const MODEL_GATEWAY_SYNC_TONES: Record<string, StatusTone> = {
  synced: "success",
  pending: "neutral",
  unknown: "neutral",
};
