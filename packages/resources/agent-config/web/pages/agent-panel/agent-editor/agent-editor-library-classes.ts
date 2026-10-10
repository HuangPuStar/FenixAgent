/**
 * 「新建 Agent」面板 C 片（资源库 / 知识区）的类串常量。
 *
 * 来源：`agent-editor-library.css`(96) + `agent-editor-knowledge.css`(161)。生效值口径见
 * `/tmp/agent-editor-effective-spec.md`；跨片契约（B 的 `PAGINATION*` / `LIBRARY_PICKER_NARROW` / `GROUP_FILTER_NARROW` /
 * `RETRIEVAL_OPTIONS_FIELDS`）已在 B 落地，这里只补 C 自己剩下的声明，并把两处状态钩子从类名改成 `data-*`。
 *
 * 深层选择器（子代、`:hover` / `:has()` 变体）、复合值与响应式覆盖：2026-09-28 第三波收口后，凡有挂载点的
 * 声明都已回到本文件与 `AgentKnowledgeSection.tsx` 的 `className`，同名 CSS 只剩三处**没有工具类覆盖**的
 * 列模板（来源按钮 / 知识区块头 / 记忆开关）、两条非标准字重与两个**列宽模板变量**。导出常量名保持不变。
 *
 * 需要被 `className` 覆盖的模板不下沉成 `grid-template-columns`，只下沉「值」（自定义属性），由类串用
 * `grid-cols-(--…)` 引用——伴随表**未分层**，写死的普通声明在层叠上恒压过 `@layer utilities`（`:where()`
 * 只压特指度，压不过层序）。2026-10-09 的缺陷正是这么来的：`:where(.agent-editor-library-picker)` 的 168px
 * 模板压死了平铺态的 `grid-cols-1`，单来源的技能 / MCP / Sites 列表被挤进 168px 左栏、右侧整片留白。
 * 窄屏收窄同理，它现在只改同一个变量的值（B 的 `LIBRARY_PICKER_NARROW`），窄屏下的平铺态也由工具类层裁决。
 */
import "./agent-editor-library-classes.css";

/* ── 来源导航（library） ───────────────────────────────────────────────── */

/** `.agent-editor-group-filter`：来源列表容器（窄桌面覆盖由 B 的 `GROUP_FILTER_NARROW` 提供）。 */
export const GROUP_FILTER = "flex min-w-0 flex-col gap-1.25 border-r border-gray-100 bg-slate-50 p-2";
/**
 * `.agent-editor-group-filter button`：来源按钮（40px 行 / 两列 + hover 配色）。
 * 列模板见同名 CSS；hover 的底色与文字色 2026-09-28 从该表撤回（`hover:bg-indigo-50` / `hover:text-blue-900`，
 * 变体特指度高于 `GROUP_FILTER_BUTTON_ACTIVE` 的基态类，选中项 hover 时仍以 hover 色为准，与撤回前一致）。
 */
export const GROUP_FILTER_BUTTON =
  "agent-editor-group-filter__button grid min-h-10 items-center gap-2 border-0 rounded-lg bg-transparent px-2.5 py-1.75 " +
  "text-left text-slate-500 hover:bg-indigo-50 hover:text-blue-900";
/** 来源按钮选中态（原 `button.is-active`）。 */
export const GROUP_FILTER_BUTTON_ACTIVE = "bg-indigo-50 text-blue-900";
/** 来源名：单行省略 13px/650。 */
export const GROUP_FILTER_LABEL = "overflow-hidden text-ellipsis whitespace-nowrap text-xs [font-weight:650]";
/* 来源计数徽标原是一条「24px 最小宽药丸」类串，已改用 `ui/badge`（`variant="secondary"`）：
 * 药丸几何、刻度与配色归库内，本处不再维护第三份定义。 */

/* ── 两层资源库（library） ─────────────────────────────────────────────── */

/** `.agent-editor-library-picker`：左来源栏 + 右结果区（250px 最小高在此，列宽模板见同名 CSS 的
 *  `--agent-editor-library-picker-columns`——值留 CSS、引用走工具类，平铺态才能真正覆盖，理由见文件头）。 */
export const LIBRARY_PICKER =
  "agent-editor-library-picker grid min-h-62.5 grid-cols-(--agent-editor-library-picker-columns) " +
  "overflow-hidden border border-slate-200 rounded-xl bg-white";
