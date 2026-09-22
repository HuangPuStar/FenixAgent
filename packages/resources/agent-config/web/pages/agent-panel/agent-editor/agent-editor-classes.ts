/**
 * 「新建 Agent」面板的 Tailwind 类串常量（A2 迁移：`agent-editor.css` + `-design.css` + `-responsive.css`）。
 *
 * 为什么集中在这里：同一个视觉构件会在多处渲染（面板外壳同时用于桌面 `<section>` 与移动端 `SheetContent`；
 * 三栏工作区/左栏导航/中栏内容/右栏汇总/页脚在加载壳与完成态各渲染一次）。类串写两份必然漂移，而源 CSS 里
 * 它们本来就是同一个选择器——集中一处才是等价表达。
 *
 * 命名口径：常量名对应源选择器去掉 `agent-editor-` 前缀后的语义；注释里标出各断点/层级的来源，便于与
 * `/tmp/agent-editor-effective-spec.md` 的生效值逐条核对。
 *
 * 媒体查询写法：base 工具类总在媒体变体之前生成，因此「base vs 变体」的冲突是安全的；但**变体之间**若条件
 * 有重叠，胜负就落到生成顺序上（不可控）。所以凡同一属性有多个断点覆盖的（内容区内边距、分区说明块下边距），
 * 一律写成互斥条件的组合。
 */

/** 面板外壳：`gap:0 / overflow:hidden / padding:0`（描边色、底色、阴影由 `.agent-editor-panel` 决定）。 */
export const PANEL_SHELL = "gap-0 overflow-hidden p-0";
/** 桌面：绝对定位，宽 `min(1180px, 100% - 24px)`，四周留 12px；圆角/描边/底色/阴影取 design 层生效值。 */
export const PANEL_DESKTOP =
  "absolute z-40 top-3 right-auto bottom-3 left-3 h-auto w-[min(1180px,calc(100%-24px))] max-w-none " +
  "border border-[#dfe5ee] rounded-[14px] text-[#18243d] bg-[#f7f9fc] " +
  "shadow-[0_18px_48px_rgb(29_64_126_/_14%),0_2px_8px_rgb(29_64_126_/_8%)]";
/** 移动端 SheetContent：覆盖组件自带的定位/尺寸/圆角/底色等，再叠上面板基座（阴影取 design 层生效值）。 */
export const PANEL_SHEET =
  "!fixed !inset-0 !z-40 !h-dvh !w-screen !max-w-none !border-0 !rounded-none !gap-0 !overflow-hidden !p-0 " +
  "!text-[#18243d] !bg-[#f7f9fc] !shadow-[0_18px_48px_rgb(29_64_126_/_14%),0_2px_8px_rgb(29_64_126_/_8%)]";
/** 编辑器根：列布局 + 面板内表单控件继承字体（源里 `font-family: inherit` 的组选择器）。 */
export const EDITOR_ROOT =
  "flex h-full min-h-0 flex-col [font-family:inherit] [&_button]:[font-family:inherit] [&_input]:[font-family:inherit] [&_textarea]:[font-family:inherit]";
/** 三栏工作区（纯 DOM 载体）：设计层 216/430/216，760–1399 与 760–1119 各一套窄桌面列宽，≤759 纵向 flex。 */
export const WORKSPACE =
  "grid min-h-0 flex-1 grid-cols-[216px_minmax(430px,1fr)_216px] overflow-hidden " +
  "[@media(min-width:1120px)and(max-width:1399px)]:grid-cols-[168px_minmax(360px,1fr)_220px] " +
  "[@media(min-width:760px)and(max-width:1119px)]:grid-cols-[148px_minmax(280px,1fr)_190px] " +
  "[@media(max-width:759px)]:flex [@media(max-width:759px)]:flex-col";
