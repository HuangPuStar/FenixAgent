/**
 * 「新建 Agent」面板 C 片（资源库 / 知识区）的类串常量。
 *
 * 来源：`agent-editor-library.css`(96) + `agent-editor-knowledge.css`(161)。生效值口径见
 * `/tmp/agent-editor-effective-spec.md`；跨片契约（B 的 `PAGINATION*` / `LIBRARY_PICKER_NARROW` / `GROUP_FILTER_NARROW` /
 * `RETRIEVAL_OPTIONS_FIELDS`）已在 B 落地，这里只补 C 自己剩下的声明，并把两处状态钩子从类名改成 `data-*`。
 *
 * 深层选择器（子代、`:hover`）、复合值与响应式覆盖见同目录 `agent-editor-library-classes.css`；
 * 扁平工具类保留在此，导出常量名保持不变。
 */
import "./agent-editor-library-classes.css";

/* ── 来源导航（library） ───────────────────────────────────────────────── */

/** `.agent-editor-group-filter`：来源列表容器（窄桌面覆盖由 B 的 `GROUP_FILTER_NARROW` 提供）。 */
export const GROUP_FILTER = "flex min-w-0 flex-col gap-1.25 border-r border-gray-100 bg-slate-50 p-2";
/**
 * `.agent-editor-group-filter button`：来源按钮（40px 行 / 两列 + hover 配色见同名 CSS）。
 * 声明落到按钮自己的类名上，不再靠容器后代匹配：窄桌面覆盖（B 的 `GROUP_FILTER_NARROW`）仍走 `> button`。
 */
export const GROUP_FILTER_BUTTON =
  "agent-editor-group-filter__button grid min-h-10 items-center gap-2 border-0 rounded-lg bg-transparent px-2.5 py-1.75 " +
  "text-left text-slate-500";
/** 来源按钮选中态（原 `button.is-active`）。 */
export const GROUP_FILTER_BUTTON_ACTIVE = "bg-indigo-50 text-blue-900";
/** 来源名：单行省略 13px/650。 */
export const GROUP_FILTER_LABEL = "overflow-hidden text-ellipsis whitespace-nowrap text-xs [font-weight:650]";
/** 来源计数徽标：24px 最小宽的药丸。 */
export const GROUP_FILTER_COUNT =
  "min-w-6 rounded-full bg-white px-1.5 py-0.5 text-center text-3xs not-italic text-slate-500";

/* ── 两层资源库（library） ─────────────────────────────────────────────── */

/** `.agent-editor-library-picker`：左来源栏 + 右结果区（168px 左列的网格模板见同名 CSS，250px 最小高在此）。 */
export const LIBRARY_PICKER =
  "agent-editor-library-picker grid min-h-62.5 overflow-hidden border border-slate-200 rounded-xl bg-white";
/** `.is-flat`：单分类时收成单列并去掉最小高。 */
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
 * `.agent-knowledge-block__heading`：36px 图标列 + 标题/说明（图标格、字号与配色见同名 CSS）。
 * 标题 12px、说明 10px 是 `text-xs` / `text-3xs` 刻度的当前生效值；迁移前手写 CSS 记的是 13px / 11px，
 * 差异来自值刻度归一化（见 `agent-editor-font-scale.test.ts` 的 `editor-knowledge-heading` 锚点），
 * 本次只做下沉，不在这里改值。
 */
export const KNOWLEDGE_HEADING =
  "agent-knowledge-block__heading grid items-center gap-3 border-b border-gray-100 bg-slate-50 px-3.5 py-3";
/** `.agent-knowledge-block__body`：内容内边距。 */
export const KNOWLEDGE_BODY = "px-3 py-2.5";
/** `--bases` 形态：内容区不留内边距（选择器自带描边）。 */
export const KNOWLEDGE_BODY_BASES = "p-0";
/** `--bases` 形态：内嵌的资源选择器去描边去圆角（原 `.agent-knowledge-block--bases .agent-resource-picker`）。 */
export const KNOWLEDGE_BASES_PICKER = "border-0 rounded-none";

/** `.agent-knowledge-switch`：记忆开关行（64px 高、两列；hover 与文案/徽标样式见同名 CSS）。 */
export const KNOWLEDGE_SWITCH =
  "agent-knowledge-switch grid min-h-16 w-full items-center gap-3.5 border-0 rounded-md bg-slate-50 " +
  "px-3 py-2.75 text-left text-slate-600";
/** 开关行选中态（原 `button.is-on`）。 */
export const KNOWLEDGE_SWITCH_ON = "bg-blue-50";
/** 开关轨道（32×18）。 */
export const KNOWLEDGE_SWITCH_TRACK = "block h-4.5 w-8 rounded-full bg-slate-300 p-0.5";
/** 开关轨道选中态（原 `.is-on > i`）。 */
export const KNOWLEDGE_SWITCH_TRACK_ON = "bg-blue-600";
/** 开关圆钮（14px；阴影属深层值，见同名 CSS）。 */
export const KNOWLEDGE_SWITCH_KNOB = "agent-knowledge-switch__knob block size-3.5 rounded-full bg-white";
/** 开关圆钮选中态（原 `.is-on > i b`）。 */
export const KNOWLEDGE_SWITCH_KNOB_ON = "translate-x-3.5";

/** `.agent-retrieval-fields`：两列（说明字段 + 选项列，列宽模板见同名 CSS），≤1024px 单列。 */
export const RETRIEVAL_FIELDS = "agent-retrieval-fields grid items-start gap-3 max-lg:grid-cols-1";
/** `.agent-retrieval-options`：选项列（子字段的两列行由 B 的 `RETRIEVAL_OPTIONS_FIELDS` 提供）。 */
export const RETRIEVAL_OPTIONS = "grid gap-2.25";
/** `#agent-editor-default-namespaces`：默认命名空间文本域（92px 最小高、可纵向拉伸）。 */
export const DEFAULT_NAMESPACES = "min-h-23 resize-y";
