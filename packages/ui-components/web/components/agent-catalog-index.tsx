import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../lib/cn";
import "./agent-catalog-index.css";

/**
 * 主从工作台（`agent-master-detail-workspace`）左侧「目录索引」的共享构件集。
 *
 * 为什么是一组小组件而不是一个「传数据」的大组件：五个消费方的目录行形态并不相同——模型库/MCP/技能库
 * 是「图标 / 文案 / 尾注 / 箭头」四列，知识库的行尾动作**渲染在按钮之外**（行内嵌套 `<button>` 是非法
 * HTML，所以那条按钮只能当兄弟节点），组织页的头部没有说明行。如果按「icon/title/subtitle/meta」传 props，
 * 就要为每一种差异再加一个 prop；因此这里只把**跨页一致的骨架**做成组件，差异靠槽位与 props 表达。
 *
 * **取值全部由本构件集提供，且五页渲染结果必须一样**（2026-09-23 裁定：全部样式统一，不要观感不统一）。
 * 取值一律落在各元素自己的 `className` 上（工具类优先，含 `var()` 引用形态的任意值）；伴生
 * `agent-catalog-index.css` 只留工具类表达不了的三类：挂不上类名的 DOM（图标盒内层 svg、尾注标签
 * `<span>`——两处都由消费页面渲染）、外壳的列模板（`minmax()` 复合值）与窄屏横置的媒体块——逐条
 * 清单见该文件头「已退出本文件」各批。
 * 第四波（2026-09-28）把该表最后 37 处字面量按「名义值 ×16 对齐设计值」收口：能搬的搬进本文件的
 * `className`（字号 / 字重 / 行高 / 内边距 / 圆角 / 尺寸 / 三态配色），挂不上类名的改成
 * `var()` / `calc(var(--spacing) * N)` 引用。此前「字号/内边距/行高/圆角/配色归各页刻度」的分工已作废
 * ——那种分工的代价是同一个组件在五页长出五套观感，实测差值最大的字段（条目标题 9.75 vs 13px、
 * 图标盒 22.75 vs 34px）肉眼即可
 * 分辨——这批读数取自旧的 13/16 刻度，令牌层改造后不再代表现行值（见 `agent-catalog-index.css`
 * 文件头「刻度」段）。现在页面只表达
 * **页面语义**：图标着色（组织页角色三态色）、行尾动作与不可用态（知识库）、窄屏布局（组织页 ≤900px、
 * 知识库 ≤760px）。判据与取值表见 `agent-catalog-index.css` 文件头。
 *
 * 边界：
 * - 目录级三态（加载 / 空 / 失败）**不由本组组件决定**。容器 `children` 是自由内容，调用方可以
 *   继续用「页面级提前返回」（技能库/MCP/模型库今天的做法），也可以把骨架、空态、失败卡直接放进
 *   目录栏（知识库今天的做法）——两种都不必改本组件。
 * - 搜索/作用域条（`ScopeFilterBar`）留在页面里，它跨的是整页而不是目录栏。
 * - 详情头部与详情底部条不在本组件的范围内。
 */

/**
 * 目录栏容器：`<aside>` 地标 + 目录头部 + 目录主体（列表或三态）。
 *
 * 头部为什么是 props 而不是插槽：五页的目录头部都是同一个结构（标题 + 计数徽标 + 可选说明行），
 * 且**都位于目录栏内部**（`>header` 是各页选择器的一级子元素）。做成插槽等于让五个调用方各写一遍
 * 同样的三行标记，重新长出这处重复；做成 props 则只有一个写法。需要改头部**内部**取值时，
 * 用 `agent-catalog-index.css` 给出的 `data-slot` 钩子（当前无页面使用）。
 */
