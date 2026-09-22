/**
 * 知识库面板「字段名」的统一排版类。
 *
 * 为什么抽成模块：这串类此前在 `RetrievalTestPanel`（9 处检索参数标签）与 `AgentKnowledgeBasesPage`
 * 的 `FieldGroup`（1 处）里逐字抄了 10 份，改一处就得记得改另外 9 处（2026-09-22 前端去重）。
 *
 * 为什么保留 13px / 600：这是该面板既有的字段名刻度，与库 `config/LabeledField` 的
 * `text-sm font-medium`（14px / 500）**不同尺**；按「字号归一化会改视觉」的口径，本批只做去重，
 * 不动字号。颜色 `#0f172a` 与主题的 `--color-foreground` / `--color-text-bright` 亮色态等值，
 * 但同样没有换成语义 token——那会在暗色态把它变成浅色（属行为修正），留给后续暗色适配批次。
 *
 * 为什么落在这个目录而不是 `web/lib/`：这串类里含两处任意值（`text-[13px]` / `text-[#0f172a]`），
 * 而样式存量台账（`scripts/check-web-style.ts`）按「规则 + 目录」登记且**新目录一律算新增**——
 * 放进尚未登记的 `web/lib/` 会被判成新增违规。本目录（`pages/agent-panel/pages`）已有台账条目且
 * 实际命中数低于登记数，合并后总量只降不升。纯逻辑的 `web/lib/poll-resources.ts` 不含样式值，
 * 仍按兄弟包的 `web/lib/` 约定放置。
 */
export const FIELD_LABEL_CLASS = "text-[13px] font-semibold text-[#0f172a]";
