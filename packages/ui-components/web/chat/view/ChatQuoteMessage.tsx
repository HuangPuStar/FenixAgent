import { Quote } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { createQuotePreview, type SerializedChatQuote } from "../lib/context-queue";

interface ChatQuoteMessageProps {
  quote: SerializedChatQuote;
  index: number;
}

/**
 * 已发送引用的专用投影：默认仅展示胶囊，hover、键盘聚焦或点击后展示受限摘要。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/ChatQuoteMessage.tsx`。
 * 纯化改动点：
 * - `@/src/lib/context-queue` → 包内 `../lib/context-queue`。
 * - i18n 命名空间从宿主 `components` 改为包内单一命名空间，键加 `chat.components.` 前缀。
 * - `<details>` / `<summary>` 结构、类名与插值参数逐字保留。
 */
export const ChatQuoteMessage = memo(function ChatQuoteMessage({ quote, index }: ChatQuoteMessageProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  return (
    <details className="chat-quote-message">
      <summary>
        <Quote aria-hidden="true" />
        <span>{t("chat.components.composerAssets.quoteNumber", { count: index + 1 })}</span>
      </summary>
      <div className="chat-quote-message-preview">
        <p>{createQuotePreview(quote.text)}</p>
        {quote.omittedCharacterCount > 0 && (
          <small>
            {t("chat.components.composerAssets.quoteTruncatedBadge", { count: quote.omittedCharacterCount })}
          </small>
        )}
      </div>
    </details>
  );
});
