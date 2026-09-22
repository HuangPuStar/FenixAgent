/**
 * 「新建 Agent」面板 B 片（表单字段 / 卡片表面 / 短视口覆盖）的类串常量。
 *
 * 来源：`agent-editor-form-fields.css`(438) + `agent-editor-form-surfaces.css`(421) + `agent-editor-form-responsive.css`(218)。
 * 生效值口径见 `/tmp/agent-editor-effective-spec.md`（逐选择器分层 + 7 视口 font-size）；这里只写**生效值**。
 *
 * 两条纪律（与 A2 一致）：
 * 1. base 工具类总在媒体变体之前生成，故「base vs 变体」安全；**变体之间**必须条件互斥（同属性多值不许看生成顺序）。
 * 2. ui-components 自带工具类（Button/Input/Checkbox/Textarea）处一律用 `!`。
 */

/* ── 表单字段（form-fields） ───────────────────────────────────────────── */

/** `.agent-editor-field`：字段外壳（列布局）。 */
export const FIELD = "flex min-w-0 flex-col gap-[9px]";
/** `.agent-editor-field__label`：标签行（左标签 + 右小注）。 */
export const FIELD_LABEL =
  "flex items-center justify-between gap-3 text-[12px] [font-weight:680] leading-[1.35] text-[#35445c] " +
  "[&>small]:text-[11px] [&>small]:[font-weight:500] [&>small]:text-[#9aa5b6]";
/** 输入/文本域的公共外观：`box-sizing` 由 preflight 提供，`outline:0` 等价 `outline-0`。 */
const FOCUS_RING = "[&:focus]:border-[#75a0ee] [&:focus]:shadow-[0_0_0_3px_rgb(39_100_231_/_9%)]";
const DISABLED = "[&:disabled]:cursor-not-allowed [&:disabled]:bg-[#f5f7fa] [&:disabled]:text-[#77859a]";
const TRANSITION = "transition-[border-color_140ms_ease,box-shadow_140ms_ease,background_140ms_ease]";
/** `.agent-editor-input`：40px 高 / 9px 圆角 / 12px 横向内边距 / 13px。 */
export const INPUT = `w-full appearance-none h-10 border border-[#dde4ed] rounded-[9px] bg-[#fff] px-3 py-0 outline-0 [font:inherit] text-[13px] leading-[1.4] text-[#1d2940] ${TRANSITION} ${FOCUS_RING} ${DISABLED}`;
/** `.agent-editor-textarea`：144px 最小高 / 可纵向拉伸 / 14px 内边距 / 13px。 */
export const TEXTAREA = `w-full appearance-none min-h-36 resize-y border border-[#dde4ed] rounded-[9px] bg-[#fff] px-[14px] py-[14px] outline-0 [font:inherit] text-[13px] leading-[1.7] text-[#1d2940] ${TRANSITION} ${FOCUS_RING} ${DISABLED}`;
/** `.agent-resource-picker__search input` / `.agent-single-picker-toolbar input`：无边框透明底 30px 高。 */
export const PICKER_INPUT = `w-full appearance-none h-[30px] border-0 rounded-none bg-transparent p-0 outline-0 [font:inherit] text-[13px] text-[#1d2940] ${TRANSITION} ${FOCUS_RING}`;
/** `.agent-editor-button`：34px 高描边按钮。 */
export const BUTTON =
  "inline-flex h-[34px] flex-none items-center justify-center border border-[#dde4ed] rounded-[9px] bg-[#fff] " +
  "px-[10px] outline-0 [font:inherit] text-[13px] text-[#53637a] cursor-pointer " +
  "[&:disabled]:cursor-not-allowed [&:disabled]:opacity-45 " +
  "[&:focus-visible]:outline-0 [&:focus-visible]:shadow-[0_0_0_3px_rgb(39_100_231_/_12%)] " +
  "[&:hover:not(:disabled)]:border-[#aac3ef] [&:hover:not(:disabled)]:bg-[#f7faff] [&:hover:not(:disabled)]:text-[#2458b9]";