/** 三栏工作区（Tabs 根节点）：同上，但需 `!` 压过组件的 `display:flex`。 */
export const WORKSPACE_TABS =
  "!grid min-h-0 flex-1 grid-cols-[216px_minmax(430px,1fr)_216px] overflow-hidden " +
  "[@media(min-width:1120px)and(max-width:1399px)]:grid-cols-[168px_minmax(360px,1fr)_220px] " +
  "[@media(min-width:760px)and(max-width:1119px)]:grid-cols-[148px_minmax(280px,1fr)_190px] " +
  "[@media(max-width:759px)]:!flex [@media(max-width:759px)]:!flex-col";
/** 左栏导航：列布局 + 右分隔线；≤759 变成横向滚动条带。 */
export const CONFIG_MAP =
  "flex min-h-0 flex-col overflow-y-auto overscroll-contain border-r border-[#e8edf4] bg-[#fbfcfe] px-2 pt-[10px] pb-2 " +
  "[@media(min-width:1120px)and(max-width:1399px)]:px-[7px] [@media(min-width:1120px)and(max-width:1399px)]:pt-2 [@media(min-width:1120px)and(max-width:1399px)]:pb-[7px] " +
  "[@media(min-width:760px)and(max-width:1119px)]:px-[6px] [@media(min-width:760px)and(max-width:1119px)]:pt-2 [@media(min-width:760px)and(max-width:1119px)]:pb-[7px] " +
  "[@media(max-width:759px)]:flex-none [@media(max-width:759px)]:overflow-x-auto [@media(max-width:759px)]:overflow-y-hidden " +
  "[@media(max-width:759px)]:border-r-0 [@media(max-width:759px)]:border-b [@media(max-width:759px)]:px-2 [@media(max-width:759px)]:py-[6px]";
/** 导航分组标签：design 层 10px/0.14em/#9aa5b6，≤759 隐藏。 */
export const MAP_LABEL =
  "px-2 pt-0 pb-[5px] text-[10px] [font-weight:700] tracking-[0.14em] text-[#9aa5b6] [@media(max-width:759px)]:hidden";
/** 导航列表（TabsList）：design 层改 grid 并撑满；≤759 只收窄宽度（`flex-direction` 在 grid 容器里不生效，按源保留）。 */
export const MAP_TABS_LIST =
  "!grid !h-auto !w-full [align-content:start] !justify-stretch !gap-[3px] !border-0 !bg-transparent !p-0 " +
  "[@media(max-width:759px)]:!w-max [@media(max-width:759px)]:flex-row";
/** 导航条目（TabsTrigger）：design 层 58px 高 / 32px 图标列 / 11px 圆角 / 9px×7px 内边距 / #56657c；含选中态与左侧指示条。 */
export const MAP_TRIGGER =
  "group/maprow !relative !grid !w-full !min-h-[58px] !grid-cols-[32px_minmax(0,1fr)_auto] !items-center " +
  "!justify-stretch !gap-[10px] !rounded-[11px] !border-0 !bg-transparent !px-[9px] !py-[7px] !text-left !text-[#56657c] " +
  "data-[state=active]:!bg-[#eaf2ff] data-[state=active]:!text-[#174aa9] " +
  "data-[state=active]:before:absolute data-[state=active]:before:-left-2 data-[state=active]:before:h-6 " +
  "data-[state=active]:before:w-[3px] data-[state=active]:before:rounded-r-[3px] data-[state=active]:before:bg-[#2764e7] " +
  "data-[state=active]:before:content-[''] " +
  "[@media(min-width:1120px)and(max-width:1399px)]:!min-h-[44px] [@media(min-width:1120px)and(max-width:1399px)]:!grid-cols-[26px_minmax(0,1fr)_auto] " +
  "[@media(min-width:1120px)and(max-width:1399px)]:!gap-[7px] [@media(min-width:1120px)and(max-width:1399px)]:!px-[7px] [@media(min-width:1120px)and(max-width:1399px)]:!py-[4px] " +
  "[@media(min-width:760px)and(max-width:1119px)]:!min-h-[44px] [@media(min-width:760px)and(max-width:1119px)]:!grid-cols-[24px_minmax(0,1fr)] " +
  "[@media(min-width:760px)and(max-width:1119px)]:!gap-[7px] [@media(min-width:760px)and(max-width:1119px)]:!px-[6px] [@media(min-width:760px)and(max-width:1119px)]:!py-[4px] " +
  "[@media(max-width:759px)]:!w-[136px] [@media(max-width:759px)]:!min-h-[42px]";
