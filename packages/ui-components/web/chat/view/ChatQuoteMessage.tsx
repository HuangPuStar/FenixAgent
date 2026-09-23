import "./ChatQuoteMessage.css";

import { Quote } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { QuoteTruncatedBadge } from "../composer/quote-truncated-badge";
import { createQuotePreview, type SerializedChatQuote } from "../lib/context-queue";

interface ChatQuoteMessageProps {
  quote: SerializedChatQuote;
  index: number;
}

/**
 * 已发送引用的专用投影：默认仅展示胶囊，hover、键盘聚焦或点击后展示受限摘要。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/ChatQuoteMessage.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：
 * - `@/src/lib/context-queue` → 包内 `../lib/context-queue`。
 * - i18n 命名空间从宿主 `components` 改为包内单一命名空间，键加 `chat.components.` 前缀。
 * - `<details>` / `<summary>` 结构、类名与插值参数逐字保留。
 * - 深层样式（`::-webkit-details-marker`、`> svg` 宽度、浮层的定位/宽度/阴影）下沉到同目录
 *   `./ChatQuoteMessage.css`，由 `.chat-quote-summary` / `.chat-quote-preview` 两个语义类承载。
 */
export const ChatQuoteMessage = memo(function ChatQuoteMessage({ quote, index }: ChatQuoteMessageProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  return (
    <details className="group relative" data-slot="chat-quote-message">
      <summary className="chat-quote-summary inline-flex min-h-6.5 cursor-pointer list-none items-center gap-1.25 rounded-full border border-slate-200 bg-sky-50 px-2.5 py-0.75 text-3xs font-bold text-slate-500">
        <Quote aria-hidden="true" />
        <span>{t("chat.components.composerAssets.quoteNumber", { count: index + 1 })}</span>
      </summary>
      <div className="chat-quote-preview absolute right-0 z-20 hidden max-h-33 overflow-hidden rounded-md border border-slate-200 bg-white px-2.75 py-2.25 text-slate-600 group-hover:block group-focus-within:block group-open:block">
        <p className="m-0 text-xs leading-normal wrap-anywhere">{createQuotePreview(quote.text)}</p>
        <QuoteTruncatedBadge omittedCharacterCount={quote.omittedCharacterCount} />
      </div>
    </details>
  );
});
