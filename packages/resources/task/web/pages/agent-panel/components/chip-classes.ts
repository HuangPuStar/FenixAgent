/**
 * 单选药丸（chip）的类串：cron 预设/自定义 chip 与日志状态筛选 chip 共用。
 *
 * 为什么抽成模块：这串类此前在 `CronEditor`（预设 5 个 + 自定义 1 个）与 `TaskLogDialog`（状态筛选 5 个）
 * 里逐字抄了 3 份，连 `type="button"`、`size="sm"` 与 `variant={active ? "default" : "outline"}`
 * 的取值都一致，只有文案、选中态来源与点击回调不同（2026-09-22 前端去重）。
 *
 * 为什么只收口类串、不抽组件：两处是不同语义的单选行——一处是「把 cron 值设成哪个预设」，
 * 一处是「日志列表按哪个状态过滤」，选中态的计算方式也不同（前者含 `editingCustom || !isPreset`）。
 * 抽成组件就得把这两套判断塞进 props，反而把差异藏起来；先只把外观配方收成一份。
 *
 * 目录选择与 `knowledge-typography.ts` 同据：样式存量台账按「规则 + 目录」登记，本目录已有台账条目，
 * 放在已登记的目录下不会引入新目录。本类串不含任意值，对门禁无影响。
 */
export const CHOICE_CHIP_CLASS = "rounded-full h-6 px-3 text-xs font-normal";
