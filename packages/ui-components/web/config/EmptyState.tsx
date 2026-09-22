import type * as React from "react";

import { cn } from "../lib/cn";
import { Button } from "../ui/button";

/**
 * 状态块色调。只声明「这块区域为什么没有内容」的语义，配色（含 dark 变体）由本组件决定。
 *
 * - `neutral`：确实没有数据、筛选后没有匹配；
 * - `danger`：读取失败、无权限——需要与「没有数据」区分开的持久状态。
 */
export type EmptyStateTone = "neutral" | "danger";

/** 状态块的可选操作入口（多为「重试」）。 */
export interface EmptyStateAction {
  label: React.ReactNode;
  onClick: () => void;
  /** 按钮前置图标；不传 `size-*` 类时由 Button 统一成 16px。 */
  icon?: React.ReactNode;
  /** 请求进行中时置灰，避免连点重复触发（与调用方 `useRequest` 的 loading 对齐）。 */
  disabled?: boolean;
}

export interface EmptyStateProps extends Omit<React.ComponentProps<"div">, "title" | "children"> {
  /** 状态图标；不传尺寸类时沿用 lucide 默认的 24px，组件只负责居中与色调。 */
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: EmptyStateAction;
  tone?: EmptyStateTone;
}

const ICON_TONE: Record<EmptyStateTone, string> = {
  neutral: "text-text-muted",
  danger: "text-status-error",
};

/**
 * 「这块区域现在没有可用内容」的统一呈现：空态、无匹配、读取失败、无权限共用一套骨架。
 *
 * 为什么是同一组件而不是按语义拆开：四种状态的**结构**完全一致（图标 + 一行主文案 + 可选说明 + 可选操作），
 * 差别只在措辞和「要不要给重试」。拆成四个组件会让调用方在「这次到底算空态还是错误态」上反复犹豫，
 * 而真正需要区分的信息（标题文案、是否给 action）本来就是调用方传进来的。语义差异由 `tone` 加 `role="alert"` 表达：
 * 失败/无权限分支传 `tone="danger"`，持久错误再补 `role="alert"`（瞬时状态不需要打断读屏）。
 *
 * 呈现刻意保持**内联**（一段居中文本块，不带 Card 外壳）：状态块的容器是它所在的卡片或面板，
 * 由调用方决定边框与外边距，组件自身只负责内部排版。需要「整块内容区为空」的卡片形态时，
 * 把本组件放进调用方的 `Card` / `CardContent` 即可，不要在组件内再套一层卡片。
 *
 * 尺寸固定用标准刻度（`text-sm` / `text-xs` / `py-10`），不写任意值类名：状态块是全站复用最广的一类占位，
 * 一旦允许逐处微调字号，同一种空态在三个包里会长得不一样——这正是本组件要消灭的问题。
 *
 * 2026-09-22 前端去重：workflow（8 处）、observer（3 处）、task（3 处）此前各自手写同一套
 * 居中文本块 + 图标 + 主文案 + 说明的组合，靠肉眼保持配色与间距一致；收敛到此处后，配色改动只发生在这一处。
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "neutral",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div className={cn("py-10 text-center", className)} {...props}>
      {icon && <div className={cn("mb-2 flex h-8 items-center justify-center", ICON_TONE[tone])}>{icon}</div>}
      {/* 主文案比说明只强一档：danger 下用 text-text-secondary 而不是纯红——红留给图标，
          长错误信息整段标红会盖过页面其余部分，也让说明文字失去层次。 */}
      <p className={cn("text-sm font-medium", tone === "danger" ? "text-text-secondary" : "text-text-muted")}>
        {title}
      </p>
      {description && <p className="mt-1 text-xs text-text-dim">{description}</p>}
      {action && (
        <Button variant="outline" size="sm" className="mt-3" onClick={action.onClick} disabled={action.disabled}>
          {action.icon}
          {action.label}
        </Button>
      )}
    </div>
  );
}
