import { ChevronRight } from "lucide-react";
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
 * **取值全部在伴生 CSS 里，且五页渲染结果必须一样**（2026-09-23 裁定：全部样式统一，不要观感不统一）。
 * 此前「字号/内边距/行高/圆角/配色归各页刻度」的分工已作废——那种分工的代价是同一个组件在五页长出五套
 * 观感，实测差值最大的字段（条目标题 9.75 vs 13px、图标盒 22.75 vs 34px）肉眼即可分辨。现在页面只表达
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
 * `min-w-0`、内边距、底色、内嵌分隔线、单列态撤掉分隔线——都在伴生 CSS 里，五页同一份。
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
    <aside className={cn("agent-catalog-index min-w-0", className)} aria-label={label}>
      {title === undefined ? null : (
        <header className={cn("agent-catalog-index-header", headerClassName)} data-slot="catalog-index-header">
          <div data-slot="catalog-index-title-row">
            <strong data-slot="catalog-index-title">{title}</strong>
            {count === undefined ? null : <span data-slot="catalog-index-count">{count}</span>}
          </div>
          {description === undefined ? null : <small data-slot="catalog-index-description">{description}</small>}
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
 * `display: grid` 与行距都在伴生 CSS 里（五页同一份）。
 * `stripOnNarrow` 给出的横置表达见 `agent-catalog-index.css`：列表变横向滚动条、行不再收缩；
 * 单行多宽由页面决定（组织页给 `min-width`，记忆页按内容宽）。
 */
export function AgentCatalogIndexNav({ label, stripOnNarrow, children, className }: AgentCatalogIndexNavProps) {
  return (
    <nav className={cn("agent-catalog-index-nav", className)} aria-label={label} data-strip={stripOnNarrow}>
      {children}
    </nav>
  );
}

/**
 * 条目列模板预设，取值与伴生 CSS 里的 `data-columns` 一一对应。
 *
 * - `icon-copy-meta-arrow`（**默认**）：图标 / 文案 / 尾注 / 箭头。技能库、MCP、模型库、
 *   组织页、知识库都用它——组织页的尾注是角色标签，知识库的尾注为空。
 * - `icon-copy-meta`：没有箭头列（尾注是最后一个可见列）。
 * - `icon-copy`：只有图标与文案（没有尾注与箭头列）。
 *
 * 三档共用同一个图标列默认宽度（`2.125rem`，与图标盒同尺），差别只剩尾列数量；列宽仍可用
 * CSS 自定义属性 `--agent-catalog-index-icon-column` 覆盖，设置办法与「为什么默认值写在 var()
 * 回退位」见 CSS 文件头。后两档目前**无消费方**，保留是为了给「确实不需要尾注/箭头」的目录留出口。
 */
type AgentCatalogIndexItemColumns = "icon-copy-meta-arrow" | "icon-copy-meta" | "icon-copy";

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
  /** 按钮本体的附加类名——只用于**页面独有语义**（如知识库的不可用态），外观取值一律在伴生 CSS。 */
  className?: string;
  /** 外壳的类名——同上，只用于页面独有语义（如知识库的 `is-unavailable`）。 */
  shellClassName?: string;
  children: ReactNode;
} & AgentCatalogIndexShellProps;

/**
 * 目录条目。
 *
 * 骨架与外观（`display: grid` / 列模板 / `min-width: 0` / `min-height` / `padding` / `gap` /
 * `border-radius` / 三态配色 / 过渡 / `text-align: left`）全在伴生 CSS 里，五页同一份。
 *
 * 需要「行尾动作渲染在按钮之外」的页面（知识库）用 `shell` + `trailing`：嵌套 `<button>` 是非法
 * HTML，浏览器会把内层按钮甩到外层之外，点击区域与焦点顺序都会错乱。
 */
export function AgentCatalogIndexItem({
  selected,
  columns = "icon-copy-meta-arrow",
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
      className={cn("agent-catalog-index-item", className)}
      data-columns={columns}
      aria-current={selected ? "page" : undefined}
      {...buttonProps}
    >
      {children}
    </button>
  );

  if (shell !== true) return button;

  return (
    <div className={cn("agent-catalog-index-item-shell", shellClassName)}>
      {button}
      {trailing}
    </div>
  );
}

/**
 * 条目图标槽：28px 档的图标盒（尺寸 / 圆角 / 白底 / 内层 svg 尺寸都在伴生 CSS，五页同一份）。
 * `className` 只用于页面独有的着色（组织页的角色三态色）；共享 CSS 刻意不声明 `color`，
 * 否则未分层的它会把页面的着色类整条压过。
 */
export function AgentCatalogIndexIcon({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("agent-catalog-index-icon", className)}>{children}</span>;
}

/** 条目文案槽：标题 + 副标题两行，两行都在槽内单行截断。 */
type AgentCatalogIndexCopyProps = {
  /** 标题（`<strong>`）。 */
  title: ReactNode;
  /** 副标题（`<small>`）：技能库放描述、MCP 放摘要、知识库放资源数、组织页放 slug。 */
  subtitle: ReactNode;
  /** 标题行的附加类名——只用于页面独有语义；字号/字重/颜色/行高都在伴生 CSS。 */
  titleClassName?: string;
  /** 副标题行的附加类名——同上。 */
  subtitleClassName?: string;
  className?: string;
};

/**
 * 条目文案槽。
 *
 * 截断（`overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap`）与两行的字号 /
 * 字重 / 颜色 / 行高 / 间距都在伴生 CSS：截断是「238px 列里塞长名字」不撑破布局的前提，
 * 字号与间距则是五页必须一致的那批取值。
 */
export function AgentCatalogIndexCopy({
  title,
  subtitle,
  titleClassName,
  subtitleClassName,
  className,
}: AgentCatalogIndexCopyProps) {
  return (
    <span className={cn("agent-catalog-index-copy", className)}>
      <strong className={titleClassName}>{title}</strong>
      <small className={subtitleClassName}>{subtitle}</small>
    </span>
  );
}

/**
 * 条目尾注槽：右对齐的窄列，每行一条元信息（归属、公开/共享标签、角色）。
 *
 * 列宽上限、字号、行距与**标签形态**都在伴生 CSS——标签必须是一个 `<span>`（裸文本要自己包一层），
 * 这条约定是「五页尾注长得一样」的落点，见 CSS 里 `.agent-catalog-index-meta > span` 的说明。
 */
export function AgentCatalogIndexMeta({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("agent-catalog-index-meta", className)}>{children}</span>;
}

/**
 * 条目的行尾箭头。
 *
 * 只拥有「未选中时不可见」这一条行为（它是唯一与选中态耦合的部分，靠
 * `[aria-current="page"]` 命中，不再需要调用方把 `selected` 再传一遍）；宽度取自伴生 CSS，
 * 与列模板的第四列同值。
 * 箭头本身对读屏无信息量，故标记 `aria-hidden`。
 */
export function AgentCatalogIndexArrow({ className }: { className?: string }) {
  return <ChevronRight aria-hidden className={cn("agent-catalog-index-arrow", className)} />;
}
