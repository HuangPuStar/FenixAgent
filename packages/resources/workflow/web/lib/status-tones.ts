import type { StatusTone } from "@fenix/ui-components/config/StatusBadge";

/**
 * 工作流状态色调词表：只声明「这个词算好消息还是坏消息」，具体配色（含 dark 变体）由 `StatusBadge` 承担。
 *
 * 为什么不给色值：同一件事在本包此前有两套写法——运行记录页在文件内自持一份色调表，工作流列表卡片的
 * 发布态药丸则直接写死 Tailwind 色值（`bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400`）。
 * 色值一旦落到业务侧，同一个「成功」会各自演化出不同的绿，深色态还要各补一份。
 *
 * 为什么库的内置词表不够：内置表是**库**对通用状态的判断（enabled / configured / builtIn 等），与本包
 * 对「一次运行」「一次发布」的判断不是同一件事。词表放在包内，库侧调整内置表时本包语义不变，新增状态
 * 也有唯一落点（与 `packages/resources/prod-view/web/lib/status-tones.ts` 同一形状）。
 *
 * 未知状态落 `neutral`（`getStatusTone` 的兜底语义）：新状态上线时不该先报红。
 */
export const WORKFLOW_RUN_STATUS_TONES: Record<string, StatusTone> = {
  PENDING: "neutral",
  RUNNING: "info",
  SUSPENDED: "warning",
  SUCCESS: "success",
  FAILED: "danger",
  CANCELLED: "neutral",
  ERROR: "danger",
};

/**
 * 发布状态色调：工作流列表卡片上「`v{版本号}` / 未发布」药丸的两态。
 *
 * 键是本包自定的状态名而不是服务端字段：`latestVersion` 有值即已发布、为空即未发布，两态由调用点归一
 * 成 `status` 后查表（文案仍由调用点给，`StatusBadge` 的 `label` 优先于它的字典回退）。归色调而不是归
 * 色值的理由同上一份词表。
 */
export const WORKFLOW_PUBLISH_STATUS_TONES: Record<string, StatusTone> = {
  published: "success",
  unpublished: "neutral",
};
