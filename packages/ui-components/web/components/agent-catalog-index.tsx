import { ChevronRight } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../lib/cn";
import "./agent-catalog-index.css";

/**
 * 主从工作台（`agent-master-detail-workspace`）左侧「目录索引」的共享构件集。
 *
 * 为什么是一组小组件而不是一个「传数据」的大组件：五个消费方的目录行形态并不相同——
 * 模型库/MCP/技能库是「图标 / 文案 / 尾注 / 箭头」四列，组织页没有箭头（行尾是纯文本角色标签），
 * 知识库的行尾是**渲染在按钮之外**的删除按钮（行内嵌套 `<button>` 是非法 HTML，所以那条按钮
 * 只能当兄弟节点）。如果按「icon/title/subtitle/meta」传 props，就要为每一种差异再加一个 prop，
 * 而且文案的字号/颜色也得跟着参数化——那是把重复从 CSS 挪进 props。因此这里只把**跨页一致的
 * 骨架**（列模板、槽盒排布、截断、箭头显隐、头部几何）做成组件，字号/内边距/圆角/选中配色仍归
 * 各页自己的刻度（px 字面量与 13/16 rem 刻度长期并存，短期无法统一）。
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
 * 同样的三行标记，重新长出这处重复；做成 props 则只有一个写法。形态确有差异的页面（组织页的大写
 * 小标题、知识库的徽标尺寸）见 `agent-catalog-index.css` 里「层叠」段给出的覆盖写法。
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
 * `min-w-0` 是必须的：目录栏固定在壳的左列（238px），只要有一处不可断的长文本（组织 slug、
 * 外部技能的内置名）就会把 `minmax(0, 1fr)` 的另一列挤变形。内边距、背景、边框、窄屏走向
 * （组织页在 ≤900px 要换成下边框）都属各页外观，由 `className` 提供。
 *
 * 头部取值取自 MCP / 模型库两页原本**逐字相同**的那份规范（13px 标题、22×20 计数徽标、11px 说明行、
 * `0 8px 14px` 内边距），它同时是四处同构里唯一被复制过两次的版本。技能库原来那份是 13/16 根字号下
 * rem 刻度的产物（9.75px 标题等），收编后按本规范统一。
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
 * 只声明 `display: grid`：行间距（3px / 2.4375px / 4px）属各页刻度，由 `className` 给。
 * `stripOnNarrow` 给出的横置表达见 `agent-catalog-index.css`：列表变横向滚动条、行不再收缩；
 * 单行多宽由页面决定（组织页给 `min-w-47.5`，记忆页按内容宽）。
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
 * - `icon-copy-meta-arrow`：`28px minmax(0, 1fr) auto 12px`——图标 / 文案 / 尾注 / 箭头，
 *   模型库、MCP、技能库的公共形态（本组件要消掉的那三处逐字重复）。
 * - `icon-copy-meta`：`28px minmax(0, 1fr) auto`——没有箭头列，尾注是纯文本（组织页的角色标签）。
 * - `icon-copy`：`34px minmax(0, 1fr)`——只有图标与文案，图标更大，行尾动作在按钮之外（知识库）。
 *
 * 三档的首列宽度都取自 CSS 自定义属性 `--agent-catalog-index-icon-column`，缺省即上列数值；
 * 行首是**裸图标**（没有图标盒）的页面把该变量设成图标自身的宽度即可（组织页 `1rem`），
 * 不必为新宽度再造一个预设。设置办法与「为什么默认值写在 var() 回退位」见 CSS 文件头。
 */
type AgentCatalogIndexItemColumns = "icon-copy-meta-arrow" | "icon-copy-meta" | "icon-copy";