/** `.agent-editor-stepper`：34/58/34 三列步进器。 */
export const STEPPER =
  "grid w-[126px] grid-cols-[34px_58px_34px] overflow-hidden border border-[#dde4ed] rounded-[9px] bg-[#fff]";
/** `.agent-editor-stepper button/input`：无框透明 32px 高，按钮再补居中与指针。 */
export const STEPPER_CONTROL =
  "h-8 border-0 rounded-none bg-transparent p-0 text-center outline-0 [font:inherit] text-[#53637a]";
/** `.agent-editor-stepper button` 追加。 */
export const STEPPER_BUTTON = "grid place-items-center cursor-pointer";
/** `.agent-editor-prompt-editor`：提示词文本域更高（180px，短视口 112px）。 */
export const PROMPT_EDITOR =
  "min-h-[180px] [font-family:inherit] [@media(min-width:760px)_and_(max-height:700px)]:min-h-[112px]";
/** `.agent-editor-guidance`：提示行（图标 + 文案，短视口收紧）。 */
export const GUIDANCE =
  "flex items-start gap-2 mt-[14px] text-[11px] leading-[1.6] text-[#6f7f96] " +
  "[&>svg]:w-[15px] [&>svg]:flex-none [&>svg]:basis-[15px] [&>svg]:text-[#3e72cf] " +
  "[@media(min-width:760px)_and_(max-height:700px)]:mt-2 [@media(min-width:760px)_and_(max-height:700px)]:leading-[1.45]";
/** `.agent-editor-form-grid`：两列字段网格（16/20 间距；≤759 与 760–1119 单列；短视口收间距；子字段列位）。 */
export const FORM_GRID =
  "grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-4 gap-y-5 " +
  "[@media(max-width:759px)]:grid-cols-1 [@media(min-width:760px)_and_(max-width:1119px)]:grid-cols-1 " +
  "[@media(min-width:760px)_and_(max-width:1119px)]:[&>label]:col-start-1 " +
  "[@media(min-width:760px)_and_(max-height:700px)]:gap-x-3 [@media(min-width:760px)_and_(max-height:700px)]:gap-y-[10px]";
/** `.agent-editor-agent-id-row`：ID 输入 + 复制按钮一行。 */
export const AGENT_ID_ROW = "flex gap-[7px]";
/** `.agent-editor-agent-id-row .agent-editor-input`：等宽字体 + 占满剩余宽度。 */
export const AGENT_ID_INPUT = "min-w-0 flex-1 font-mono text-[13px]";
/** `.agent-editor-agent-id-row :where(button)`（普通 button 与 `.agent-editor-button` 同值）：40px 高描边按钮。 */
export const AGENT_ID_BUTTON =
  "h-10 rounded-[9px] flex-none border border-[#dde4ed] bg-[#fff] px-[13px] py-0 text-[13px] text-[#53637a] " +
  "whitespace-nowrap [&:hover]:border-[#aac3ef] [&:hover]:bg-[#f7faff] [&:hover]:text-[#2458b9]";

/* ── 卡片表面（form-surfaces） ─────────────────────────────────────────── */

/** 开关行（`.agent-editor-toggle-row`，含 `.is-on` 与 hover）——选中态用 `data-state` 标记，子元素靠 `group` 变体取值。 */
export const TOGGLE_ROW =
  "group/toggle grid w-full min-h-[65px] grid-cols-[34px_minmax(0,1fr)_34px] items-center gap-[10px] mt-[14px] " +
  "border border-[#e2e8f0] rounded-[11px] bg-[#fff] px-[11px] py-[9px] text-left text-[#46566e] " +
  "[&:hover]:border-[#c9daf7] [&:hover]:bg-[#f8fbff] data-[state=on]:border-[#c9daf7] data-[state=on]:bg-[#f8fbff]";
