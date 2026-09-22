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
 */
export const ChatQuoteMessage = memo(function ChatQuoteMessage({ quote, index }: ChatQuoteMessageProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  return (
    <details className="group relative" data-slot="chat-quote-message">
      <summary className="inline-flex min-h-[26px] cursor-pointer list-none items-center gap-[5px] rounded-full border border-[#d8e3f1] bg-[#f4f8fd] px-[10px] py-[3px] text-[11px] font-bold text-[#4d72b2] [&::-webkit-details-marker]:hidden [&>svg]:w-3.5">
        <Quote aria-hidden="true" />
        <span>{t("chat.components.composerAssets.quoteNumber", { count: index + 1 })}</span>
      </summary>
      <div className="absolute top-[calc(100%+6px)] right-0 z-20 hidden max-h-[132px] w-[min(340px,calc(100vw-48px))] overflow-hidden rounded-[9px] border border-[#dfe5ed] bg-white px-[11px] py-[9px] text-[#526178] shadow-[0_8px_24px_rgb(38_52_77_/_14%)] group-hover:block group-focus-within:block group-open:block">
        <p className="m-0 text-[12px] leading-[1.5] wrap-anywhere">{createQuotePreview(quote.text)}</p>
        <QuoteTruncatedBadge omittedCharacterCount={quote.omittedCharacterCount} />
      </div>
    </details>
  );
});
