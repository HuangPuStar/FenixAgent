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
 * 知识资源状态色调：在知识库词表之上只多一条 `empty`（解析结束但零分块）→ 告警。
 *
 * 为什么不直接复用 `KB_STATUS_TONES` 加键：同一个 `empty` 在知识库级表示「新建、尚未上传」，
 * 那里套上 warning 会让每个刚建好的知识库一出现就带黄标；资源级才是「有东西但不可检索」，
 * 值得提醒。`error`（远端解析失败）在两级都是 danger，共用无碍。
 */
export const RESOURCE_STATUS_TONES: Record<string, StatusTone> = { ...KB_STATUS_TONES, empty: "warning" };

/**
 * 资源处于「不可检索」时的处理建议键；无需提示的状态返回 `null`。
 *
 * 只有两种状态要提示，且两者的用户动作不同，因此分开两句而不是一句通用文案：
 * `empty`（解析结束但零分块，如文件损坏）要用户检查文件或重新上传；`error`（远端解析失败）先重新解析。
 * 其余状态（`pending` / `processing` / `ready`）不需要建议——进行中会显示进度条，已就绪无需多言。
 */
export function resourceStatusHintKey(status: string): string | null {
  switch (status) {
    case "empty":
      return "resources.noContentHint";
    case "error":
      return "resources.failedHint";
    default:
      return null;
  }
}

/**
 * 状态文案：查字典 `status.<status>`，未收录的状态回退成后端原文——不吞信息，
 * 也避免把不认识的失败翻译成一句看似精确的承诺（与 `reparse.*` 错误码映射同一取舍）。
 */
export function kbStatusLabel(t: (key: string, opts: { defaultValue: string }) => string, status: string): string {
  return t(`status.${status}`, { defaultValue: status });
}