/** 开关行图标底。 */
export const TOGGLE_ICON = "grid size-8 place-items-center rounded-[9px] bg-[#f0f3f7] text-[#6d7e96] [&>svg]:w-[15px]";
/** 开关行文案：标题 13px/加粗 680，说明 11px/1.45。 */
export const TOGGLE_COPY =
  "flex min-w-0 flex-col gap-[3px] [&>strong]:flex [&>strong]:items-center [&>strong]:gap-[7px] [&>strong]:text-[13px] " +
  "[&>strong]:text-[#33445c] [&>small]:text-[11px] [&>small]:leading-[1.45] [&>small]:text-[#8996a9]";
/** `.agent-editor-switch`：32×18 轨道（选中变蓝）。 */
export const TOGGLE_SWITCH =
  "block h-[18px] w-8 rounded-full bg-[#cfd7e3] p-[2px] group-data-[state=on]/toggle:bg-[#2764e7]";
/** `.agent-editor-switch i`：14px 圆钮（选中右移 14px）。 */
export const TOGGLE_KNOB =
  "block size-[14px] rounded-full bg-[#fff] shadow-[0_1px_4px_rgb(25_43_75_/_20%)] group-data-[state=on]/toggle:translate-x-[14px]";
/** `.agent-model-summary`：当前模型卡片（40px 图标列）。 */
export const MODEL_SUMMARY =
  "grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 mt-[18px] rounded-[11px] bg-[#f6f8fb] p-[14px] " +
  "[&>span]:grid [&>span]:size-10 [&>span]:place-items-center [&>span]:rounded-[10px] [&>span]:bg-[#eaf2ff] [&>span]:text-[#3269ce] " +
  "[&>span>svg]:w-[15px] [&>div]:flex [&>div]:flex-col [&>div]:gap-[2px] " +
  "[&_small]:text-[11px] [&_small]:text-[#8b97a9] [&_strong]:text-[14px] [&_strong]:[font-weight:680] [&_strong]:text-[#34455f] " +
  "[&_p]:m-0 [&_p]:text-[11px] [&_p]:leading-[1.5] [&_p]:text-[#8995a7]";
/** `.agent-runtime-note`：运行便签。 */
export const RUNTIME_NOTE =
  "flex items-center gap-[9px] mt-[9px] border border-[#dbece6] rounded-[9px] bg-[#edf7f4] px-[10px] py-[9px] text-[#4e6b63] " +
  "[&>svg]:w-[15px] [&>svg]:flex-none [&>svg]:basis-[15px] [&_strong]:text-[13px] [&_strong]:text-[#315f53] " +
  "[&_p]:m-0 [&_p]:mt-1 [&_p]:text-[11px] [&_p]:leading-[1.55]";
/** `.agent-owner-card`：归属卡（42px 首字母格）。 */
export const OWNER_CARD =
  "grid min-h-[76px] grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 border border-[#e0e6ee] rounded-xl bg-[#fff] p-3 " +
  "[&>span]:grid [&>span]:size-[42px] [&>span]:place-items-center [&>span]:rounded-xl [&>span]:text-[13px] [&>span]:[font-weight:720] [&>span]:text-[#fff] " +
  "[&>span]:bg-[linear-gradient(145deg,#3c78e4,#274eaa)] " +
  "[&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div]:gap-[3px] " +
  "[&_small]:text-[11px] [&_small]:text-[#98a3b3] [&_strong]:text-[13px] [&_strong]:text-[#33435b] " +
  "[&_p]:m-0 [&_p]:text-[11px] [&_p]:text-[#8491a4] [&_em]:rounded-full [&_em]:bg-[#eaf2ff] [&_em]:px-[7px] [&_em]:py-1 " +
  "[&_em]:text-[10px] [&_em]:not-italic [&_em]:text-[#2762c8]";
/** `.agent-access-preview`：可见性预览。 */
export const ACCESS_PREVIEW =
  "mt-[14px] rounded-[11px] bg-[#f6f8fb] p-[13px] " +
  "[&>strong]:text-[11px] [&>strong]:text-[#57677f] " +
  "[&>div]:flex [&>div]:items-center [&>div]:gap-[9px] [&>div]:my-2 [&>div]:mx-0 " +
  "[&>div>span]:rounded-[7px] [&>div>span]:bg-[#fff] [&>div>span]:px-[9px] [&>div>span]:py-[6px] [&>div>span]:text-[13px] [&>div>span]:text-[#39516f] " +
  "[&>div>span]:shadow-[inset_0_0_0_1px_#e0e6ee] [&>div>i]:h-px [&>div>i]:w-6 [&>div>i]:bg-[#c9d2df]";