type AgentCatalogIndexProps = {
  /** 目录地标名（`<aside aria-label>`）。不传时容器不带名字，与只给 `<nav>` 命名的最小写法一致。 */
  label?: string;
  /** 目录标题。不传时整个头部不渲染（目录栏只有列表）。 */
  title?: ReactNode;
  /** 标题行右端的计数徽标内容。不传时标题独占整行（不渲染空徽标）。 */
  count?: ReactNode;
  /** 说明行（如「显示 5 / 共 12」）。不传时整行不渲染——组织管理页的头部就没有这一行。 */
  description?: ReactNode;
  /** 头部的附加类名（如记忆页在窄屏隐藏头部：`hidden md:block`）。改头部**内部**取值见 CSS 里的说明。 */
  headerClassName?: string;
  /** 目录主体：`AgentCatalogIndexNav`，或调用方自选的加载 / 空 / 失败态。 */
  children: ReactNode;
  className?: string;
};

/**
 * 目录栏外层。
 *
 * `min-w-0`、内边距（`px-3 py-5.75`）、底色（`bg-surface-0`，原 `#f6f8fb`，ΔE00 0.65）与内嵌分隔线
 * 都是这里的工具类：分隔线用 `inset` 的单段阴影表达（不占布局宽度，238px 的列定义是固定的，
 * `border-right` 不可替代）；单列态（`<48rem`，与主从壳断点对齐）撤掉它由 `max-md:shadow-none` 表达
 * ——窄屏时那条贴右缘的竖线会变成贴着页面右缘（768~900px 仍单列的组织页由它自己的页面 CSS 撤）。
 * `className` 仍保留给页面的**独有语义**（当前五个消费方都不再需要它给目录栏加外观）。
 */
export function AgentCatalogIndex({
  label,
  title,
  count,
  description,
  headerClassName,
  children,
  className,
}: AgentCatalogIndexProps) {
  return (
    <aside
      className={cn(
        "agent-catalog-index min-w-0 bg-surface-0 px-3 py-5.75",
        "shadow-[inset_-1px_0_var(--color-slate-200)] max-md:shadow-none",
        className,
      )}
      aria-label={label}
    >
      {title === undefined ? null : (
        <header
          className={cn("agent-catalog-index-header px-2.5 pb-4.25", headerClassName)}
          data-slot="catalog-index-header"
        >
          <div className="flex items-center justify-between text-16 font-semibold" data-slot="catalog-index-title-row">
            <strong className="font-semibold text-slate-800" data-slot="catalog-index-title">
              {title}
            </strong>
            {count === undefined ? null : (
              <span
                className="grid h-6.25 min-w-6.75 place-items-center rounded-md bg-surface-3 text-sm text-slate-500"
                data-slot="catalog-index-count"
              >
                {count}
              </span>
            )}
          </div>
          {description === undefined ? null : (
            <small className="mt-1.25 block text-sm text-slate-400" data-slot="catalog-index-description">
              {description}
            </small>
          )}
        </header>
      )}
      {children}
    </aside>
  );
}

/**
 * 窄屏「左栏横置」的断点。
 *
 * - `md`：`<48rem`，与主从壳的单列断点严格对齐（记忆页把左栏压成视角 tab 条就落在这里）。
 * - `900px`：`≤900px`，给「左栏自身在 900px 才收起」的页面用（组织页）。900px 不在 Tailwind
 *   标准档（sm 640 / md 768 / lg 1024），而 FCP-WEB-03 禁止任意断点变体，所以这条断点只能在
 *   伴生 CSS 里手写；换用标准档会让 769~900px 出现「两列还在、左栏 238px 里塞一条横向滚动条」。
 */
type AgentCatalogIndexStrip = "md" | "900px";

/** 目录列表：`<nav>` 地标 + 条目流；可选窄屏横置。 */
type AgentCatalogIndexNavProps = {
  /** 目录地标名，落在 `<nav aria-label>`：屏幕阅读器按它列举右侧内容区的入口。 */
  label: string;
  /** 窄屏横置；不传时列表在窄屏仍是纵向（技能库今天的形态）。 */
  stripOnNarrow?: AgentCatalogIndexStrip;
  children: ReactNode;
  className?: string;
};

