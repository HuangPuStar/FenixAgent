const GLOBAL_SCOPE = "global";
const contextQueues = new Map<string, Map<string, string>>();

/** 单条聊天引用最多传递 4,000 个 Unicode 字符，避免选中大段输出时挤占上下文窗口。 */
export const MAX_QUOTED_TEXT_LENGTH = 4_000;
/** 单次发送的全部聊天引用最多传递 8,000 个 Unicode 字符。 */
export const MAX_TOTAL_QUOTED_TEXT_LENGTH = 8_000;
/** 单轮最多附带 8 条引用，避免大量短引用产生过多协议包装。 */
export const MAX_QUOTE_COUNT = 8;
/** 含标题和截断说明在内的最终引用上下文硬上限。 */
export const MAX_QUOTE_CONTEXT_PAYLOAD_LENGTH = 9_000;

export interface LimitedQuotedText {
  text: string;
  omittedCharacterCount: number;
}

export type SerializedChatQuote = LimitedQuotedText;

const CHAT_QUOTES_PREFIX = "Chat quotes for this turn (JSON): ";

/** 生成仅供界面展示的短预览，不把完整长引用挂到 DOM 属性中。 */
export function createQuotePreview(text: string, maximumLength = 240): string {
  const characters = Array.from(text);
  return characters.length <= maximumLength ? text : `${characters.slice(0, maximumLength).join("")}…`;
}

/** 规范化并限制引用正文；按 Unicode code point 截断，避免破坏代理对字符。 */
export function limitQuotedText(text: string, maximumLength = MAX_QUOTED_TEXT_LENGTH): LimitedQuotedText {
  const normalized = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  const safeMaximumLength = Math.max(0, Math.min(maximumLength, MAX_QUOTED_TEXT_LENGTH));
  if (characters.length <= safeMaximumLength) {
    return { text: normalized, omittedCharacterCount: 0 };
  }
  return {
    text: characters.slice(0, safeMaximumLength).join(""),
    omittedCharacterCount: characters.length - safeMaximumLength,
  };
}

/** 对结构化引用执行最终硬限制，保证发给 Agent 的完整 payload 不超过边界。 */
export function serializeChatQuotes(quotes: SerializedChatQuote[]): string | undefined {
  const accepted: SerializedChatQuote[] = [];
  for (const quote of quotes.slice(0, MAX_QUOTE_COUNT)) {
    const candidate = [...accepted, quote];
    const serialized = `${CHAT_QUOTES_PREFIX}${JSON.stringify(candidate)}`;
    if (Array.from(serialized).length > MAX_QUOTE_CONTEXT_PAYLOAD_LENGTH) break;
    accepted.push(quote);
  }
  return accepted.length > 0 ? `${CHAT_QUOTES_PREFIX}${JSON.stringify(accepted)}` : undefined;
}

/** 从 system-reminder 内容中读取 Chat 引用；其他内部提醒不会被误投影成引用卡。 */
export function parseChatQuotes(text: string): SerializedChatQuote[] {
  const payloadStart = text.indexOf(CHAT_QUOTES_PREFIX);
  if (payloadStart < 0) return [];
  const payloadEnd = text.indexOf("</system-reminder>", payloadStart);
  const payload = text.slice(payloadStart + CHAT_QUOTES_PREFIX.length, payloadEnd >= 0 ? payloadEnd : undefined).trim();
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_QUOTE_COUNT).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.text !== "string" || typeof candidate.omittedCharacterCount !== "number") return [];
      return [
        {
          text: createQuotePreview(candidate.text, MAX_QUOTED_TEXT_LENGTH),
          omittedCharacterCount: Math.max(0, candidate.omittedCharacterCount),
        },
      ];
    });
  } catch {
    return [];
  }
}

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
