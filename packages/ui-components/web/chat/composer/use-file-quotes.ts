import { useCallback, useEffect, useRef, useState } from "react";
import { type FileQuoteInput, prepareFileQuote } from "../lib/file-quotes";
import type { ComposerState } from "./composer-state";

/** Owns file-only quote confirmation without replacing ordinary composer draft state. */
export function useFileQuotes(state: ComposerState, sessionId: string | null | undefined, disabled = false) {
  const [pending, setPending] = useState<FileQuoteInput | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<"invalid" | "limit" | null>(null);
  const previousSession = useRef(sessionId);
  const { updateQuotes, readQuotes } = state;
  useEffect(() => {
    const previous = previousSession.current;
    previousSession.current = sessionId;
    // Creating the first ACP session is a binding, not a switch away from its first draft.
    if (previous === sessionId || previous == null) return;
    setPending(null);
    updateQuotes((current) => current.filter((quote) => !quote.source));
  }, [sessionId, updateQuotes]);
  useEffect(() => {
    if (disabled) setPending(null);
  }, [disabled]);
  const request = useCallback(
    (input: FileQuoteInput | null) => {
      setPending(disabled ? null : input);
      setComment(input?.comment ?? "");
      setError(null);
    },
    [disabled],
  );
  const prepared = pending ? prepareFileQuote({ ...pending, comment }, state.quotes) : null;
  const confirm = () => {
    if (!pending || disabled) return;
    const result = prepareFileQuote({ ...pending, comment }, readQuotes());
    if (result.error) {
      setError(result.error);
      return;
    }
    updateQuotes((current) => [...current, { ...result.quote, id: `file-quote-${crypto.randomUUID()}` }]);
    setPending(null);
  };
  return { pending, comment, setComment, request, prepared, error, confirm, close: () => setPending(null) };
}
