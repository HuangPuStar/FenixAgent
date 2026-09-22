import type * as React from "react";

import { cn } from "../lib/cn";

/** 转圈尺寸：覆盖仓库里既有的 14 / 24 / 32 / 40px 四种环径，不再逐处手写 `h-* w-*`。 */
const SPINNER_SIZES = {
  /** 按钮内联（如知识库上传中）。 */
  xs: "size-3.5",
  /** 小面板、标签页内容区。 */
  sm: "size-6",
  /** 默认：面板级内容区。 */
  md: "size-8",
  /** 整屏等待。 */
  lg: "size-10",
} as const;

/** 容器形态：对应仓库里三种真实布局需求，避免每个调用点重抄一遍居中容器。 */
const SPINNER_VARIANTS = {
  /** 跟随内容流，由调用方决定外边距。 */
  inline: "inline-flex",
  /** 撑满父级剩余空间（面板内容区、路由内容壳）。 */
  panel: "flex flex-1",
  /** 整屏居中（应用启动、全屏路由壳）。 */
  screen: "flex h-screen",
} as const;

export interface SpinnerProps extends Omit<React.ComponentProps<"div">, "children"> {
  size?: keyof typeof SPINNER_SIZES;
  variant?: keyof typeof SPINNER_VARIANTS;
  /**
   * 加载文案。给了就渲染在环下方，并由容器上的 `role="status"` 播报；不给则整块提示对读屏隐藏——
   * 没有文案的转圈是纯装饰，读屏去念一个空状态区反而制造噪音。调用方自带文案时（如宿主 `h-screen` 壳）
   * 直接传 `label`，不要再自己包一层 `<p role="status">`。
   */
  label?: React.ReactNode;
}

/**
 * 加载指示器：一个转圈圆环 + 可选文案，外加三种居中容器。
 *
 * 2026-09-22 前端去重：这段圆环类名（`animate-spin rounded-full border-2 border-brand border-t-transparent`）
 * 此前以逐字复制的形式散落在 21 个路由壳与 6 处业务页面里，尺寸、容器、文案各写各的——同一个「加载中」
 * 在不同页面上大小不一，部分壳甚至只有一行文字、连指示器都没有；`workflow_.$id.*` 两处还把 lucide 的
 * `Loader` 图标和这串圆环叠加成了双圈。收敛到此处后，尺寸与可达性只有一处定义。
 *
 * 环色走 `border-current`、容器兜底 `text-brand`：默认就是品牌色，而落在填充按钮之类的有色底上时，
 * 调用方传一个文字色类（如 `text-current` 跟随按钮前景色）即可覆盖，不必再回到这里重写环类名。
 */
export function Spinner({ size = "md", variant = "inline", label, className, ...props }: SpinnerProps) {
  return (
    <div
      className={cn(SPINNER_VARIANTS[variant], "flex-col items-center justify-center gap-3 text-brand", className)}
      role={label ? "status" : undefined}
      aria-hidden={label ? undefined : true}
      {...props}
    >
      <div
        className={cn("animate-spin rounded-full border-2 border-current border-t-transparent", SPINNER_SIZES[size])}
      />
      {label && <p className="text-sm text-text-muted">{label}</p>}
    </div>
  );
}
