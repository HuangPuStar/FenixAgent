import * as SwitchPrimitive from "@radix-ui/react-switch";
import type * as React from "react";

import { cn } from "../lib/cn";
import "./switch.css";

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  // 默认态轨道高度取 `h-4.5`。原写法 `h-[1.15rem]` 清存量时被机械换算成 `h-4.6`，而间距刻度的裸值必须
  // 是 0.25 的整数倍（4.6 × 4 = 18.4 不是整数），`h-4.6` 一个字面声明都不生成，轨道高度一直由内容撑开；
  // 0.25 档里离 4.6 最近的是 4.5，故取 4.5（见 forbidden-code-patterns.md 的 FCP-WEB-05）。
  //
  // 刻度已在 `@theme` 按 px 落地（`--spacing: 4px`），工具类写的就是设计值：`h-4.5` = 18px，
  // 滑块 `size-4` = 16px + 2×1px 边框 = 18px，轨道与内容等高；`sm` 态同理（`h-3.5` = 14px、
  // `size-3` = 12px + 2px = 14px），两档一致。
  // 旧注记按 13px 根字号下的 rem 刻度给的读数（`--spacing` 3.25px、`h-4.5` 14.625px、`size-4` 13px、
  // 内容撑出 15px、`h-3.5` 11.375px、`size-3` 9.75px）随令牌层改造作废。
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-4.5 data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "switch-thumb pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