/** 导航图标底：32px（760–1399 压到 26px）；选中行里变白底蓝字（父级 `group/maprow`）。 */
export const MAP_ICON =
  "grid size-8 place-items-center rounded-[9px] bg-[#f0f3f7] text-[#71819a] [&>svg]:w-[14px] " +
  "[@media(min-width:760px)and(max-width:1399px)]:size-[26px] " +
  "group-data-[state=active]/maprow:bg-[#fff] group-data-[state=active]/maprow:text-[#2764e7]";
/** 导航条目状态徽标：10px；760–1119 与 ≤759 隐藏。 */
export const MAP_BADGE =
  "text-[10px] [font-weight:400] not-italic text-[#929daf] " +
  "[@media(min-width:760px)and(max-width:1119px)]:hidden [@media(max-width:759px)]:hidden";
/** 导航条目文案：标题继承行色（design 层 `color: inherit`），说明固定 #8d99ab。 */
export const MAP_COPY =
  "flex min-w-0 flex-col [&>strong]:text-[13px] [&>strong]:[font-weight:680] [&>strong]:leading-[1.35] " +
  "[&>small]:overflow-hidden [&>small]:text-ellipsis [&>small]:whitespace-nowrap [&>small]:text-[11px] " +
  "[&>small]:[font-weight:400] [&>small]:leading-[1.35] [&>small]:text-[#8d99ab] [@media(min-width:760px)and(max-width:1119px)]:[&>small]:hidden";
/** 中栏内容区：白底 + 内边距按「宽度档 × 高度档」互斥条件（避免同属性多值看生成顺序）。 */
export const CONTENT =
  "overflow-x-hidden bg-[#fff] [padding:16px_20px_20px] " +
  "[@media(min-width:1120px)and(max-width:1399px)and(min-height:701px)]:[padding:14px_18px_16px] " +
  "[@media(min-width:760px)and(max-width:1119px)and(min-height:701px)]:[padding:14px_12px_16px] " +
  "[@media(min-width:1400px)and(max-height:700px)]:[padding:12px_20px_14px] " +
  "[@media(min-width:1120px)and(max-width:1399px)and(max-height:700px)]:[padding:12px_18px_14px] " +
  "[@media(min-width:760px)and(max-width:1119px)and(max-height:700px)]:[padding:12px_12px_14px] " +
  "[@media(max-width:759px)]:flex-1 [@media(max-width:759px)]:[padding:14px]";
/** 右栏汇总：左分隔线 + 淡径向渐变底。 */
export const SUMMARY_ASIDE =
  "min-h-0 overflow-y-auto overscroll-contain border-l border-[#e5ebf3] bg-[#f7f9fc] " +
  "bg-[radial-gradient(circle_at_90%_0%,rgb(50_108_221_/_8%),transparent_36%)] px-[12px] pt-[16px] pb-[14px] " +
  "[@media(min-width:1120px)and(max-width:1399px)]:[padding:12px_10px_10px] " +
  "[@media(min-width:760px)and(max-width:1119px)]:[padding:10px_8px_8px] " +
  "[@media(min-width:760px)and(max-width:1119px)]:block";
