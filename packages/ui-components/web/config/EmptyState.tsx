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
 * 「让状态块撑满所在内容区」的排布类，与 `EmptyState` 的 `className` 配套使用。
 *
 * 本组件自身是 `py-10` 的内联块；被放进一个**高度固定**的内容区（详情区、列表侧栏、表格外壳）时，
 * 由调用方传它把状态块拉满并居中——高度不够时状态块贴在顶部，看起来像内容被截断。
 *
 * 收敛理由：这段排布此前在两个包里各有一份——`model-management` 的模型目录页具名成
 * `EMPTY_STATE_FILL_CLASS`（1 处定义 + 3 处使用），`identity` 的 API key 页内联抄了同串 2 处。
 * 两份的差别只有「调 `min-h-64` 时会不会漏改一页」，落在这里后只剩一个写法。
 *
 * 为什么是常量而不是新增 `fill` 布尔 prop：本组件已用 `className` 作为呈现逃生舱口
 * （见组件注释「呈现刻意保持内联」），加 prop 等于让同一件事有两种写法（`fill` 与手写 className 字符串），
 * 反而制造新的重复面；常量的用法就是 `` className={EMPTY_STATE_FILL_CLASS} ``，
 * 合并顺序（`cn("py-10 text-center", className)`）与视觉都不变。
 */
export const EMPTY_STATE_FILL_CLASS = "flex min-h-64 flex-col items-center justify-center";

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
 * 需要撑满高度固定的内容区时，传 `EMPTY_STATE_FILL_CLASS`（见其定义处），不要就地手写排布串。
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
