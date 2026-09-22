import type * as React from "react";

import { cn } from "../lib/cn";

export interface LabeledFieldProps extends React.ComponentProps<"div"> {
  /** 字段名，调用方已翻译的文案。 */
  label: string;
  /** 可选提示，调用方已翻译的文案；渲染在控件下方，不进控件的可访问名。 */
  hint?: string;
}

/**
 * 表单字段包装：一行「字段名 + 控件」（另有可选提示）。
 *
 * 为什么在 `config/`：同一形态此前在三个包各写一份——identity `agent-organizations-dialogs.tsx` 的
 * `Field`、model-management `agent-model-fields.tsx` 的 `ModelField`（两者结构逐字相同，只是各挂一份
 * 硬编码 CSS 类），以及 mcp `agent-mcp-dialog.tsx` 的 `Field`（多一个 `hint`，且用 Tailwind token 写
 * 字号/颜色）。三处差异只在「文案 + 是否有提示」，也就是调用方本来就该传的东西。
 *
 * 为什么叫 `LabeledField` 而不是 `FormField`：`ui/form.tsx` 已导出 shadcn 的 `FormField` / `FormItem` /
 * `FormLabel` / `FormControl` / `FormDescription` / `FormMessage`，那套组件靠 `FormFieldContext` 与
 * `useFormContext()` 取字段状态（`FormLabel` / `FormControl` 内部都会走 `useFormField()`），脱离
 * `react-hook-form` 的 `FormProvider` 取不到任何字段状态；本组件的三处消费方都是手写受控 state 表单，
 * 没有 form 实例可传，用不了那一套。同名会让根 barrel 的 `export *` 撞名（TS2308，且会静默取到错的那份）
 * ——本包的 `StatusIndicatorKind` 正是为让开 `connection-status` 的同名导出才改的名，这里同样让开。
 *
 * 无障碍契约：**接线由组件负责，且双方都不生成 `id`**——`<label>` 直接包裹控件，走 HTML 隐式关联，
 * 控件因此拿到 `<label>` 内的字段名。组件不接收 `htmlFor`、不调用 `useId()`，调用方也不必给控件补
 * `id`，所以不存在「`htmlFor` 与控件 `id` 不一致」或同一字段出现两个 `id` 的可能。两条边界：
 * ① 隐式关联只指向 children 里**第一个可标记元素**（HTML 规范），同行还有按钮之类时它们需自带
 * `aria-label`；② 提示渲染在 `<label>` **之外**（控件下方），既不并进控件的可访问名，也不做
 * `aria-describedby`——组件不渲染控件，接不了这条线，需要描述关系的调用方请自行在控件上写。
 *
 * 其余约定与库内一致：**不接 i18n**（`label` / `hint` 都是调用方已翻译好的 `string`，组件不认 key，
 * 避免把库的命名空间与业务包的字典绑死）、**不自带外边距**（字段间距由调用方 `className` 给，
 * `className` 与其余 `<div>` 属性都落在根元素上）。
 *
 * 样式：字段名 `text-sm font-medium text-text-primary`、提示 `text-xs text-text-muted`、字段名与控件
 * 间距 6px（`gap-1.5`），取自 mcp 那一份，与 `ui/label`、`ui/form` 同向的 token 刻度。identity 与
 * model-management 原先各有硬编码色（`#516079` / `var(--model-ink)`）与 12px/600 的字段名样式，
 * 随收敛改为这套 token（暗色下不再是一坨浅灰硬编码）。
 */
export function LabeledField({ label, hint, className, children, ...props }: LabeledFieldProps) {
  return (
    <div data-slot="labeled-field" className={cn("grid gap-1.5", className)} {...props}>
      <label className="grid gap-1.5">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        {children}
      </label>
      {hint ? (
        <p data-slot="labeled-field-hint" className="text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
