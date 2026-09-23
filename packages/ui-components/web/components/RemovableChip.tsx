// web/components/RemovableChip.tsx
// 整枚可点即移除的 chip（内容 + 尾随 `X`）。
//
// 为什么抽：三处真实用例此前各自手写同一个 `<button type="button">` + 尾随 `<X />`，并且都靠
// 「单击整枚触发移除」这一种交互承载语义（没有独立的关闭按钮、没有第二个可聚焦元素）：
//   1. `@fenix/resource-agent-config` 的 `AgentResourcePicker` 已选 chip（单击移除已选资源）；
//   2. `web/chat/composer/ChatComposer` 的技能 chip（单击移除该斜杠命令）；
//   3. 同文件同区域的 MCP chip（单击取消该 MCP 的勾选）。
// 三处的外观本就不同（底色/描边/刻度各异），差异全部由 `className` 表达，不做 variant 收敛——
// 本原语钉住的是结构（按钮 + 尾随 `X`）与交互（单击整枚即移除）这两件三处逐字重复的事。
//
// 契约：
//   - 尾随 `X` 由本组件渲染，且是 `<button>` 的**直接子元素**：三处消费方的既有伴随 CSS 都按
//     `> svg` 选中它来定图标尺寸（如 `.agent-resource-picker__chips > button > svg`、
//     `.chat-composer-capability-chip > svg`），因此这里不能改用图标槽位或包一层。
//   - 不接 i18n：可见文案与无障碍名（`aria-label` / `title`）都由调用方传入，`children` 里带
//     `sr-only` 补充也由调用方决定（本项目既有约定：库内组件不绑定业务命名空间）。
//   - 其余 `<button>` 属性（`disabled` / `title` / `aria-label` / `data-*` …）原样透传。
//   - 键盘可达性由原生 `<button>` 提供（Enter / Space），与三处迁移前一致。

import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export interface RemovableChipProps extends Omit<ComponentProps<"button">, "type" | "onClick" | "children"> {
  /** chip 的可见内容（标签文本；需要时含调用方自备的 `sr-only` 补充）。 */
  children: ReactNode;
  /** 单击整枚 chip 触发的移除 / 取消动作。 */
  onRemove: () => void;
  /** 配色、描边与刻度等外观差异（三处消费方各不相同，故不做 variant）。 */
  className?: string;
}

/** 整枚可点即移除的 chip：单击（或键盘 Enter / Space）整枚即触发 `onRemove`。 */
export function RemovableChip({ children, onRemove, className, ...props }: RemovableChipProps) {
  return (
    <button type="button" className={className} onClick={onRemove} {...props}>
      {children}
      <X />
    </button>
  );
}
