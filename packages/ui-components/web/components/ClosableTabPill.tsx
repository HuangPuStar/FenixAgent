// web/components/ClosableTabPill.tsx
// 可关闭的 tab pill（图标 + 标签 + 可选附加内容 + 关闭按钮）。
//
// 归属：宿主 `apps/web/src/components/agent-panel/FileTabsBar.tsx` 与 `@fenix/resource-agent-config`
// 的 `web/components/agent-panel/SiteTabsBar.tsx` 此前各自手抄同一套 pill 容器类串（选中/未选中的配色、
// 高度、圆角、内边距、hover 显隐关闭按钮的 group 命名），按「归属由消费者集合决定」下沉到共享组件库。
//
// 两处消费方的真实差异都经 props 表达，不靠复制：
//   - 宽度上限（site 是整枚 `max-w-[220px]`、file 是标签自身 `max-w-[140px]`）→ `className` / `label` 节点；
//   - 关闭按钮的尺寸、hover 底色与过渡属性 → `closeClassName`；
//   - 标签图标尺寸与「非创建者」提示图标 → `icon` / `trailing`；
//   - 选中区在无障碍树中的角色（site 的父容器是 `role="tablist"`）→ `selectRole`。
//
// 关闭按钮的显隐沿用同一套机制：本组件是命名 group `tab`，关闭按钮默认 `opacity-0` + `group-hover/tab:opacity-100`；
// 需要「选中时常显」的调用方在 `closeClassName` 里传 `opacity-100`（后者覆盖前者）。
//
// 文案（`closeLabel` / `closeTitle`）由调用方传入：库内组件不绑定 i18n 命名空间。

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface ClosableTabPillProps {
  /** 选中态：决定 pill 的配色，也是 `aria-selected` 的取值。 */
  active: boolean;
  /** 标签内容。传字符串时由本组件 `truncate`；需要自身宽度上限等排版时传节点。 */
  label: ReactNode;
  /** 标签前置图标；尺寸类由调用方给出（两处消费方的图标尺寸不同）。 */
  icon?: ReactNode;
  /** 标签之后、关闭按钮之前的附加内容（如「非创建者」提示图标）。 */
  trailing?: ReactNode;
  /** 选中该 tab。 */
  onSelect: () => void;
  /** 关闭该 tab；不传则不渲染关闭按钮。 */
  onClose?: () => void;
  /** 关闭按钮的无障碍名（`aria-label`）。有 `onClose` 时必须传，否则读屏只能念出图标。 */
  closeLabel?: string;
  /** 关闭按钮的悬停提示（`title`）；不传则不设。 */
  closeTitle?: string;
  /** 关闭按钮的尺寸、hover 底色与过渡属性。 */
  closeClassName?: string;
  /**
   * 选中区在无障碍树中的角色。传 `"tab"` 时一并补 `aria-selected`，要求父容器是 `role="tablist"`；
   * 不传则保持原生 `<button>` 语义（父容器不是 tablist 的调用方不应传）。
   */
  selectRole?: "tab";
  /** 整枚 pill 的悬停提示（如文件完整路径、站点名）。 */
  title?: string;
  /** 整枚 pill 的补充类：宽度上限、`cursor-pointer`、右侧内边距等调用方差异。 */
  className?: string;
}

/**
 * 选中区（图标 + 标签）的类：`min-w-0` 让标签在 pill 被宽度上限约束时能截断；
 * `text-left` 抵消浏览器给 `<button>` 的 `text-align: center` 默认值。
 */
const SELECT_CLASS_NAME = "flex min-w-0 items-center gap-1.5 text-left";

/**
 * 可关闭的 tab pill。选中区是原生 `<button>`（Enter/Space 由浏览器提供），关闭按钮在工作区之外，
 * 因此关闭不会顺带选中该 tab。
 */
export function ClosableTabPill({
  active,
  label,
  icon,
  trailing,
  onSelect,
  onClose,
  closeLabel,
  closeTitle,
  closeClassName,
  selectRole,
  title,
  className,
}: ClosableTabPillProps) {
  return (
    <div
      title={title}
      className={cn(
        "group/tab flex items-center gap-1 pl-2.5 pr-1 h-7 rounded-md text-xs whitespace-nowrap flex-shrink-0",
        active ? "bg-surface-2 text-text-primary" : "text-text-muted hover:bg-surface-2/60 hover:text-text-primary",
        className,
      )}
    >
      {/* 选中区分两支而不是传 `role={selectRole}`：`aria-selected` 只对 `role="tab"` 合法，
          静态角色写不出来时 a11y 门禁（biome useAriaPropsSupportedByRole）无法判定，会按「非法 aria 属性」报错。 */}
      {selectRole === "tab" ? (
        <button type="button" role="tab" aria-selected={active} onClick={onSelect} className={SELECT_CLASS_NAME}>
          {icon}
          <span className="truncate">{label}</span>
        </button>
      ) : (
        <button type="button" onClick={onSelect} className={SELECT_CLASS_NAME}>
          {icon}
          <span className="truncate">{label}</span>
        </button>
      )}
      {trailing}
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          title={closeTitle}
          aria-label={closeLabel}
          className={cn(
            "flex-shrink-0 flex items-center justify-center rounded opacity-0 group-hover/tab:opacity-100",
            closeClassName,
          )}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}
