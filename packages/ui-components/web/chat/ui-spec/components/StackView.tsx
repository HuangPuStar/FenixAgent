/**
 * `Stack`：纵向容器，切片 1 唯一的 `container: true` 类型。
 *
 * props 类型取自目录 schema 的推断结果（`z.infer`）而不是再手写一份字段声明：目录是字段、枚举与
 * 缺省值的唯一原告（计划 §5.3「目录 zod 和常量不得各写一份」）。这里只做**类型**引用，`catalog.ts`
 * 不会因此进入运行时图。
 *
 * children 由 `UISpecView` 预先渲染好（它负责递归与就地占位），本组件不碰 Spec、不查注册表。
 */

import type { ReactNode } from "react";
import type { z } from "zod/v4";
import { cn } from "../../../lib/cn";
import type { uiSpecCatalog } from "../catalog";

export type StackViewProps = z.infer<typeof uiSpecCatalog.Stack.props>;

/** `gap` 的缺省是 `md`（§5.3）；取值为标准刻度，无任意值。 */
const GAP_CLASS: Record<NonNullable<StackViewProps["gap"]>, string> = {
  sm: "gap-2",
  md: "gap-3",
  lg: "gap-4",
};

export function StackView({ gap = "md", children }: StackViewProps & { children?: ReactNode }) {
  return (
    <div data-slot="ui-spec-stack" className={cn("flex min-w-0 flex-col", GAP_CLASS[gap])}>
      {children}
    </div>
  );
}
