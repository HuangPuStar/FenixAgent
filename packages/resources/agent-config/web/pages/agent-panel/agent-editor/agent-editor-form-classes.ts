/**
 * 「新建 Agent」面板 B 片（表单字段 / 卡片表面 / 短视口覆盖）的类串常量。
 *
 * 来源：`agent-editor-form-fields.css`(438) + `agent-editor-form-surfaces.css`(421) + `agent-editor-form-responsive.css`(218)。
 * 生效值口径见 `/tmp/agent-editor-effective-spec.md`（逐选择器分层 + 7 视口 font-size）；这里只写**生效值**。
 * 深层选择器与响应式覆盖见同名 CSS；扁平工具类保留在此，导出常量名保持不变。
 */
import "./agent-editor-form-classes.css";

/* ── 表单字段（form-fields） ───────────────────────────────────────────── */

/** `.agent-editor-field__label` 与 `.agent-editor-field` 两条类串已删除：字段包装改走
 * `@fenix/ui-components/config/LabeledField`，字段名刻度（`text-sm font-medium`）、提示位置与
 * 字段名/控件间距（6px）都归库内，配套的 `> small` 子代规则同步删除。 */
/** 输入/文本域的公共外观：`box-sizing` 由 preflight 提供，`outline:0` 等价 `outline-0`。 */
const FOCUS_RING = "agent-editor-field-focus";
const DISABLED = "agent-editor-field-disabled";
const TRANSITION = "agent-editor-field-transition";
/** `.agent-editor-input`：40px 高 / 9px 圆角 / 12px 横向内边距 / 13px。 */
export const INPUT = `w-full appearance-none h-10 border border-slate-200 rounded-md bg-white px-3 py-0 outline-0 [font:inherit] text-xs leading-snug text-slate-800 ${TRANSITION} ${FOCUS_RING} ${DISABLED}`;
/** `.agent-editor-textarea`：144px 最小高 / 可纵向拉伸 / 14px 内边距 / 13px。 */
export const TEXTAREA = `w-full appearance-none min-h-36 resize-y border border-slate-200 rounded-md bg-white px-3.5 py-3.5 outline-0 [font:inherit] text-xs leading-relaxed text-slate-800 ${TRANSITION} ${FOCUS_RING} ${DISABLED}`;
/** `.agent-resource-picker__search input` / `.agent-single-picker-toolbar input`：无边框透明底 30px 高。 */
export const PICKER_INPUT = `w-full appearance-none h-7.5 border-0 rounded-none bg-transparent p-0 outline-0 [font:inherit] text-xs text-slate-800 ${TRANSITION} ${FOCUS_RING}`;
/** `.agent-editor-button`：34px 高描边按钮。 */
export const BUTTON =
  "agent-editor-button inline-flex h-8.5 flex-none items-center justify-center border border-slate-200 rounded-md bg-white " +
  "px-2.5 outline-0 [font:inherit] text-xs text-slate-600 cursor-pointer";
/** 步进器宽度：原三列 34 / 58 / 34 的合计。列定义、按钮形态与数值框外观归 `ui/input-group`，
 * 原 `agent-editor-stepper` 的 grid 模板与 `STEPPER_CONTROL` / `STEPPER_BUTTON` 两条类串随之删除。 */
export const STEPPER = "w-31.5";
/** `.agent-editor-prompt-editor`：提示词文本域更高（180px，短视口 112px）。 */
export const PROMPT_EDITOR = "agent-editor-prompt-editor min-h-45 [font-family:inherit]";
/** `.agent-editor-guidance`：提示行（图标 + 文案，短视口收紧）。 */
export const GUIDANCE = "agent-editor-guidance flex items-start gap-2 mt-3.5 text-3xs leading-relaxed text-slate-500";
/** `.agent-editor-form-grid`：两列字段网格，响应式间距与子字段列位见同名 CSS。 */
export const FORM_GRID = "agent-editor-form-grid grid gap-x-4 gap-y-5 max-md:grid-cols-1 md:max-lg:grid-cols-1";
/** `.agent-editor-agent-id-row`：ID 输入 + 复制按钮一行。 */
export const AGENT_ID_ROW = "flex gap-1.75";
/** `.agent-editor-agent-id-row .agent-editor-input`：等宽字体 + 占满剩余宽度。 */
export const AGENT_ID_INPUT = "min-w-0 flex-1 font-mono text-xs";
/** `.agent-editor-agent-id-row :where(button)`（普通 button 与 `.agent-editor-button` 同值）：40px 高描边按钮。 */
export const AGENT_ID_BUTTON =
  "agent-editor-agent-id-button h-10 rounded-md flex-none border border-slate-200 bg-white px-3.25 py-0 text-xs text-slate-600 whitespace-nowrap";