/** `.agent-capability-tabs`：能力分区页签（选中态用 `data-active`，下划线用 `after:`）。 */
export const CAPABILITY_TABS =
  "flex gap-[5px] mb-[14px] border-b border-[#e8edf4] " +
  "[&>button]:relative [&>button]:flex [&>button]:min-h-[39px] [&>button]:items-center [&>button]:gap-[6px] " +
  "[&>button]:border-0 [&>button]:bg-transparent [&>button]:px-3 [&>button]:py-0 [&>button]:text-[13px] " +
  "[&>button]:[font-weight:650] [&>button]:text-[#718097] [&>svg]:w-[13px] " +
  "[&>button>span]:grid [&>button>span]:h-[18px] [&>button>span]:min-w-[18px] [&>button>span]:place-items-center " +
  "[&>button>span]:rounded-full [&>button>span]:bg-[#edf1f6] [&>button>span]:text-[10px] [&>button>span]:text-[#718097] " +
  "[&>button[data-active=true]]:text-[#2255b2] " +
  "[&>button[data-active=true]]:after:absolute [&>button[data-active=true]]:after:inset-x-[9px] " +
  "[&>button[data-active=true]]:after:-bottom-px [&>button[data-active=true]]:after:h-[2px] " +
  "[&>button[data-active=true]]:after:rounded-t-[2px] [&>button[data-active=true]]:after:bg-[#2764e7] " +
  "[&>button[data-active=true]]:after:content-['']";

/* ── 选项列表（模型 / 节点） ──────────────────────────────────────────── */

/** `.agent-model-options`：两列选项网格（≤759 单列，短视口 210px 上限）。 */
export const MODEL_OPTIONS =
  "grid max-h-[310px] grid-cols-[repeat(2,minmax(0,1fr))] gap-2 overflow-y-auto " +
  "[@media(max-width:759px)]:grid-cols-1 [@media(min-width:760px)_and_(max-height:700px)]:max-h-[210px]";
/** `.agent-node-list`：单列选项网格（短视口 210px 上限）。 */
export const NODE_LIST =
  "grid max-h-[310px] grid-cols-1 gap-[6px] overflow-y-auto [@media(min-width:760px)_and_(max-height:700px)]:max-h-[210px]";
/** 选项行公共外观（模型 32/16 列、节点 34/18 列，由调用点补 `grid-cols-*`）。 */
export const OPTION_ROW =
  "grid min-h-[52px] items-center gap-2 border border-[#e0e6ef] rounded-[10px] bg-[#fff] px-[9px] py-2 text-left " +
  "text-[#526179] [&:disabled]:cursor-not-allowed [&:disabled]:opacity-[0.58]";
/** 选项行：选中态。 */
export const OPTION_ROW_SELECTED = "border-[#8fb2ee] bg-[#f3f7ff]";
/** 选项行：不可用态。 */
export const OPTION_ROW_UNAVAILABLE = "border-[#ead9bc] bg-[#fffaf1] text-[#755d3b]";
/** 选项行：选中且禁用（值来自 `.is-selected:disabled` 与 `:has([data-slot=checkbox]:disabled)`）。 */
export const OPTION_ROW_SELECTED_DISABLED = "border-[#b8ccef] bg-[#f3f7ff] opacity-[0.78]";
/** 选项图标底（30px，图标 18px）。 */
export const OPTION_ICON =
  "flex size-[30px] items-center justify-center overflow-hidden rounded-lg bg-[#eaf2ff] text-[#3269ce] " +
  "[&>svg]:size-[18px] [&>svg]:shrink-0";
