/**
 * 「新建 Agent」面板 C 片（资源库 / 知识区）的类串常量。
 *
 * 来源：`agent-editor-library.css`(96) + `agent-editor-knowledge.css`(161)。生效值口径见
 * `/tmp/agent-editor-effective-spec.md`；跨片契约（B 的 `PAGINATION*` / `LIBRARY_PICKER_NARROW` / `GROUP_FILTER_NARROW` /
 * `RETRIEVAL_OPTIONS_FIELDS`）已在 B 落地，这里只补 C 自己剩下的声明，并把两处状态钩子从类名改成 `data-*`。
 */

/* ── 来源导航（library） ───────────────────────────────────────────────── */

/** `.agent-editor-group-filter`：来源列表容器（窄桌面覆盖由 B 的 `GROUP_FILTER_NARROW` 提供）。 */
export const GROUP_FILTER = "flex min-w-0 flex-col gap-[5px] border-r border-[#edf1f5] bg-[#f8fafc] p-2";
/** 来源按钮：40px 行 / 两列（标签 + 计数）；选中态改用 `data-active`（声明一并落地，不留空钩子）。 */
export const GROUP_FILTER_BUTTON =
  "grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-0 rounded-lg bg-transparent px-[10px] py-[7px] " +
  "text-left text-[#617088] [&:hover]:bg-[#eaf2ff] [&:hover]:text-[#214f9f]";
/** 来源按钮选中态（原 `button.is-active`）。 */
export const GROUP_FILTER_BUTTON_ACTIVE = "bg-[#eaf2ff] text-[#214f9f]";
/** 来源名：单行省略 13px/650。 */
export const GROUP_FILTER_LABEL = "overflow-hidden text-ellipsis whitespace-nowrap text-[13px] [font-weight:650]";
/** 来源计数徽标：24px 最小宽的药丸。 */
export const GROUP_FILTER_COUNT =
  "min-w-6 rounded-full bg-[#fff] px-[6px] py-[2px] text-center text-[10px] not-italic text-[#77869c]";

/* ── 两层资源库（library） ─────────────────────────────────────────────── */

/** `.agent-editor-library-picker`：左来源栏 + 右结果区（168px 左列，250px 最小高）。 */
export const LIBRARY_PICKER =
  "grid min-h-[250px] grid-cols-[168px_minmax(0,1fr)] overflow-hidden border border-[#dfe6f0] rounded-xl bg-[#fff]";
/** `.is-flat`：单分类时收成单列并去掉最小高。 */
export const LIBRARY_PICKER_FLAT = "min-h-0 grid-cols-1";
/** 资源选择器内嵌形态：外壳自己已有描边与圆角，内层不再重复。 */
export const LIBRARY_PICKER_EMBEDDED = "min-h-0 border-0 rounded-none";
/** `.agent-editor-library-picker__results`：结果区列容器。 */
export const LIBRARY_PICKER_RESULTS = "flex min-w-0 min-h-0 flex-col overflow-hidden p-2";
/** 资源选择器内嵌形态的结果区：上下内边距收到 4px。 */
export const LIBRARY_PICKER_RESULTS_EMBEDDED = "py-1";
/** 结果区里的分页：顶到容器底部（`margin-top:auto`）+ `padding: 8px 2px 0`。 */
export const PAGINATION_IN_RESULTS = "mt-auto px-[2px] pb-0 pt-2";
/** 资源选择器内嵌形态的分页：`margin-top: 0`（外层已是贴底布局）。 */
export const PAGINATION_EMBEDDED = "mt-0 px-[2px] pb-0 pt-2";

/* ── 知识区（knowledge） ──────────────────────────────────────────────── */

