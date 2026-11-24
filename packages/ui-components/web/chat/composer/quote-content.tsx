import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { createQuotePreview, type SerializedChatQuote } from "../lib/context-queue";

/** Shared draft/message projection of bounded file provenance and optional comments. */
export function QuoteContent({ quote }: { quote: SerializedChatQuote }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  if (!quote.source)
    return <p className="m-0 text-xs leading-normal wrap-anywhere">{createQuotePreview(quote.text)}</p>;
  return (
    <div className="space-y-2 text-xs wrap-anywhere">
      <p className="m-0 font-medium">
        {quote.source.path}
        {quote.source.location ? ` · ${quote.source.location}` : ""}
      </p>
      {quote.source.unsaved && <p className="m-0 text-text-muted">{t("fileQuotes.unsaved")}</p>}
      <pre className="m-0 whitespace-pre-wrap font-mono">{quote.text}</pre>
      {quote.comment && <p className="m-0 whitespace-pre-wrap border-t border-border-subtle pt-2">{quote.comment}</p>}
    </div>
  );
}