/** 选项文案：标题最多两行 13px，说明单行 11px。 */
export const OPTION_COPY =
  "flex min-w-0 flex-col gap-[2px] " +
  "[&>strong]:line-clamp-2 [&>strong]:text-[13px] [&>strong]:leading-[1.35] [&>strong]:text-[#31425d] " +
  "[&>strong]:[overflow-wrap:anywhere] " +
  "[&>small]:overflow-hidden [&>small]:text-ellipsis [&>small]:whitespace-nowrap [&>small]:text-[11px] [&>small]:text-[#8995a7]";
/** 选项尾部的环形勾选标记（16px，勾 10px）。 */
export const OPTION_CHECK =
  "flex size-4 flex-none items-center justify-center overflow-hidden rounded-full border border-[#d2dae5] " +
  "bg-[#fff] text-[#fff] leading-[0] [&>svg]:block [&>svg]:size-[10px] [&>svg]:shrink-0 [&>svg]:[stroke-width:2.5]";
/** 勾选标记：选中态。 */
export const OPTION_CHECK_SELECTED = "border-[#2764e7] bg-[#2764e7]";
/** 选项行尾部徽标（成本/范围）。 */
export const OPTION_BADGE = "text-[10px] not-italic whitespace-nowrap text-[#6d7d94]";
/** 选项行不可用时的说明色（`.is-unavailable .agent-model-options__copy small`）。 */
export const OPTION_COPY_HINT_UNAVAILABLE = "text-[#93651f]";

/* ── 单选器（single picker）与资源选择器 ──────────────────────────────── */

/** `.agent-single-picker-toolbar`：搜索条。 */
export const SINGLE_PICKER_TOOLBAR =
  "flex min-h-[38px] items-center gap-[10px] mb-[7px] border border-[#e0e6ef] rounded-[9px] bg-[#fff] px-[10px] py-0 " +
  "[&>label]:flex [&>label]:min-w-0 [&>label]:flex-1 [&>label]:items-center [&>label]:gap-[7px] [&>label]:text-[#8b98aa] " +
  "[&>span]:text-[11px] [&>span]:whitespace-nowrap [&>span]:text-[#8794a7] [&>svg]:w-[13px] [&>svg]:flex-none [&>svg]:basis-[13px]";
/** `.agent-single-picker-current`：当前选择条（≤759 两列；不可用态见下）。 */
export const SINGLE_PICKER_CURRENT =
  "grid min-h-9 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-[7px] mb-[7px] rounded-lg bg-[#f1f6ff] px-[9px] py-[6px] " +
  "text-[11px] text-[#54709e] " +
  "[&>strong]:text-[14px] [&>strong]:[font-weight:680] [&>strong]:text-[#285bb6] " +
  "[&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap [&_span]:text-[#8090a7] " +
  "[@media(max-width:759px)]:grid-cols-[auto_1fr] [@media(max-width:759px)]:[&_span]:col-span-full";
/** `.agent-single-picker-current.is-unavailable`：不可用态（含描边与标题色）。 */
export const SINGLE_PICKER_CURRENT_UNAVAILABLE =
  "bg-[#fff7e8] text-[#8a5a16] shadow-[inset_0_0_0_1px_#ead2aa] " + "[&>strong]:text-[#805615] [&_span]:text-[#805615]";
/** `.agent-resource-picker`：资源选择器外壳。 */
export const PICKER = "overflow-hidden border border-[#e0e6ef] rounded-xl bg-[#fff]";
/** `.agent-resource-picker__selected`：已选区（116px 说明列；760–1119 收窄并隐藏小注）。 */
const PICKER_NARROW = "@media(min-width:760px)_and_(max-width:1119px)";
export const PICKER_SELECTED =
  "grid min-h-16 grid-cols-[116px_minmax(0,1fr)] items-center gap-3 border-b border-[#edf1f5] bg-[#f9fbfe] px-3 py-[10px] " +
  "[&>div:first-child]:flex [&>div:first-child]:min-w-0 [&>div:first-child]:flex-col [&>div:first-child]:gap-[3px] " +
  "[&_strong]:text-[13px] [&_strong]:text-[#34445d] [&_small]:text-[11px] [&_small]:text-[#98a3b4] " +
  `[${PICKER_NARROW}]:min-h-[46px] [${PICKER_NARROW}]:grid-cols-[82px_minmax(0,1fr)] [${PICKER_NARROW}]:gap-2 ` +
  `[${PICKER_NARROW}]:px-2 [${PICKER_NARROW}]:py-[6px] [${PICKER_NARROW}]:[&_small]:hidden`;