/**
 * 目录列表。
 *
 * `display: grid` 与行距（`gap-y-1`，本波从伴生表的 `row-gap: 0.25rem` 收上来）是这里的工具类——
 * 行距仍由共享组件统一给，只是落点从 CSS 移到了 `className`（组织页注释里那句「行距由共享 CSS 的
 * `.agent-catalog-index-nav` 统一给」待同批改写，见 CSS 文件头「第四波」段的连带影响）。
 * `stripOnNarrow` 给出的横置表达见 `agent-catalog-index.css`：列表变横向滚动条、行不再收缩；
 * 单行多宽由页面决定（组织页给 `min-width`，记忆页按内容宽）。
 */
export function AgentCatalogIndexNav({ label, stripOnNarrow, children, className }: AgentCatalogIndexNavProps) {
  return (
    <nav
      className={cn("agent-catalog-index-nav grid gap-y-1", className)}
      aria-label={label}
      data-strip={stripOnNarrow}
    >
      {children}
    </nav>
  );
}

/**
 * 条目列模板预设：图标 / 文案 / 尾注 / 箭头四列里后两列的有无。
 *
 * - `icon-copy-meta-arrow`（**默认**）：图标 / 文案 / 尾注 / 箭头。技能库、MCP、模型库、
 *   组织页、知识库都用它——组织页的尾注是角色标签，知识库的尾注为空。
 * - `icon-copy-meta`：没有箭头列（尾注是最后一个可见列）。
 * - `icon-copy`：只有图标与文案（没有尾注与箭头列）。
 *
 * 后两档目前**无消费方**，保留是为了给「确实不需要尾注/箭头」的目录留出口。
 */
type AgentCatalogIndexItemColumns = "icon-copy-meta-arrow" | "icon-copy-meta" | "icon-copy";

/**
 * 三档预设的 `grid-template-columns` 取值，由条目按钮按 `columns` 取一条挂上。
 *
 * 为什么是列模板而不是 flex：第三列是 `auto`（与 flex 项的收缩行为不逐项等价），第四列是固定档、
 * 只在四列档成立。首列宽走 `var()` 回退位——页面可在任意祖先设 `--agent-catalog-index-icon-column`
 * 改图标列宽（组件契约）；默认值 `calc(var(--spacing) * 8.5)` = 34px 与图标盒同尺，第四列 15px 同。
 */
const ITEM_COLUMN_TEMPLATES: Record<AgentCatalogIndexItemColumns, string> = {
  "icon-copy-meta-arrow":
    "grid-cols-[var(--agent-catalog-index-icon-column,calc(var(--spacing)*8.5))_minmax(0,1fr)_auto_calc(var(--spacing)*3.75)]",
  "icon-copy-meta": "grid-cols-[var(--agent-catalog-index-icon-column,calc(var(--spacing)*8.5))_minmax(0,1fr)_auto]",
  "icon-copy": "grid-cols-[var(--agent-catalog-index-icon-column,calc(var(--spacing)*8.5))_minmax(0,1fr)]",
};

/**
 * 「行外壳」的取用契约。
 *
 * 为什么把「渲染外壳」与「有没有行尾动作」拆成两件事：外壳是**行的排布容器**（按钮占满第一列、
 * 行尾动作贴右），行尾动作只是它顺带承载的一个插槽。此前的写法把两者绑在一起（`trailing` 不传就
 * 不渲染外壳），于是「这一行没有动作、但必须保住外壳」只能靠传 `trailing={null}` 这种隐式技巧表达
 * ——一旦实现改成 `trailing == null`，整页的行结构会静默变形且不报错。现在改成显式开关 + 判别联合：
 * 不写 `shell` 就没有外壳、也就不能给 `trailing`（编译期即报错）。
 *
 * 外壳**不承担视觉**：三态底色与圆角画在条目按钮上（五页同一条规则），外壳只做排布。
 */
type AgentCatalogIndexShellProps =
  | {
      /** 不渲染外壳（默认）。行尾就是按钮本身，没有地方安放动作，因此 `trailing` 不可传。 */
      shell?: false;
      trailing?: never;
    }
  | {
      /** 渲染外壳：即使没有行尾动作也渲染（知识库每一行都要这层壳来挂行尾删除按钮）。 */
      shell: true;
      /** 行尾动作（如知识库的删除按钮）；没有动作时传 `null` 或干脆不传。 */
      trailing?: ReactNode;
    };