/** `.is-flat`：单来源时收成单列并去掉最小高（同层覆盖，twMerge 会丢掉上面的模板引用）。 */
export const LIBRARY_PICKER_FLAT = "min-h-0 grid-cols-1";
/** 资源选择器内嵌形态：外壳自己已有描边与圆角，内层不再重复。 */
export const LIBRARY_PICKER_EMBEDDED = "min-h-0 border-0 rounded-none";
/** `.agent-editor-library-picker__results`：结果区列容器。 */
export const LIBRARY_PICKER_RESULTS = "flex min-w-0 min-h-0 flex-col overflow-hidden p-2";
/** 资源选择器内嵌形态的结果区：上下内边距收到 4px。 */
export const LIBRARY_PICKER_RESULTS_EMBEDDED = "py-1";
/** 结果区里的分页：顶到容器底部（`margin-top:auto`）+ `padding: 8px 2px 0`。 */
export const PAGINATION_IN_RESULTS = "mt-auto px-0.5 pb-0 pt-2";
/** 资源选择器内嵌形态的分页：`margin-top: 0`（外层已是贴底布局）。 */
export const PAGINATION_EMBEDDED = "mt-0 px-0.5 pb-0 pt-2";

/* ── 知识区（knowledge） ──────────────────────────────────────────────── */

/** `.agent-knowledge-layout`：三块知识表面纵向排布。 */
export const KNOWLEDGE_LAYOUT = "grid gap-3.5";
/** `.agent-knowledge-block`：知识区块外壳。 */
export const KNOWLEDGE_BLOCK = "overflow-hidden border border-slate-200 rounded-xl bg-white";
/**
 * `.agent-knowledge-block__heading`：36px 图标列（列模板见同名 CSS）+ 标题/说明。
 * 图标格（`size-8.5` / `rounded-md` / `bg-indigo-50` / `text-sky-700`）、标题说明的字号与配色
 * 2026-09-28 全量撤回，落在 `AgentKnowledgeSection.tsx` 的 `<span>` / `<div>` / `<strong>` / `<small>` 上。
 * 标题 12px、说明 10px 是 `text-xs` / `text-3xs` 刻度的当前生效值；迁移前手写 CSS 记的是 13px / 11px，
 * 差异来自值刻度归一化（见 `agent-editor-font-scale.test.ts` 的 `editor-knowledge-heading` 锚点），
 * 本次只做搬运，不在这里改值。
 */
export const KNOWLEDGE_HEADING =
  "agent-knowledge-block__heading grid items-center gap-3 border-b border-gray-100 bg-slate-50 px-3.5 py-3";
/** `.agent-knowledge-block__body`：内容内边距。 */
export const KNOWLEDGE_BODY = "px-3 py-2.5";
/** `--bases` 形态：内容区不留内边距（选择器自带描边）。 */
export const KNOWLEDGE_BODY_BASES = "p-0";
/** `--bases` 形态：内嵌的资源选择器去描边去圆角（原 `.agent-knowledge-block--bases .agent-resource-picker`）。 */
export const KNOWLEDGE_BASES_PICKER = "border-0 rounded-none";

/** `.agent-knowledge-switch`：记忆开关行（64px 高、两列；列模板 36px 轨道列见同名 CSS）。
 * 行内开关本体是 `ui/switch`：hover 与选中态（Radix 挂在 Switch 上的 `data-state="checked"`）底色
 * 2026-09-28 从同名 CSS 撤回，`has-*` 变体与 `hover:` 变体都写在调用点可及之处。
 */
export const KNOWLEDGE_SWITCH =
  "agent-knowledge-switch grid min-h-16 w-full items-center gap-3.5 border-0 rounded-md bg-slate-50 " +
  "px-3 py-2.75 text-left text-slate-600 hover:bg-blue-50 has-[[data-state=checked]]:bg-blue-50";

/** `.agent-retrieval-fields`：两列（说明字段 + 选项列），≤1024px 单列；模板同样留在工具类层，理由见文件头。 */
export const RETRIEVAL_FIELDS =
  "agent-retrieval-fields grid items-start gap-3 grid-cols-(--agent-retrieval-fields-columns) max-lg:grid-cols-1";
/** `.agent-retrieval-options`：选项列（子字段的两列行由 B 的 `RETRIEVAL_OPTIONS_FIELDS` 提供）。 */
export const RETRIEVAL_OPTIONS = "grid gap-2.25";
/** `#agent-editor-default-namespaces`：默认命名空间文本域（92px 最小高、可纵向拉伸）。 */
export const DEFAULT_NAMESPACES = "min-h-23 resize-y";
