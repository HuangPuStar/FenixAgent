/**
 * `Text`：一段只读文本，切片 1 的叶类型之一。
 *
 * 安全（§1.7）：`text` 一律作为 React 文本节点渲染——不是 HTML、不走 markdown、不展开成属性。
 * 形如 `<script>` / `<img onerror=…>` 的正文因此只会以字面字符出现在 DOM 里。
 *
 * 容器用 `div` 而不是 `p`：消息区的 markdown 伴随表给 `.chat-markdown-content-styles p` 加了
 * 段落外边距，而 Stack 的间距由 `gap` 统一控制，两套间距叠在一起会出现双倍留白；
 * `div` 不在那张表的选择器面内，视觉与 `gap` 语义一致。
 */

import type { z } from "zod/v4";
import { cn } from "../../../lib/cn";
import type { uiSpecCatalog } from "../catalog";

export type TextViewProps = z.infer<typeof uiSpecCatalog.Text.props>;

/** `tone` 的缺省是 `default`（§5.3）；三个取值都走主题 token，不写颜色字面量。 */
const TONE_CLASS: Record<NonNullable<TextViewProps["tone"]>, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  danger: "text-destructive",
};

export function TextView({ text, tone = "default" }: TextViewProps) {
  return (
    <div data-slot="ui-spec-text" className={cn("text-sm wrap-anywhere", TONE_CLASS[tone])}>
      {text}
    </div>
  );
}
