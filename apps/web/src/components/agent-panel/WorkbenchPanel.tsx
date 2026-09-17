import type * as React from "react";
import { cn } from "@/src/lib/utils";

/** 控制台左侧索引 + 右侧内容工作台的统一外层表面。 */
export function WorkbenchPanel({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="workbench-panel"
      className={cn("overflow-hidden rounded-[10px] bg-background shadow-[0_12px_38px_rgb(36_57_92/8%)]", className)}
      {...props}
    />
  );
}
