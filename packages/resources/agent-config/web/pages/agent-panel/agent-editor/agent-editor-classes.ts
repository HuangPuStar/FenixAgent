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
 * 深层样式（子代选择器、复合值、手写媒体查询）在同目录 `agent-editor-classes.css`：类串里只留扁平工具类，
 * 需要选择器层级或 `[@media(...)]` 才能表达的声明按常量分节写在那份样式表里（类名与本节注释逐条对应）。
 *
 * 媒体查询写法：base 工具类总在媒体变体之前生成，因此「base vs 变体」的冲突是安全的；但**变体之间**若条件
 * 有重叠，胜负就落到生成顺序上（不可控）。所以凡同一属性有多个断点覆盖的（内容区内边距、分区说明块下边距），
 * 一律写成互斥条件的组合——这几条已在 CSS 侧，由同名样式表按类串里的书写顺序落成媒体查询。
 */
import "./agent-editor-classes.css";

/** 面板外壳：`gap:0 / overflow:hidden / padding:0`（描边色、底色、阴影由 `.agent-editor-panel` 决定）。 */
export const PANEL_SHELL = "gap-0 overflow-hidden p-0";
/**
 * 桌面：绝对定位，四周留 12px；圆角/描边/底色取 design 层生效值。
 * 宽度 `min(1180px, calc(100% - 24px))`、阴影与「高度上限 = 视口高 − 上下内缩」见
 * `agent-editor-classes.css` 的 `.agent-editor-panel`（该类名同时是 `AgentFormDialog` 焦点恢复选择器
 * `.agent-editor-panel[role='dialog']` 的钩子）。**高度取自 portal 宿主盒子**（`top-3` + `bottom-3`），
 * 所以宿主必须撑满可视区，由调用方保证（见 `pages/AgentManagementPage.tsx` 渲染处注释）。
 */
export const PANEL_DESKTOP =
  "agent-editor-panel absolute z-40 top-3 right-auto bottom-3 left-3 h-auto max-w-none " +
  "border border-slate-200 rounded-lg text-slate-800 bg-slate-50";
/** 移动端 SheetContent：覆盖组件自带的定位/尺寸/圆角/底色等，再叠上面板基座（阴影与桌面同源，见同名 CSS）。 */
export const PANEL_SHEET =
  "agent-editor-mobile !fixed !inset-0 !z-40 !h-dvh !w-screen !max-w-none !border-0 !rounded-none !gap-0 !overflow-hidden !p-0 " +
  "!text-slate-800 !bg-slate-50";
/** 编辑器根：列布局 + 面板内表单控件继承字体（源里 `font-family: inherit` 的组选择器整组在 CSS 侧）。 */
export const EDITOR_ROOT = "agent-editor-root flex h-full min-h-0 flex-col";
/** 三栏工作区（纯 DOM 载体）：≤759 纵向 flex；三段列宽（216/430/216 与两段窄桌面）见同名 CSS。 */
export const WORKSPACE = "agent-editor-workspace grid min-h-0 flex-1 overflow-hidden max-md:flex max-md:flex-col";
/** 三栏工作区（Tabs 根节点）：同上，但需 `!` 压过组件的 `display:flex`。 */
export const WORKSPACE_TABS =
  "agent-editor-workspace !grid min-h-0 flex-1 overflow-hidden max-md:!flex max-md:!flex-col";
/** 左栏导航：列布局 + 右分隔线；≤759 变成横向滚动条带。 */
export const CONFIG_MAP =
  "flex min-h-0 flex-col overflow-y-auto overscroll-contain border-r border-slate-200 bg-gray-50 px-2 pt-2.5 pb-2 " +
  "lg:max-2xl:px-1.75 lg:max-2xl:pt-2 lg:max-2xl:pb-1.75 " +
  "md:max-lg:px-1.5 md:max-lg:pt-2 md:max-lg:pb-1.75 " +
  "max-md:flex-none max-md:overflow-x-auto max-md:overflow-y-hidden " +
  "max-md:border-r-0 max-md:border-b max-md:px-2 max-md:py-1.5";
/** 导航分组标签：design 层 10px/0.14em/#9aa5b6，≤759 隐藏。 */
export const MAP_LABEL = "px-2 pt-0 pb-1.25 text-3xs [font-weight:700] tracking-widest text-gray-400 max-md:hidden";
/** 导航列表（TabsList）：design 层改 grid 并撑满；≤759 只收窄宽度（`flex-direction` 在 grid 容器里不生效，按源保留）。 */
export const MAP_TABS_LIST =
  "!grid !h-auto !w-full [align-content:start] !justify-stretch !gap-0.75 !border-0 !bg-transparent !p-0 " +
  "max-md:!w-max max-md:flex-row";
/** 导航条目（TabsTrigger）：design 层 58px 高 / 9px×7px 内边距 / #56657c；列定义与窄桌面覆盖见同名 CSS。 */
export const MAP_TRIGGER =
  "agent-editor-map-trigger group/maprow !relative !grid !w-full !min-h-14.5 !items-center " +
  "!justify-stretch !gap-2.5 !rounded-lg !border-0 !bg-transparent !px-2.25 !py-1.75 !text-left !text-gray-500 " +
  "data-[state=active]:!bg-indigo-50 data-[state=active]:!text-blue-800 " +
  "data-[state=active]:before:absolute data-[state=active]:before:-left-2 data-[state=active]:before:h-6 " +
  "data-[state=active]:before:w-0.75 data-[state=active]:before:rounded-r-xs data-[state=active]:before:bg-blue-600 " +
  "data-[state=active]:before:content-[''] " +
  "lg:max-2xl:!min-h-11 lg:max-2xl:!gap-1.75 lg:max-2xl:!px-1.75 lg:max-2xl:!py-1 " +
  "md:max-lg:!min-h-11 md:max-lg:!gap-1.75 md:max-lg:!px-1.5 md:max-lg:!py-1 " +
  "max-md:!w-34 max-md:!min-h-10.5";
