import type { TextSelection } from "@fenix/ui-components/components/text-selection";

/** The document provider never chooses host file or conversation identity. */
export interface OfficeSelectionCallbacks {
  active(): boolean;
  onSelection(selection: TextSelection): void;
  onError(code: "tooLarge" | "unavailable"): void;
}

function belongsToEditor(host: HTMLElement, source: Window): boolean {
  const frames = Array.from(host.querySelectorAll("iframe"));
  let ancestor = source;
  try {
    for (let depth = 0; depth < 8; depth++) {
      if (frames.some((frame) => frame.contentWindow === ancestor)) return true;
      if (ancestor.parent === ancestor) return false;
      ancestor = ancestor.parent;
    }
  } catch (error) {
    console.warn(
      "[file-selection] Rejected inaccessible message source",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
  return false;
}

/** Bind one provider plugin window; disposal makes every old channel unusable. */
export function bindOfficeSelectionBridge(
  host: HTMLElement,
  providerOrigin: string,
  callbacks: OfficeSelectionCallbacks,
): () => void {
  const owner = host.ownerDocument.defaultView;
  if (!owner) return () => {};
  let peer: Window | undefined;
  let channel: string | undefined;
  const listener = (event: MessageEvent<unknown>) => {
    if (
      event.origin !== providerOrigin ||
      !event.source ||
      !("parent" in event.source) ||
      !event.data ||
      typeof event.data !== "object"
    )
      return;
    const data = event.data as Record<string, unknown>;
    if (data.type !== "fenix-office-selection") return;
    const source = event.source as Window;
    if (data.action === "ready") {
      if ((peer && peer !== source) || !belongsToEditor(host, source)) return;
      peer = source;
      channel = crypto.randomUUID();
      peer.postMessage({ type: "fenix-office-selection", action: "bind", channel }, providerOrigin);
      return;
    }
    if (!peer || source !== peer || !channel || data.channel !== channel || !callbacks.active()) return;
    if (data.action === "error") {
      callbacks.onError(data.code === "tooLarge" ? "tooLarge" : "unavailable");
      return;
    }
    if (data.action !== "selection" || typeof data.text !== "string" || !data.text.trim()) return;
    if (
      data.text.length > 65536 ||
      (data.location !== undefined && (typeof data.location !== "string" || data.location.length > 160))
    ) {
      callbacks.onError("tooLarge");
      return;
    }
    callbacks.onSelection({
      text: data.text,
      ...(typeof data.location === "string" ? { location: data.location } : {}),
    });
  };
  owner.addEventListener("message", listener);
  return () => {
    owner.removeEventListener("message", listener);
    peer = undefined;
    channel = undefined;
  };
}
