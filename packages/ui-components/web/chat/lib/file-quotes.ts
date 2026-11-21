import {
  canSerializeChatQuotes,
  type FileQuoteSource,
  MAX_QUOTE_COUNT,
  MAX_QUOTED_TEXT_LENGTH,
  MAX_TOTAL_QUOTED_TEXT_LENGTH,
  parseFileQuoteSource,
  type SerializedChatQuote,
} from "./context-queue";

/** File selection captured before opening a menu or moving focus to the composer. */
export interface FileQuoteInput {
  text: string;
  source: FileQuoteSource;
  comment?: string;
  omittedCharacterCount?: number;
}

/** A rejected quote remains editable in the confirmation dialog. */
export type FileQuoteResult =
  | { quote: SerializedChatQuote; error?: never }
  | { quote?: never; error: "invalid" | "limit" };

/** Apply the same body and escaped-payload budget during confirmation and submission. */
export function prepareFileQuote(input: FileQuoteInput, existing: SerializedChatQuote[]): FileQuoteResult {
  const source = parseFileQuoteSource(input.source);
  if (
    !source ||
    typeof input.text !== "string" ||
    !input.text.trim() ||
    (input.comment !== undefined && (typeof input.comment !== "string" || Array.from(input.comment).length > 1000))
  )
    return { error: "invalid" };
  const remaining =
    MAX_TOTAL_QUOTED_TEXT_LENGTH - existing.reduce((sum, quote) => sum + Array.from(quote.text).length, 0);
  if (existing.length >= MAX_QUOTE_COUNT || remaining <= 0) return { error: "limit" };
  const characters = Array.from(input.text);
  const text = characters.slice(0, Math.min(MAX_QUOTED_TEXT_LENGTH, remaining)).join("");
  const comment = input.comment?.trim();
  const quote: SerializedChatQuote = {
    text,
    omittedCharacterCount: characters.length - Array.from(text).length + Math.max(0, input.omittedCharacterCount ?? 0),
    source,
    ...(comment ? { comment } : {}),
  };
  if (!canSerializeChatQuotes([...existing, quote])) return { error: "limit" };
  return { quote };
}