/* ── 卡片表面（form-surfaces） ─────────────────────────────────────────── */

/** 开关行（`.agent-editor-toggle-row`，含 hover）——行内的开关本体是 `ui/switch`，选中态由库组件自己的
 * `data-state` 表达；行级的选中底色/描边改用 `:has([data-state="checked"])` 写在同名 CSS 里，
 * 因为 Radix 的状态挂在 Switch 上而不是这一行上。原 `TOGGLE_SWITCH` / `TOGGLE_KNOB` 两条自绘
 * 轨道与圆钮类串随之删除。 */
export const TOGGLE_ROW =
  "agent-editor-toggle-row grid w-full min-h-16.25 items-center gap-2.5 mt-3.5 " +
  "border border-slate-200 rounded-lg bg-white px-2.75 py-2.25 text-left text-slate-600";
/** 开关行图标底。 */
export const TOGGLE_ICON =
  "agent-editor-toggle-icon grid size-8 place-items-center rounded-md bg-slate-100 text-slate-500";
/** 开关行文案：标题 13px/加粗 680，说明 11px/1.45。 */
export const TOGGLE_COPY = "agent-editor-toggle-copy flex min-w-0 flex-col gap-0.75";
/** `.agent-model-summary`：当前模型卡片（40px 图标列）。 */
export const MODEL_SUMMARY = "agent-model-summary grid items-center gap-3 mt-4.5 rounded-lg bg-slate-50 p-3.5";
/** `.agent-runtime-note`：运行便签。 */
export const RUNTIME_NOTE =
  "agent-runtime-note flex items-center gap-2.25 mt-2.25 border border-slate-200 rounded-md bg-slate-100 px-2.5 py-2.25 text-gray-600";
/** `.agent-owner-card`：归属卡（42px 首字母格）。 */
export const OWNER_CARD =
  "agent-owner-card grid min-h-19 items-center gap-3 border border-slate-200 rounded-xl bg-white p-3";
/** `.agent-access-preview`：可见性预览。 */
export const ACCESS_PREVIEW = "agent-access-preview mt-3.5 rounded-lg bg-slate-50 p-3.25";
/** 能力分区页签条：只承载排布（等分三列 + 底部基线）。页签本体是 `ui/tabs` 的 `TabsList`（`variant="line"`）
 * 与 `TabsTrigger`，选中态下划线、刻度与配色归库内，故 `agent-capability-tabs` 语义类随之删除。 */
export const CAPABILITY_TABS = "flex w-full gap-1.25 mb-3.5 border-b border-slate-200";

/* ── 选项列表（模型 / 节点） ──────────────────────────────────────────── */

/** `.agent-model-options`：两列选项网格（max-md 单列，短视口 210px 上限）。 */
export const MODEL_OPTIONS = "agent-model-options grid max-h-77.5 gap-2 overflow-y-auto max-md:grid-cols-1";
/** `.agent-node-list`：单列选项网格（短视口 210px 上限）。 */
export const NODE_LIST = "agent-node-list grid max-h-77.5 grid-cols-1 gap-1.5 overflow-y-auto";
/** 选项行公共外观（模型 32/16 列、节点 34/18 列，由调用点补列定义）。 */
export const OPTION_ROW =
  "agent-editor-option-row grid min-h-13 items-center gap-2 border border-slate-200 rounded-lg bg-white px-2.25 py-2 text-left text-slate-600";