/**
 * 「行外壳」的取用契约。
 *
 * 为什么把「渲染外壳」与「有没有行尾动作」拆成两件事：外壳是**行的视觉容器**（页面把悬停/选中
 * 底色、圆角、过渡画在它上面），行尾动作只是它顺带承载的一个插槽。此前的写法把两者绑在一起
 * （`trailing` 不传就不渲染外壳），于是「这一行没有动作、但必须保住外壳」只能靠传 `trailing={null}`
 * 这种隐式技巧表达——一旦实现改成 `trailing == null`，整页的行样式会静默消失且不报错。
 * 现在改成显式开关 + 判别联合：不写 `shell` 就没有外壳、也就不能给 `trailing`（编译期即报错）。
 */
type AgentCatalogIndexShellProps =
  | {
      /** 不渲染外壳（默认）。行尾就是按钮本身，没有地方安放动作，因此 `trailing` 不可传。 */
      shell?: false;
      trailing?: never;
    }
  | {
      /** 渲染外壳：即使没有行尾动作也渲染（知识库每一行都要这层壳来落底色）。 */
      shell: true;
      /** 行尾动作（如知识库的删除按钮）；没有动作时传 `null` 或干脆不传。 */
      trailing?: ReactNode;
    };

type AgentCatalogIndexItemProps = Omit<ComponentPropsWithoutRef<"button">, "type"> & {
  /** 选中态。驱动 `aria-current="page"` 与箭头显隐（`aria-current` 仍可由调用方覆盖）。 */
  selected?: boolean;
  /** 列模板预设，默认四列。 */
  columns?: AgentCatalogIndexItemColumns;
  /** 按钮本体的附加类名（字号、内边距、圆角、选中配色等各页刻度）。 */
  className?: string;
  /** 外壳的类名（行容器底色/圆角/过渡），仅在渲染外壳时有意义。 */
  shellClassName?: string;
  children: ReactNode;
} & AgentCatalogIndexShellProps;

/**
 * 目录条目。
 *
 * 骨架（`display: grid` / 列模板 / `min-width: 0` / `align-items: center` / `border: 0` /
 * `text-align: left`）在伴生 CSS 里；行高、内边距、圆角、配色、字号按页给——这几个值恰恰是
 * 各页差异所在（列表行高 57px / 46.3px / 64px，行距 3px / 2.4px / 4px），共享不了，
 * 也不该为它们发明统一档位。
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

/** 条目图标槽：占列模板给定的图标列，盒子本身只负责居中。 */
export function AgentCatalogIndexIcon({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("agent-catalog-index-icon", className)}>{children}</span>;
}

/** 条目文案槽：标题 + 副标题两行，两行都在槽内单行截断。 */
type AgentCatalogIndexCopyProps = {
  /** 标题（`<strong>`）。 */
  title: ReactNode;
  /** 副标题（`<small>`），组织页放的是 `font-mono` 的 slug，技能库放的是描述。 */
  subtitle: ReactNode;
  /** 标题行的字号/颜色类名——各页刻度不同，故不设共享默认值。 */
  titleClassName?: string;
  /** 副标题行的字号/颜色/上边距类名。 */
  subtitleClassName?: string;
  className?: string;
};

/**
 * 条目文案槽。
 *
 * 截断（`overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap`）下沉到伴生 CSS：
 * 它在四处实现里逐字相同，且是「238px 列里塞长名字」不撑破布局的前提；字号与颜色留给页面。
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

/** 条目尾注槽：右对齐的窄列，每行一条元信息（归属、公开/共享标签、角色）。 */
export function AgentCatalogIndexMeta({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("agent-catalog-index-meta", className)}>{children}</span>;
}

/**
 * 条目的行尾箭头。
 *
 * 只拥有「未选中时不可见」这一条行为（它是唯一与选中态耦合的部分，靠
 * `[aria-current="page"]` 命中，不再需要调用方把 `selected` 再传一遍）；宽度按各页字号刻度给，
 * 默认 `w-3`（13/16 rem 刻度下的 9.75px），px 字面量页面在自己的页面 CSS 里覆盖成 12px。
 * 箭头本身对读屏无信息量，故标记 `aria-hidden`。
 */
export function AgentCatalogIndexArrow({ className }: { className?: string }) {
  return <ChevronRight aria-hidden className={cn("agent-catalog-index-arrow w-3", className)} />;
}