/** `.agent-resource-picker__chips`：已选 chip 区（容器本身是列，子 chip 才横排）。 */
export const PICKER_CHIPS =
  "flex min-w-0 flex-col flex-wrap gap-[3px] [&>button]:flex [&>button]:h-[25px] [&>button]:items-center " +
  "[&>button]:gap-[6px] [&>button]:border-0 [&>button]:rounded-[7px] [&>button]:bg-[#eaf2ff] [&>button]:px-2 [&>button]:py-0 " +
  "[&>button]:text-[13px] [&>button]:text-[#265bbd] [&>button>svg]:w-[11px]";
/** chip：不可用态（含 hover）。 */
export const PICKER_CHIP_UNAVAILABLE =
  "border border-[#e4bf84] bg-[#fff7e8] text-[#8a5a16] " +
  "[&:hover:not(:disabled)]:bg-[#ffedca] [&:hover:not(:disabled)]:text-[#754608]";
/** `.agent-resource-picker__copy`：列表项文案列。 */
export const PICKER_COPY = "flex min-w-0 flex-col gap-[3px]";
/** `.agent-resource-picker__empty`：空态文案。 */
export const PICKER_EMPTY = "text-[11px]";
/** `.agent-resource-picker__search`：搜索行（39px 高）。 */
export const PICKER_SEARCH =
  "flex h-[39px] items-center gap-2 border-b border-[#edf1f5] px-3 py-0 text-[#8a97aa] " +
  "[&>svg]:w-[13px] [&>svg]:flex-none [&>svg]:basis-[13px] [&>kbd]:rounded-[5px] [&>kbd]:bg-[#f2f5f8] [&>kbd]:px-[5px] [&>kbd]:py-[2px] " +
  "[&>kbd]:text-[10px] [&>kbd]:text-[#9aa5b6] " +
  `[${PICKER_NARROW}]:h-8 [${PICKER_NARROW}]:px-2`;
/** `.agent-resource-picker__list`：结果列表（282px 上限；短视口 210px）。 */
export const PICKER_LIST =
  "grid max-h-[282px] gap-[3px] p-[5px] overflow-y-auto " +
  // 宽度档与高度档必须互斥：760–1119 的 180px 覆盖短视口的 210px（源里后者在前，故宽度档更晚生效）。
  `[${PICKER_NARROW}]:max-h-[180px] [${PICKER_NARROW}]:p-[3px] [${PICKER_NARROW}]:[&_small]:max-w-[24ch] ` +
  "[@media(min-width:1400px)_and_(max-height:700px)]:max-h-[210px] " +
  "[@media(min-width:1120px)_and_(max-width:1399px)_and_(max-height:700px)]:max-h-[210px]";
/** 列表行外观（label；选中/不可用/禁用见下）。 */
export const PICKER_ROW =
  "grid min-h-[53px] grid-cols-[minmax(0,1fr)_21px] items-center gap-2 border border-transparent rounded-lg " +
  "bg-transparent px-[9px] py-[7px] text-left text-[#42526a] " +
  "[&:hover]:border-[#d5e3fb] [&:hover]:bg-[#f4f8ff] " +
  "[&:has([data-slot=checkbox]:disabled)]:cursor-not-allowed [&:has([data-slot=checkbox]:disabled)]:opacity-[0.58] " +
  `[${PICKER_NARROW}]:min-h-10 [${PICKER_NARROW}]:px-[6px] [${PICKER_NARROW}]:py-1`;