/** `.agent-knowledge-layout`：三块知识表面纵向排布。 */
export const KNOWLEDGE_LAYOUT = "grid gap-[14px]";
/** `.agent-knowledge-block`：知识区块外壳。 */
export const KNOWLEDGE_BLOCK = "overflow-hidden border border-[#e0e7f0] rounded-xl bg-[#fff]";
/** `.agent-knowledge-block__heading`：34px 图标格 + 标题/说明（标题 13px、说明 11px，供守卫锚点锁定）。 */
export const KNOWLEDGE_HEADING =
  "grid grid-cols-[36px_minmax(0,1fr)] items-center gap-3 border-b border-[#edf1f5] bg-[#f9fbfe] px-[14px] py-3 " +
  "[&>span]:grid [&>span]:size-[34px] [&>span]:place-items-center [&>span]:rounded-[9px] [&>span]:bg-[#eaf2ff] [&>span]:text-[#2d66c8] " +
  "[&>span>svg]:size-[14px] " +
  "[&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div]:gap-[2px] " +
  "[&>div>strong]:text-[13px] [&>div>strong]:[font-weight:680] [&>div>strong]:text-[#31425b] " +
  "[&>div>small]:text-[11px] [&>div>small]:leading-[1.5] [&>div>small]:text-[#8492a7]";
/** `.agent-knowledge-block__body`：内容内边距。 */
export const KNOWLEDGE_BODY = "px-3 py-[10px]";
/** `--bases` 形态：内容区不留内边距（选择器自带描边）。 */
export const KNOWLEDGE_BODY_BASES = "p-0";
/** `--bases` 形态：内嵌的资源选择器去描边去圆角（原 `.agent-knowledge-block--bases .agent-resource-picker`）。 */
export const KNOWLEDGE_BASES_PICKER = "border-0 rounded-none";

/** `.agent-knowledge-switch`：记忆开关行（64px 高、两列）。 */
export const KNOWLEDGE_SWITCH =
  "grid min-h-16 w-full grid-cols-[minmax(0,1fr)_36px] items-center gap-[14px] border-0 rounded-[9px] bg-[#f8fafc] " +
  "px-3 py-[11px] text-left text-[#42526a] [&:hover]:bg-[#f1f6ff] " +
  "[&>span]:flex [&>span]:min-w-0 [&>span]:flex-col [&>span]:gap-[3px] " +
  "[&>span>strong]:flex [&>span>strong]:items-center [&>span>strong]:gap-2 [&>span>strong]:text-[13px] " +
  "[&>span>strong]:[font-weight:680] [&>span>strong]:text-[#33445c] " +
  "[&>span>strong>em]:rounded-full [&>span>strong>em]:bg-[#e4efff] [&>span>strong>em]:px-[7px] [&>span>strong>em]:py-[2px] " +
  "[&>span>strong>em]:text-[10px] [&>span>strong>em]:[font-weight:500] [&>span>strong>em]:not-italic [&>span>strong>em]:text-[#285fbf] " +
  "[&>span>small]:text-[11px] [&>span>small]:leading-[1.5] [&>span>small]:text-[#8996a9]";
/** 开关行选中态（原 `button.is-on`）。 */
export const KNOWLEDGE_SWITCH_ON = "bg-[#f1f6ff]";
/** 开关轨道（32×18）。 */
export const KNOWLEDGE_SWITCH_TRACK = "block h-[18px] w-8 rounded-full bg-[#cfd7e3] p-[2px]";
/** 开关轨道选中态（原 `.is-on > i`）。 */
export const KNOWLEDGE_SWITCH_TRACK_ON = "bg-[#2764e7]";
/** 开关圆钮（14px）。 */
export const KNOWLEDGE_SWITCH_KNOB = "block size-[14px] rounded-full bg-[#fff] shadow-[0_1px_4px_rgb(25_43_75_/_20%)]";
/** 开关圆钮选中态（原 `.is-on > i b`）。 */
export const KNOWLEDGE_SWITCH_KNOB_ON = "translate-x-[14px]";

/** `.agent-retrieval-fields`：两列（说明字段 + 选项列），≤900px 单列。 */
export const RETRIEVAL_FIELDS =
  "grid grid-cols-[minmax(0,1fr)_minmax(210px,0.7fr)] items-start gap-3 [@media(max-width:900px)]:grid-cols-1";
/** `.agent-retrieval-options`：选项列（子字段的两列行由 B 的 `RETRIEVAL_OPTIONS_FIELDS` 提供）。 */
export const RETRIEVAL_OPTIONS = "grid gap-[9px]";
/** `#agent-editor-default-namespaces`：默认命名空间文本域（92px 最小高、可纵向拉伸）。 */
export const DEFAULT_NAMESPACES = "min-h-[92px] resize-y";
