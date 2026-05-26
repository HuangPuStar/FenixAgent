const contextQueue = new Map<string, string>();

export function pushContext(key: string, text: string): void {
  contextQueue.set(key, text);
}

export function removeContext(key: string): void {
  contextQueue.delete(key);
}

export function flushContext(): string | null {
  if (contextQueue.size === 0) return null;
  const parts = Array.from(contextQueue.values());
  contextQueue.clear();
  return `<system-reminder>\n${parts.join("\n")}\n</system-reminder>`;
}

export function clearContextQueue(): void {
  contextQueue.clear();
}

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

export function isVisibleContentBlock(block: { type: string; text?: string }): boolean {
  if (block.type !== "text" || !block.text) return true;
  const trimmed = block.text.trim();
  return !(trimmed.startsWith(SYSTEM_REMINDER_OPEN) && trimmed.endsWith(SYSTEM_REMINDER_CLOSE));
}
