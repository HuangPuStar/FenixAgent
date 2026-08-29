const GLOBAL_SCOPE = "global";
const contextQueues = new Map<string, Map<string, string>>();

function getQueue(scope: string): Map<string, string> {
  const current = contextQueues.get(scope);
  if (current) return current;
  const created = new Map<string, string>();
  contextQueues.set(scope, created);
  return created;
}

export function pushContext(key: string, text: string, scope = GLOBAL_SCOPE): void {
  getQueue(scope).set(key, text);
}

export function removeContext(key: string, scope = GLOBAL_SCOPE): void {
  const queue = contextQueues.get(scope);
  queue?.delete(key);
  if (queue?.size === 0) contextQueues.delete(scope);
}

/** Flush global context plus context isolated to the active deterministic chat session. */
export function flushContext(scope = GLOBAL_SCOPE): string | null {
  const scopes = scope === GLOBAL_SCOPE ? [GLOBAL_SCOPE] : [GLOBAL_SCOPE, scope];
  const parts = scopes.flatMap((currentScope) => Array.from(contextQueues.get(currentScope)?.values() ?? []));
  for (const currentScope of scopes) contextQueues.delete(currentScope);
  if (parts.length === 0) return null;
  return `<system-reminder>\n${parts.join("\n")}\n</system-reminder>`;
}

export function clearContextQueue(): void {
  contextQueues.clear();
}

/** 返回当前队列快照（不清空），供快捷键调试输出 */
export function dumpContext(): Record<string, string> {
  return Object.fromEntries(
    Array.from(contextQueues.entries()).flatMap(([scope, queue]) =>
      Array.from(queue.entries()).map(([key, value]) => [`${scope}:${key}`, value]),
    ),
  );
}

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

export function isVisibleContentBlock(block: { type: string; text?: string }): boolean {
  if (block.type !== "text" || !block.text) return true;
  const trimmed = block.text.trim();
  return !(trimmed.startsWith(SYSTEM_REMINDER_OPEN) && trimmed.endsWith(SYSTEM_REMINDER_CLOSE));
}