type AgentCatalogIndexItemProps = Omit<ComponentPropsWithoutRef<"button">, "type"> & {
  /** 选中态。驱动 `aria-current="page"` 与箭头显隐（`aria-current` 仍可由调用方覆盖）。 */
  selected?: boolean;
  /** 列模板预设，默认四列。 */
  columns?: AgentCatalogIndexItemColumns;
  /** 按钮本体的附加类名——只用于**页面独有语义**（如知识库的不可用态），共享取值一律在本文件内。 */
  className?: string;
  /** 外壳的类名——同上，只用于页面独有语义（如知识库的 `is-unavailable`）。 */
  shellClassName?: string;
  children: ReactNode;
} & AgentCatalogIndexShellProps;

/**
 * 目录条目。
 *
 * 骨架与外观全在 `className`，合起来是五页同一份：`display` / `align-items` / `gap` / `border` /
 * `border-radius` / `min-height` / `min-width` / `padding` / `background` / `text-align` 是扁平工具类，
 * 列模板取 `ITEM_COLUMN_TEMPLATES`，过渡是 `transition-[background-color,color] duration-150
 * ease-[ease]`（等价于原伴生表那条两项属性列表）。**三态配色**（基色 `text-slate-500`、悬停
 * `hover:bg-surface-1`、选中 `aria-[current=page]:…`）第四波搬进来——`aria-*` 变体的产出顺序在
 * `hover` 之后（实机构建核对过），选中行被悬停时仍保持选中配色。
 *
 * 按钮带 `group`：选中态的箭头显隐（箭头上的 `group-aria-[current=page]:opacity-100`）靠它命中。
 *
 * `min-w-0` 让网格项能收缩到 `min-content` 以下；组织页 ≤900px 的行宽规则（未分层）仍压过它——
 * 未分层恒胜 `@layer utilities`。
 *
 * 条目密度（2026-09-29）：行高下限取 `min-h-15`（60px）——两行文案（20 + 4 + 16 = 40px）与图标盒（34px）
 * 决定的自然高度是 40px 内容 + 两侧内边距，旧下限 70px 比内容多出 10px 纯留白，是目录「松散」的来源；
 * 收到 60px 后行高由内容决定，内边距仍取 `p-2.5`（不单独压缩：全局标尺收紧 `--spacing` 时随档位一起收敛，
 * 此处再压会双重压缩）。旧值 70px 来自 2026-09-28 归一波（×1.2308，该波无浏览器视觉回归）。
 *
 * 需要「行尾动作渲染在按钮之外」的页面（知识库）用 `shell` + `trailing`：嵌套 `<button>` 是非法
 * HTML，浏览器会把内层按钮甩到外层之外，点击区域与焦点顺序都会错乱。
 */
export function AgentCatalogIndexItem({
  selected,
  columns = "icon-copy-meta",
  shell,
  trailing,
  className,
  shellClassName,
  children,
  ...buttonProps
}: AgentCatalogIndexItemProps) {
  const button = (
    <button
      type="button"
      className={cn(
        "agent-catalog-index-item group grid min-h-15 min-w-0 items-center gap-2.5 rounded border-0 bg-transparent px-2.5 text-left text-slate-500",
        "transition-[background-color,color] duration-150 ease-[ease]",
        ITEM_COLUMN_TEMPLATES[columns],
        "hover:bg-surface-1 aria-[current=page]:bg-surface-hover aria-[current=page]:text-blue-600",
        className,
      )}
      aria-current={selected ? "page" : undefined}
      {...buttonProps}
    >
      {children}
    </button>
  );

  if (shell !== true) return button;

  return (
    <div className={cn("agent-catalog-index-item-shell grid items-center", shellClassName)}>
      {button}
      {trailing}
    </div>
  );
}

