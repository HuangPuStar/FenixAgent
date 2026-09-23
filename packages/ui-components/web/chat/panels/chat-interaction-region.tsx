import "./chat-interaction-region.css";

import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/cn";

/**
 * 输入框上方「交互卡片」的共用骨架：权限请求（`PermissionPanel`）与交互问题（`QuestionPanel`）两张卡。
 *
 * 为什么抽出来：两张卡是同一版式的两个实例（问题面板的文件头就写着「仿 PermissionPanel 的暖色警示
 * 卡片风格」），此前逐字重复了三处——① 外层 `.chat-interaction-stack` 容器（连注释一起复制）；
 * ② 卡片外壳 `<section>` + 折叠头 `<header><button>` 的全部类名与 `aria-expanded` 语义；
 * ③ 正文内边距与动作区（`px-[14px] pt-0.5 pb-[13px]` / `mt-[11px] flex justify-end gap-[7px]`）。
 * 改一次配色要在两个文件里同步两次，漏一处就是两张卡长得不一样。
 *
 * 为什么放在两张卡的同目录、而不是收进 `internal/` 子目录：本模块的类名**全部来自这两张卡**
 * （取暖色台阶、半圆角、`px-[14px]` 那一批任意值），放在同目录时该目录的样式存量只降不升；
 * 换个新目录会让台账把它们记成**新增**违规（台账按「规则 + 目录」计数，见 `check:web-style`）。
 * 同目录模块按包内约定在 `web/index.ts` 登记，故本模块也在 barrel 内、可深链——
 * `internal/` 子目录才是「不进 barrel」的例外。
 *
 * 只收敛「两张卡逐字相同的部分」，不强行统一各自的内容：权限卡有图标徽标、问题卡没有；
 * 问题卡的正文是多问题分页与选项组，这些差异仍是各自组件的事。
 *
 * 深层样式（宽度台阶与投影两条复合值）下沉到同目录 `./chat-interaction-region.css`，语义类名为
 * `.chat-interaction-cards`（栈容器，源 `.chat-interaction-stack`）与 `.chat-interaction-card`
 * （半圆卡，源 `.chat-interaction-region`）；两个源类名已在阶段四的迁移中作废，不得回流。
 */

/** 卡片栈容器：比输入岛卡片每侧窄 16px 的台阶（源 `chat-design-status.css` 的 `.chat-interaction-stack`，宽度在 `./chat-interaction-region.css`）。 */
export function ChatInteractionStack({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("chat-interaction-cards mx-auto", className)} data-slot="chat-interaction-stack">
      <div className="space-y-2">{children}</div>
    </div>
  );
}

interface ChatInteractionRegionProps {
  /** `data-slot` 锚点（`chat-permission-region` / `chat-question-region`）；样式与用例按它定位。 */
  slot: string;
  /** 卡片可访问名。两张卡都用自己的标题译文当读屏用语。 */
  label: string;
  /** 折叠态由调用方持有（各自的 `useState`），本组件只渲染。 */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 标题行前置图标徽标（权限卡有、问题卡无）。 */
  badge?: React.ReactNode;
  /** 标题行主文案（已译文）。 */
  title: React.ReactNode;
  /** 标题行次要信息（「等待中」/「第 n/m 题」）。 */
  hint?: React.ReactNode;
  /** 折叠时一并收起的主体。 */
  children: React.ReactNode;
  /**
   * 卡片动作区。两张卡的按钮排布不同（权限卡只有应答按钮，问题卡左分页、右提交），
   * 故内容由调用方给，本组件只统一外边距与右对齐。
   */
  footer?: React.ReactNode;
}

/** 单张交互卡：只有上半有圆角的「用户权威」半圆卡（源 `.chat-interaction-region`）。 */
export function ChatInteractionRegion({
  slot,
  label,
  collapsed,
  onToggleCollapsed,
  badge,
  title,
  hint,
  children,
  footer,
}: ChatInteractionRegionProps) {
  return (
    <section
      // 源 `.chat-interaction-region` 的半圆卡（投影在 ./chat-interaction-region.css）。
      className="chat-interaction-card overflow-hidden rounded-t-lg border-x border-t border-b-0 border-slate-200 bg-white"
      data-slot={slot}
      aria-label={label}
    >
      <header>
        <button
          type="button"
          // 源 `.chat-interaction-region > header button`（+ strong/small/末位 svg 与折叠态旋转）
          className="flex min-h-10 w-full items-center gap-2.25 px-3 py-1.5 text-slate-700"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          {badge}
          <strong className="text-xs">{title}</strong>
          {hint && <small className="text-3xs text-gray-400">{hint}</small>}
          <ChevronDown className={cn("ml-auto w-3.75", collapsed && "-rotate-90")} />
        </button>
      </header>
      {!collapsed && (
        <div className="px-3.5 pt-0.5 pb-3.25">
          {children}
          {footer && <footer className="mt-2.75 flex justify-end gap-1.75">{footer}</footer>}
        </div>
      )}
    </section>
  );
}
