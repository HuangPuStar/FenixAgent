import { Quote } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { createQuotePreview, type SerializedChatQuote } from "../../src/lib/context-queue";

interface ChatQuoteMessageProps {
  quote: SerializedChatQuote;
  index: number;
}

/**
 * 已发送引用的专用投影：默认仅展示胶囊，hover、键盘聚焦或点击后展示受限摘要。
 */
export const ChatQuoteMessage = memo(function ChatQuoteMessage({ quote, index }: ChatQuoteMessageProps) {
  const { t } = useTranslation("components");

  return (
    <details className="chat-quote-message">
      <summary>
        <Quote aria-hidden="true" />
        <span>{t("composerAssets.quoteNumber", { count: index + 1 })}</span>
      </summary>
      <div className="chat-quote-message-preview">
        <p>{createQuotePreview(quote.text)}</p>
        {quote.omittedCharacterCount > 0 && (
          <small>{t("composerAssets.quoteTruncatedBadge", { count: quote.omittedCharacterCount })}</small>
        )}
      </div>
    </details>
  );
});