/** 导航图标底：32px（760–1399 压到 26px）；选中行里变白底蓝字（父级 `group/maprow`）；图标 14px 见同名 CSS。 */
export const MAP_ICON =
  "agent-editor-map-icon grid size-8 place-items-center rounded-md bg-slate-100 text-slate-500 " +
  "md:max-2xl:size-6.5 " +
  "group-data-[state=active]/maprow:bg-white group-data-[state=active]/maprow:text-blue-600";
/** 导航条目状态徽标：刻度与配色归 `ui/badge`（`variant="secondary"`），此处只保留两档窄桌面的隐藏。 */
export const MAP_BADGE = "md:max-lg:hidden max-md:hidden";
/**
 * 导航条目文案：标题继承行色（design 层 `color: inherit`），说明固定灰。
 * 标题/说明的字号、行高、字重与单行省略，以及 760–1119 隐藏说明，见同名 CSS 的
 * `.agent-editor-map-copy > strong / small`。
 */
export const MAP_COPY = "agent-editor-map-copy flex min-w-0 flex-col";
/**
 * 中栏内容区：白底。
 * 内边距按「宽度档 × 高度档」写成互斥条件（避免同属性多值看生成顺序），整族已下沉到同名 CSS 的
 * `.agent-editor-content`，`≤759px` 的纵向伸缩仍由这里的 `max-md:flex-1` 表达。
 */
export const CONTENT = "agent-editor-content overflow-x-hidden bg-white max-md:flex-1";
/** 右栏汇总：左分隔线 + 淡径向渐变底（渐变见同名 CSS 的 `.agent-editor-summary`，底色由 `bg-slate-50` 提供）。 */
export const SUMMARY_ASIDE =
  "agent-editor-summary min-h-0 overflow-y-auto overscroll-contain border-l border-slate-200 bg-slate-50 " +
  "px-3 pt-4 pb-3.5 " +
  "lg:max-2xl:[padding:12px_10px_10px] " +
  "md:max-lg:[padding:10px_8px_8px] " +
  "md:max-lg:block";
/** 页脚：上分隔线；≤759 改纵向并留 safe-area 下边距（上方投影与 safe-area 下边距见同名 CSS）。 */
export const FOOTER =
  "agent-editor-footer relative z-[4] flex flex-none items-center justify-between gap-2.5 border-t border-slate-200 " +
  "bg-white/97 basis-14 min-h-14 py-0 pl-4.5 pr-3.5 " +
  "md:max-2xl:basis-13 md:max-2xl:min-h-13 " +
  "max-md:flex-col max-md:items-stretch max-md:px-3 " +
  "max-md:pt-2.25";
/** 页脚状态块：28px 圆角数字格 + 标题/说明两行（两条子规则的声明见同名 CSS）。 */
export const FOOTER_STATE = "agent-editor-footer__state flex min-w-0 items-center gap-2.25";
/** 页脚按钮组：32px 高 / 9px 圆角 / 11px 横内边距 / 13px（760–1399 收到 30px 高）。 */
export const FOOTER_ACTIONS =
  "flex items-center gap-1.75 ml-auto " +
  "[&>[data-slot=button]]:!h-8 [&>[data-slot=button]]:!rounded-md [&>[data-slot=button]]:!px-2.75 [&>[data-slot=button]]:!text-xs " +
  "md:max-2xl:[&>[data-slot=button]]:!h-7.5";
/** 只读 / 资源失败提示条：共用 1px 下分隔线 + 8px×18px 内边距 + 11px 字号。 */
export const NOTICE_BAR = "border-b border-border-subtle px-4.5 py-2 text-3xs";
/** 加载失败态容器定位：居中列 + 300px 最小高度。内容排版（图标 / 标题 / 说明 / 重试）归 `config/EmptyState`，
 * 原 `agent-editor-state` 语义类随其两条子代规则一起删除——已没有样式表定义它，留着只是空钩子。 */
export const ERROR_STATE =
  "flex h-full min-h-75 flex-col items-center justify-center gap-2.5 p-6 text-center text-text-muted";
/** 分区说明块：底部间距在 760–1399 收到 20px、短视口（≤700h）收到 12px（互斥条件组合，三段覆盖见同名 CSS）。 */
export const SECTION_INTRO = "agent-editor-section__intro mb-6.5";
/** 分区容器：720px 居中 + 入场动画（宽度与动画在同名 CSS；关键帧留在 `agent-editor-retained.css`）。 */
export const SECTION = "agent-editor-section mx-auto p-0";
/** 加载壳导航行：与左栏条目同构（46px 行高 / 27px 图标列，列定义见同名 CSS）。 */
export const LOADING_MAP_ROW =
  "agent-editor-loading-map-row grid min-h-11.5 items-center gap-2 rounded-lg px-2 py-1.25 text-gray-500";
/** 加载壳选中态行：颜色与底色覆盖基行（twMerge 保留后者）。 */
export const LOADING_MAP_ROW_ACTIVE = "text-blue-800 bg-indigo-50";
