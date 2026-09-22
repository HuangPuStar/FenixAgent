import { cn } from "../lib/cn";

/**
 * 状态圆点色调：只声明「这个点表示好消息还是坏消息」，配色（含深浅色）留在本文件。
 *
 * 与 `../config/StatusBadge` 的 `StatusTone` 是同义词表（同一套语义词），但两者不是同一层东西：
 * `StatusBadge` 渲染「胶囊 + 文案」，本组件渲染「不带文案的小圆点」。共用色调词而不共用组件，
 * 是因为它们的**结构**没有交集（一个要排版文字，一个只有 8px 的色块），强行合并会让两边都长出
 * 用不到的 props。色调词表本身仍是同一份取舍：业务只说语义，色值不外露，同一语义不会各演一套绿。
 */
export type StatusDotTone = "success" | "info" | "warning" | "danger" | "neutral";

/**
 * 色调 → 填充色。用 token 类（`--color-status-*` / `--color-text-muted`）而不是调色板类：
 * 圆点是「实心色块」，深浅色由 token 自己切换，不需要也无法像 `StatusBadge` 那样靠 `dark:` 变体
 * 再写一套（`text-muted` 在深色主题下会自动变暗）。
 */
const TONE_CLASSES: Record<StatusDotTone, string> = {
  success: "bg-status-running",
  info: "bg-status-idle",
  warning: "bg-status-warning",
  danger: "bg-status-error",
  neutral: "bg-text-muted",
};

interface StatusDotProps {
  /** 语义色调，默认 `neutral`（未知态不臆断成坏消息）。 */
  tone?: StatusDotTone;
  /** 进行中：呼吸动画。用于「正在启动 / 正在连接」这类过渡态，终态不要加。 */
  pulse?: boolean;
  /**
   * 读屏文案。**不给时整块 `aria-hidden`**（纯装饰不念）。
   *
   * 只在圆点需要独立表达状态、旁边没有同义可见文案时才传；旁边已有「运行中」之类的文字时
   * 再念一遍是重复播报，此时不传。
   */
  label?: string;
  /** 尺寸与附加装饰。默认 `size-2`（8px）；要别的刻度（如列表项的 6px）在此传 `size-1.5`。 */
  className?: string;
}

/**
 * 状态圆点：**不带文案**的小圆点（状态指示）在全仓的唯一实现。
 *
 * 什么时候用它、什么时候用 `StatusBadge`：圆点旁边**已经有**状态文字（列表行、卡片角标）时用圆点，
 * 圆点自己承担状态表达、需要可读文案时用 `StatusBadge`（它带胶囊底与文字，读屏可读）。
 *
 * 2026-09-22 前端去重：此前有两处「纯状态圆点」各自手写颜色——宿主实例树用页面 CSS 的
 * `.status-dot.running/.starting/.stopped/.error`，知识库目录项另写一份 `w-1.5 h-1.5` + 状态色判断；
 * 而包内 `ui/connection-status` 的 `StatusDot` 是把颜色写死成连接态映射的第三份（入参是
 * `ConnectionState`，非连接语义的调用方拿不到）。现在本文件是唯一实现，`connection-status` 退化为
 * 一个普通调用方：自己保留「连接态 → 色调」的映射与连接态特有的光晕，圆点本体从这里取。
 *
 * 为什么不把色调作可选参数加进 `connection-status` 的 `StatusDot`：那个组件的入参是 `ConnectionState`，
 * 通用调用方没有连接态可传，只能编一个假状态；而模块名也会与「通用圆点」长期错位。
 */
export function StatusDot({ tone = "neutral", pulse = false, label, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        TONE_CLASSES[tone],
        pulse && "animate-pulse",
        className,
      )}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}
