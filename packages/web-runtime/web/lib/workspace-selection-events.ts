import { parseFileQuoteSource } from "@fenix/ui-components/chat/lib/context-queue";
import type { FileQuoteInput } from "@fenix/ui-components/chat/lib/file-quotes";

const EVENT = "workspace:selection-quote";

/** Route a local file selection to one environment and instance, never all chats in an environment. */
export function dispatchWorkspaceSelection(
  envId: string,
  instanceUid: string | null,
  selection: FileQuoteInput | null,
): void {
  window.dispatchEvent(new window.CustomEvent(EVENT, { detail: { envId, instanceUid, selection } }));
}

/** Bridge validated local file requests into the existing composer subscription. */
export function subscribeWorkspaceSelections(
  envId: string | null,
  instanceUid: string | null,
  receive: (selection: FileQuoteInput | null) => void,
): () => void {
  const listener = (event: Event) => {
    const detail: unknown = (event as CustomEvent).detail;
    if (!envId || !detail || typeof detail !== "object") return;
    const value = detail as Record<string, unknown>;
    if (value.envId !== envId || value.instanceUid !== instanceUid) return;
    if (value.selection === null) {
      receive(null);
      return;
    }
    if (!value.selection || typeof value.selection !== "object") return;
    const selection = value.selection as Record<string, unknown>;
    const source = parseFileQuoteSource(selection.source);
    if (!source || typeof selection.text !== "string" || !selection.text.trim()) return;
    receive({ text: selection.text, source });
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