/** 页脚：上分隔线 + 阴影；≤759 改纵向并留 safe-area 下边距。 */
export const FOOTER =
  "relative z-[4] flex flex-none items-center justify-between gap-[10px] border-t border-[#e5eaf1] " +
  "bg-[rgb(255_255_255_/_97%)] shadow-[0_-10px_30px_rgb(31_54_91_/_4%)] basis-[56px] min-h-[56px] py-0 pl-[18px] pr-[14px] " +
  "[@media(min-width:760px)and(max-width:1399px)]:basis-[52px] [@media(min-width:760px)and(max-width:1399px)]:min-h-[52px] " +
  "[@media(max-width:759px)]:flex-col [@media(max-width:759px)]:items-stretch [@media(max-width:759px)]:px-[12px] " +
  "[@media(max-width:759px)]:pt-[9px] [@media(max-width:759px)]:pb-[max(12px,env(safe-area-inset-bottom))]";
/** 页脚状态块：28px 圆角数字格 + 标题/说明两行。 */
export const FOOTER_STATE =
  "flex min-w-0 items-center gap-[9px] " +
  "[&_span]:grid [&_span]:size-7 [&_span]:flex-none [&_span]:basis-7 [&_span]:place-items-center [&_span]:rounded-[9px] " +
  "[&_span]:bg-[#eaf2ff] [&_span]:text-[13px] [&_span]:[font-weight:750] [&_span]:text-[#245bbf] " +
  "[&_p]:m-0 [&_p]:flex [&_p]:flex-col [&_p]:gap-[2px] " +
  "[&_strong]:text-[13px] [&_strong]:text-[#3a4a62] [&_small]:text-[11px] [&_small]:text-[#95a0b0]";
/** 页脚按钮组：32px 高 / 9px 圆角 / 11px 横内边距 / 13px（760–1399 收到 30px 高）。 */
export const FOOTER_ACTIONS =
  "flex items-center gap-[7px] ml-auto " +
  "[&>[data-slot=button]]:!h-8 [&>[data-slot=button]]:!rounded-[9px] [&>[data-slot=button]]:!px-[11px] [&>[data-slot=button]]:!text-[13px] " +
  "[@media(min-width:760px)and(max-width:1399px)]:[&>[data-slot=button]]:!h-[30px]";
/** 只读 / 资源失败提示条：共用 1px 下分隔线 + 8px×18px 内边距 + 11px 字号。 */
export const NOTICE_BAR = "border-b border-border-subtle px-[18px] py-2 text-[11px]";
/** 加载失败态：居中列 + 300px 最小高度。 */
export const ERROR_STATE =
  "flex h-full min-h-[300px] flex-col items-center justify-center gap-[10px] p-6 text-center text-text-muted " +
  "[&>p]:max-w-[480px] [&>p]:text-[11px] [&>strong]:text-[14px]";
/** 分区说明块：底部间距在 760–1399 收到 20px、短视口（≤700h）收到 12px（互斥条件组合）。 */
export const SECTION_INTRO =
  "mb-[26px] [@media(min-width:1120px)and(max-width:1399px)and(min-height:701px)]:mb-[20px] " +
  "[@media(min-width:760px)and(max-width:1119px)and(min-height:701px)]:mb-[20px] " +
  "[@media(min-width:760px)and(max-height:700px)]:mb-[12px]";
/** 分区容器：720px 居中 + 入场动画（关键帧留在 `agent-editor-retained.css`，工具类只能按名引用）。 */
export const SECTION = "w-[min(720px,100%)] mx-auto p-0 animate-[agent-editor-section-enter_180ms_ease_both]";
/** 加载壳导航行：与 `agent-editor-map [data-slot="tabs-trigger"]` 的骨架行高/列宽同构（46px / 27px 图标列）。 */
export const LOADING_MAP_ROW =
  "grid min-h-[46px] grid-cols-[27px_minmax(0,1fr)] items-center gap-2 rounded-[11px] px-2 py-[5px] text-[#56657c]";
/** 加载壳选中态行：颜色与底色覆盖基行（twMerge 保留后者）。 */
export const LOADING_MAP_ROW_ACTIVE = "text-[#174aa9] bg-[#eaf2ff]";
