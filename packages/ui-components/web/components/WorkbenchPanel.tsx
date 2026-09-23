import type * as React from "react";
import { cn } from "../lib/cn";
import "./WorkbenchPanel.css";

/**
 * 左侧索引 + 右侧内容工作台的统一外层表面。
 *
 * 外层投影下沉到 `WorkbenchPanel.css` 的 `.workbench-panel`（任意值 + 复合表达式，属仓库禁令 FCP-WEB-02）；
 * 其余扁平工具类仍留在下面 className 里。
 */
export function WorkbenchPanel({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="workbench-panel"
      className={cn("workbench-panel overflow-hidden rounded-lg bg-background", className)}
      {...props}
    />
  );
}
