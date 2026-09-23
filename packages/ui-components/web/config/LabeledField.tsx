import type * as React from "react";

import { cn } from "../lib/cn";

/**
 * 字段名刻度：隐式/显式两种模式共用同一串类，避免长出第二套字段名样式。
 * `text-sm font-medium text-text-primary` 与 `ui/label`、`ui/form` 同向。
 */
const LABEL_TEXT_CLASS = "text-sm font-medium text-text-primary";

export interface LabeledFieldProps extends React.ComponentProps<"div"> {
  /** 字段名，调用方已翻译的文案。 */
  label: string;
  /** 可选提示，调用方已翻译的文案；渲染在控件下方，不进控件的可访问名。 */
  hint?: string;
  /**
   * 显式关联模式：字段名用 `htmlFor` 标注的控件 `id`（控件仍由调用方渲染、`id` 也由调用方给）。
   * 不传＝隐式关联模式（`<label>` 包裹 children），两种模式的选择见组件文档。
   */
  htmlFor?: string;
}

/**
 * 表单字段包装：一行「字段名 + 控件」（另有可选提示），关联方式分隐式与显式两种。
 *
 * **什么时候用隐式（不传 `htmlFor`）**：children 是**单个**可标记控件（`Input` / `Textarea` /
 * `select` / `Select` 触发器），里面没有第二个可标记元素、没有按钮——也就是 `<label>` 能合法地把它
 * 整个包起来。此时接线由组件负责，且双方都不生成 `id`：`<label>` 直接包裹控件，走 HTML 隐式关联，
 * 控件因此拿到 `<label>` 内的字段名；不存在「`htmlFor` 与控件 `id` 不一致」或同一字段两个 `id` 的可能。
 *
 * **什么时候用显式（传 `htmlFor`）**：children 是**复合控件**——除主控件外还有其它可标记元素（预设
 * chip、方法选择器、绝对定位的选项面板、行内「添加 / 复制」按钮……）。判据只有一条：**`<label>` 的
 * 内容模型只允许「一个被标记控件 + 无其它可标记元素」**，label 里一旦出现第二个可聚焦元素，隐式关联
 * 就会把那些元素的文案一并算进主控件的可访问名（读屏念成「执行时间 每 5 分钟 …」），而且本身就是非法
 * 标记。这时改用显式关联：组件渲染**独立的 `<label htmlFor>`，children 与它同层**（不再被包裹），
 * 排版与隐式模式同构——根节点同样是 `grid gap-1.5` 的 6px 字段名/控件间距刻度，字段名同一串类，
 * 因此不会产生第二套字段名刻度。
 *
 * 显式模式的接线责任在调用方：控件 `id` 由调用方给，`htmlFor` 由调用方传给本组件，两者必须对上；
 * 组件不生成 `id`，也无法校验那个 `id` 是否存在（写错的后果是字段名与控件失联，不报错）。所以
 * `htmlFor` 应当指向 children 里**那一个主控件**，而不是「组里第一个可聚焦元素」：字段名进主控件的
 * 可访问名，其余可聚焦元素各自靠自身文案或 `aria-label` 拿名字。
 *
 * 两种模式的共同点：提示都渲染在 `</label>` **之外**（控件下方），既不并进控件的可访问名，也不做
 * `aria-describedby`——组件不渲染控件，接不了这条线，需要描述关系的调用方请自行在控件上写。
 *
 * 为什么在 `config/`：同一形态此前在三个包各写一份——identity `agent-organizations-dialogs.tsx` 的
 * `Field`、model-management `agent-model-fields.tsx` 的 `ModelField`（两者结构逐字相同，只是各挂一份
 * 硬编码 CSS 类），以及 mcp `agent-mcp-dialog.tsx` 的 `Field`（多一个 `hint`，且用 Tailwind token 写
 * 字号/颜色）。三处差异只在「文案 + 是否有提示」，也就是调用方本来就该传的东西。
 *
 * 为什么叫 `LabeledField` 而不是 `FormField`：`ui/form.tsx` 已导出 shadcn 的 `FormField` / `FormItem` /
 * `FormLabel` / `FormControl` / `FormDescription` / `FormMessage`，那套组件靠 `FormFieldContext` 与
 * `useFormContext()` 取字段状态（`FormLabel` / `FormControl` 内部都会走 `useFormField()`），脱离
 * `react-hook-form` 的 `FormProvider` 取不到任何字段状态；本组件的消费方都是手写受控 state 表单，
 * 没有 form 实例可传，用不了那一套。同名会让根 barrel 的 `export *` 撞名（TS2308，且会静默取到错的那份）
 * ——本包的 `StatusIndicatorKind` 正是为让开 `connection-status` 的同名导出才改的名，这里同样让开。
 *
 * 其余约定与库内一致：**不接 i18n**（`label` / `hint` 都是调用方已翻译好的 `string`，组件不认 key，
 * 避免把库的命名空间与业务包的字典绑死）、**不自带外边距**（字段间距由调用方 `className` 给，
 * `className` 与其余 `<div>` 属性都落在根元素上）。
 *
 * 样式：字段名 `text-sm font-medium text-text-primary`、提示 `text-xs text-text-muted`、字段名与控件
 * 间距 6px（`gap-1.5`），两种模式共用，取自 mcp 那一份，与 `ui/label`、`ui/form` 同向的 token 刻度。
 * identity 与 model-management 原先各有硬编码色（`#516079` / `var(--model-ink)`）与 12px/600 的字段名
 * 样式，随收敛改为这套 token（暗色下不再是一坨浅灰硬编码）。
 */
export function LabeledField({ label, hint, htmlFor, className, children, ...props }: LabeledFieldProps) {
  return (
    <div data-slot="labeled-field" className={cn("grid gap-1.5", className)} {...props}>
      {htmlFor === undefined ? (
        // 隐式关联：`<label>` 包裹控件，控件是它的后代，关联由结构保证（渲染与显式模式之前逐字一致）。
        <label className="grid gap-1.5">
          <span className={LABEL_TEXT_CLASS}>{label}</span>
          {children}
        </label>
      ) : (
        // 显式关联：字段名单独成行，children 与它同层——多出的可聚焦元素不再落进 `<label>`。
        <>
          <label htmlFor={htmlFor} className={LABEL_TEXT_CLASS}>
            {label}
          </label>
          {children}
        </>
      )}
      {hint ? (
        <p data-slot="labeled-field-hint" className="text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
