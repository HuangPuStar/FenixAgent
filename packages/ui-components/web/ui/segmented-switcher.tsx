/**
 * 分段视图切换器（源实现名 `MemoryViewSwitcher`）。
 *
 * 来源：`packages/resources/memory/web/pages/hindsight/components/MemoryViewSwitcher.tsx`。
 *
 * 纯化取舍：
 * - 仅替换宿主 alias 引用（`@/components/ui/button` → 同目录 `button`、`@/src/lib/utils` → `../lib/cn`），
 *   组件结构、样式类名与 ARIA 属性（`role="group"` / `aria-pressed`）逐字保留；
 * - 去掉记忆模块领域命名：`MemoryViewSwitcher` → `SegmentedSwitcher`、`MemoryViewOption` →
 *   `SegmentedSwitcherOption`；泛型参数、props 名与行为未变；
 * - `label` / `ariaLabel` 本就是 props，组件自身零 i18n 依赖，文案由调用方决定。
 */
import type { LucideIcon } from "lucide-react";

import { cn } from "../lib/cn";
import { Button } from "./button";

export interface SegmentedSwitcherOption<T extends string> {
  value: T;
  label: string;
  icon: LucideIcon;
}

interface SegmentedSwitcherProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedSwitcherOption<T>[];
  ariaLabel: string;
  className?: string;
}

/** 通用分段视图切换器：横向等宽按钮组，当前项以背景与阴影高亮。 */
export function SegmentedSwitcher<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  className,
}: SegmentedSwitcherProps<T>) {
  return (
    <div
      className={cn("flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1", className)}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map(({ value: optionValue, label, icon: Icon }) => (
        <Button
          key={optionValue}
          variant="ghost"
          size="sm"
          aria-pressed={value === optionValue}
          onClick={() => onValueChange(optionValue)}
          className={cn(
            "h-8 shrink-0 px-3",
            value === optionValue
              ? "bg-background text-foreground shadow-sm hover:bg-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-4" />
          {label}
        </Button>
      ))}
    </div>
  );
}