/** 选项行：选中态。 */
export const OPTION_ROW_SELECTED = "border-indigo-300 bg-sky-50";
/** 选项行：不可用态。 */
export const OPTION_ROW_UNAVAILABLE = "border-stone-300 bg-orange-50 text-stone-600";
/** 选项行：选中且禁用（值来自 `.is-selected:disabled` 与 `:has([data-slot=checkbox]:disabled)`）。 */
export const OPTION_ROW_SELECTED_DISABLED = "border-indigo-200 bg-sky-50 opacity-[0.78]";
/** 选项图标底（30px，图标 18px）。 */
export const OPTION_ICON =
  "agent-editor-option-icon flex size-7.5 items-center justify-center overflow-hidden rounded-lg bg-indigo-50 text-sky-600";
/** 选项文案：标题最多两行 13px，说明单行 11px。 */
export const OPTION_COPY = "agent-editor-option-copy flex min-w-0 flex-col gap-0.5";
/** 选项尾部的环形勾选标记（16px，勾 10px）。 */
export const OPTION_CHECK =
  "agent-editor-option-check flex size-4 flex-none items-center justify-center overflow-hidden rounded-full border border-gray-300 bg-white text-white leading-tight";
/** 勾选标记：选中态。 */
export const OPTION_CHECK_SELECTED = "border-blue-600 bg-blue-600";
/** 选项行尾部徽标（成本/范围）。 */
export const OPTION_BADGE = "text-3xs not-italic whitespace-nowrap text-slate-500";
/** 选项行不可用时的说明色（`.is-unavailable .agent-model-options__copy small`）。 */
export const OPTION_COPY_HINT_UNAVAILABLE = "text-yellow-700";

/* ── 单选器（single picker）与资源选择器 ──────────────────────────────── */

/** `.agent-single-picker-toolbar`：搜索条。 */
export const SINGLE_PICKER_TOOLBAR =
  "agent-single-picker-toolbar flex min-h-9.5 items-center gap-2.5 mb-1.75 border border-slate-200 rounded-md bg-white px-2.5 py-0";
/** `.agent-single-picker-current`：当前选择条（max-md 两列；不可用态见下）。 */
export const SINGLE_PICKER_CURRENT =
  "agent-single-picker-current grid min-h-9 items-center gap-1.75 mb-1.75 rounded-lg bg-blue-50 px-2.25 py-1.5 text-3xs text-slate-500";
/** `.agent-single-picker-current.is-unavailable`：不可用态（含描边与标题色）。 */
export const SINGLE_PICKER_CURRENT_UNAVAILABLE = "agent-single-picker-current-unavailable bg-orange-50 text-yellow-800";
/** `.agent-resource-picker`：资源选择器外壳。 */
export const PICKER = "overflow-hidden border border-slate-200 rounded-xl bg-white";
/** `.agent-resource-picker__selected`：已选区（116px 说明列；760–1119 收窄并隐藏小注）。 */
export const PICKER_SELECTED =
  "agent-resource-picker__selected grid min-h-16 items-center gap-3 border-b border-gray-100 bg-slate-50 px-3 py-2.5";
/** `.agent-resource-picker__chips`：已选 chip 区（容器本身是列，子 chip 才横排）。 */
export const PICKER_CHIPS = "agent-resource-picker__chips flex min-w-0 flex-col flex-wrap gap-0.75";
/** chip：不可用态（含 hover）。 */
export const PICKER_CHIP_UNAVAILABLE =
  "agent-resource-picker-chip-unavailable border border-orange-300 bg-orange-50 text-yellow-800";
/** `.agent-resource-picker__copy`：列表项文案列。 */
export const PICKER_COPY = "flex min-w-0 flex-col gap-0.75";
/** `.agent-resource-picker__empty`：空态文案。 */
export const PICKER_EMPTY = "text-3xs";
/** `.agent-resource-picker__search`：搜索行（39px 高）。 */
export const PICKER_SEARCH =
  "agent-resource-picker__search flex h-9.75 items-center gap-2 border-b border-gray-100 px-3 py-0 text-gray-400";