/** 列表行：选中态。 */
export const PICKER_ROW_SELECTED = "border-[#d5e3fb] bg-[#f4f8ff]";
/** 列表行：不可用态。 */
export const PICKER_ROW_UNAVAILABLE = "border-[#ead9bc] bg-[#fffaf1] text-[#755d3b] [&_small]:text-[#93651f]";
/** 列表行：选中且禁用。 */
export const PICKER_ROW_SELECTED_DISABLED = "border-[#b8ccef] bg-[#f3f7ff] opacity-[0.78]";
/** 列表行图标（有图标时列位 32/21）。 */
export const PICKER_ROW_WITH_ICON = "grid-cols-[32px_minmax(0,1fr)_21px]";
/** 列表行图标底。 */
export const PICKER_ICON =
  "grid size-[30px] place-items-center rounded-lg bg-[#eaf2ff] text-[#3168c9] [&>svg]:w-[14px]";
/** 列表行标题 / 说明 / 徽标。 */
export const PICKER_ROW_TITLE = "text-[13px] [font-weight:680]";
/** 列表行说明。 */
export const PICKER_ROW_HINT = "overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[#8b98aa]";
/** 列表行范围徽标。 */
export const PICKER_ROW_BADGE =
  "rounded-full bg-[#f0f3f7] px-[6px] py-[3px] text-[10px] not-italic whitespace-nowrap text-[#728199]";
/** 列表空态段落。 */
export const PICKER_LIST_EMPTY = "m-0 px-[10px] py-8 text-center text-[11px] text-[#909cae]";
/** 列表内 Checkbox（ui-components 组件，需 `!`）。 */
export const PICKER_CHECKBOX =
  "!size-[18px] !rounded-[5px] !border-[#cbd5e1] !shadow-none [&>svg]:size-3 " +
  "[&:focus-visible]:!border-[#2764e7] [&:focus-visible]:!shadow-[0_0_0_3px_rgb(39_100_231_/_16%)]";
/** 列表内 Checkbox 选中态。 */
export const PICKER_CHECKBOX_CHECKED = "!border-[#2764e7] !bg-[#2764e7]";
/** `.agent-retrieval-options .agent-editor-field`（knowledge.css 的规则，落在 B 的字段类上，故由 B 接手）。 */
export const RETRIEVAL_OPTIONS_FIELDS =
  "[&>label]:grid [&>label]:grid-cols-[minmax(0,1fr)_auto] [&>label]:items-center [&>label]:gap-[10px] " +
  "[&>label]:border-t [&>label]:border-[#edf1f5] [&>label]:pt-[9px]";
/** `#agent-editor-default-namespaces` 的 760–1119 覆盖。 */
export const DEFAULT_NAMESPACES_TEXTAREA = "[@media(min-width:760px)_and_(max-width:1119px)]:min-h-[72px]";

/* ── 分页（类名属 C 的 library.css，声明来自 B 的 form-responsive.css，故由 B 先落地） ── */

/** `.agent-editor-pagination`：底部翻页条（34px 高，上分隔线）。 */
export const PAGINATION =
  "flex min-h-[34px] items-center justify-between gap-[10px] border-t border-[#edf1f5] px-2 py-0 text-[11px] text-[#8996a8]";
/** `.agent-editor-pagination > div`：翻页按钮组。 */
export const PAGINATION_GROUP = "flex items-center gap-[6px]";
/** `.agent-editor-pagination button`：24×22 方形按钮（禁用态降透明度）。 */
export const PAGINATION_BUTTON =
  "grid h-[22px] w-6 place-items-center border border-[#dde4ed] rounded-md bg-[#fff] text-[#62738b] " +
  "[&:disabled]:cursor-default [&:disabled]:opacity-35 [&>svg]:w-[11px]";
/** `.agent-editor-pagination strong`：页码。 */
export const PAGINATION_COUNT = "min-w-9 text-center text-[#53647b]";
/** `.agent-editor-root .agent-editor-library-picker`（C 的类名）在 760–1119 收窄左列。 */
export const LIBRARY_PICKER_NARROW = `[${PICKER_NARROW}]:grid-cols-[110px_minmax(0,1fr)]`;
/** `.agent-editor-root .agent-editor-group-filter button`（C 的类名）在 760–1119 收横向内边距。 */
export const GROUP_FILTER_NARROW = `[${PICKER_NARROW}]:[&>button]:px-[6px]`;