/**
 * 条目图标槽：34px 档的图标盒（`grid` / `h-8.5` / `place-items-center` / `rounded` / `bg-white` 与列宽
 * `w-[var(--agent-catalog-index-icon-column,calc(var(--spacing)*8.5))]` 都在 `className`；列宽走
 * `var()` 回退位是为了给「页面在任意祖先覆盖图标列宽」留出口，默认 34px 与 `h-8.5` 同尺）。
 * 内层 svg 尺寸仍在伴生 CSS——svg 由页面传入（`children`），本组件没有挂载点。
 * `className` 只用于页面独有的着色（组织页的角色三态色）；共享侧刻意不声明 `color`，
 * 否则未分层的 CSS 会把页面的着色类整条压过。
 */
export function AgentCatalogIndexIcon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "agent-catalog-index-icon grid h-8.5 place-items-center rounded bg-white",
        "w-[var(--agent-catalog-index-icon-column,calc(var(--spacing)*8.5))]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 条目文案槽：标题 + 副标题两行，两行都在槽内单行截断。 */
type AgentCatalogIndexCopyProps = {
  /** 标题（`<strong>`）。 */
  title: ReactNode;
  /** 副标题（`<small>`）：技能库放描述、MCP 放摘要、知识库放资源数、组织页放 slug。 */
  subtitle: ReactNode;
  /** 标题行的附加类名——只用于页面独有语义；基类（`text-sm leading-5 text-slate-800`）在本组件内。 */
  titleClassName?: string;
  /** 副标题行的附加类名——同上（基类 `mt-1 text-xs leading-4 text-slate-400`）。 */
  subtitleClassName?: string;
  className?: string;
};

/**
 * 条目文案槽。
 *
 * 截断（`truncate` = `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap`）是
 * 「238px 列里塞长名字」不撑破布局的前提，落在两个元素各自的 `className` 上——它与字号 / 字重 / 颜色 /
 * 行高 / 间距（`text-sm leading-5 text-slate-800` / `mt-1 text-xs leading-4 text-slate-400`）同批从
 * 伴生表收上来：`<strong>` 与 `<small>` 都是本组件直接渲染的，元素上就有槽位，不需要子选择器。
 * 页面仍可用 `titleClassName` / `subtitleClassName` 表达页面语义。
 * 槽本身的两行竖排是 `className` 里的 `flex min-w-0 flex-col`。
 */
export function AgentCatalogIndexCopy({
  title,
  subtitle,
  titleClassName,
  subtitleClassName,
  className,
}: AgentCatalogIndexCopyProps) {
  return (
    <span className={cn("agent-catalog-index-copy flex min-w-0 flex-col", className)}>
      <strong className={cn("truncate text-sm leading-5 text-slate-800", titleClassName)}>{title}</strong>
      <small className={cn("mt-1 truncate text-xs leading-4 text-slate-400", subtitleClassName)}>{subtitle}</small>
    </span>
  );
}

/**
 * 条目尾注槽：右对齐的窄列，每行一条元信息（归属、公开/共享标签、角色）。
 *
 * 列宽上限（`max-w-25`）、字号 / 行高（`text-xs leading-none`）、墨色（`text-slate-500`，
 * 第四波从伴生表搬来）与横向排布是 `className` 里的扁平工具类；上限从 135px 收到 100px 是为了
 * 让左列优先拿到行宽——本槽是网格里的 `auto` 列，按内容宽度索取，标签胶囊一宽就把文案列挤到
 * 只剩几十像素（见 `agent-catalog-index.css` 里标签形态那条的尺寸说明）。
 * **标签形态**（底色、描边、胶囊圆角、内边距、颜色、截断）在伴生 CSS——它挂在 `> span` 上，
 * 靠子选择器统一，这条约定是「五页尾注长得一样」的落点（那些 `<span>` 由消费页面渲染，
 * 本组件没有挂载点）。
 */
export function AgentCatalogIndexMeta({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "agent-catalog-index-meta flex min-w-0 max-w-25 flex-col items-end gap-1 text-xs leading-none text-slate-500",
        className,
      )}
    >
      {children}
    </span>
  );
}