/** `.agent-resource-picker__list`：结果列表（282px 上限；短视口 210px）。 */
export const PICKER_LIST = "agent-resource-picker__list grid max-h-70.5 gap-0.75 p-1.25 overflow-y-auto";
/** 列表行外观（label；选中/不可用/禁用见下）。 */
export const PICKER_ROW =
  "agent-resource-picker-row grid min-h-13.25 items-center gap-2 border border-transparent rounded-lg bg-transparent px-2.25 py-1.75 text-left text-slate-600";
/** 列表行：选中态。 */
export const PICKER_ROW_SELECTED = "border-blue-100 bg-sky-50";
/** 列表行：不可用态。 */
export const PICKER_ROW_UNAVAILABLE =
  "agent-resource-picker-row-unavailable border-stone-300 bg-orange-50 text-stone-600";
/** 列表行：选中且禁用。 */
export const PICKER_ROW_SELECTED_DISABLED = "border-indigo-200 bg-sky-50 opacity-[0.78]";
/** 列表行图标（有图标时列位 32/21）。 */
export const PICKER_ROW_WITH_ICON = "agent-resource-picker-row-with-icon";
/** 列表行图标底。 */
export const PICKER_ICON =
  "agent-resource-picker-icon grid size-7.5 place-items-center rounded-lg bg-indigo-50 text-sky-700";
/** 列表行标题 / 说明 / 徽标。 */
export const PICKER_ROW_TITLE = "text-xs [font-weight:680]";
/** 列表行说明。 */
export const PICKER_ROW_HINT = "overflow-hidden text-ellipsis whitespace-nowrap text-3xs text-gray-400";
/** 列表行范围徽标。 */
export const PICKER_ROW_BADGE =
  "rounded-full bg-slate-100 px-1.5 py-0.75 text-3xs not-italic whitespace-nowrap text-slate-500";
/** 列表内 Checkbox（ui-components 组件，需 `!`；边框与阴影的层叠约束见 CSS）。 */
export const PICKER_CHECKBOX = "agent-resource-picker-checkbox !size-4.5 !rounded-sm";
/** 列表内 Checkbox 选中态。 */
export const PICKER_CHECKBOX_CHECKED = "!border-blue-600 !bg-blue-600";
/** `.agent-retrieval-options .agent-editor-field`（knowledge.css 的规则，落在 B 的字段类上，故由 B 接手）。 */
export const RETRIEVAL_OPTIONS_FIELDS = "agent-retrieval-options-fields";
/** `#agent-editor-default-namespaces` 的 760–1119 覆盖。 */
export const DEFAULT_NAMESPACES_TEXTAREA = "md:max-lg:min-h-18";

/* ── 分页（类名属 C 的 library.css，声明来自 B 的 form-responsive.css，故由 B 先落地） ── */

/** `.agent-editor-pagination`：底部翻页条（34px 高，上分隔线）。 */
export const PAGINATION =
  "flex min-h-8.5 items-center justify-between gap-2.5 border-t border-gray-100 px-2 py-0 text-3xs text-gray-400";
/** `.agent-editor-pagination > div`：翻页按钮组。 */
export const PAGINATION_GROUP = "flex items-center gap-1.5";
/** `.agent-editor-pagination button`：24×22 方形按钮（禁用态降透明度）。 */
export const PAGINATION_BUTTON =
  "agent-editor-pagination-button grid h-5.5 w-6 place-items-center border border-slate-200 rounded-md bg-white text-slate-500";
/** `.agent-editor-pagination strong`：页码。 */
export const PAGINATION_COUNT = "min-w-9 text-center text-slate-600";
/** `.agent-editor-root .agent-editor-library-picker`（C 的类名）在 760–1119 收窄左列。 */
export const LIBRARY_PICKER_NARROW = "agent-editor-library-picker-narrow";
/** `.agent-editor-root .agent-editor-group-filter button`（C 的类名）在 760–1119 收横向内边距。 */
export const GROUP_FILTER_NARROW = "agent-editor-group-filter-narrow";
