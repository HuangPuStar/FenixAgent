import { isWorkspaceRelativeFilePath } from "../../lib/workspace-relative-path";

/**
 * Chat 引用（选中文本 → 隐藏上下文）的解析、预览与长度限制。
 *
 * 来源：`apps/web/src/lib/context-queue.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除） 的 ChatQuote 子集——逐字复制
 * `parseChatQuotes` / `createQuotePreview` / `isVisibleContentBlock` / `limitQuotedText` /
 * `serializeChatQuotes` 与相关常量。
 * 纯化改动点：去掉与宿主其它功能耦合的全局上下文队列（`contextQueues`、`pushContext`、
 * `removeContext`、`flushContext`、`clearContextQueue`、`dumpContext` 及 `GLOBAL_SCOPE`）——
 * 队列是宿主会话级可变状态，且 `flushContext` 会拼装 `<system-reminder>` 协议载荷，
 * 属于传输侧职责；本包只保留无副作用的纯函数。
 */

/** 单条聊天引用最多传递 4,000 个 Unicode 字符，避免选中大段输出时挤占上下文窗口。 */
export const MAX_QUOTED_TEXT_LENGTH = 4_000;
/** 单次发送的全部聊天引用最多传递 8,000 个 Unicode 字符。 */
export const MAX_TOTAL_QUOTED_TEXT_LENGTH = 8_000;
/** 单轮最多附带 8 条引用，避免大量短引用产生过多协议包装。 */
export const MAX_QUOTE_COUNT = 8;
/** 含标题和截断说明在内的最终引用上下文硬上限。 */
export const MAX_QUOTE_CONTEXT_PAYLOAD_LENGTH = 9_000;

/** 截断后的引用正文与其被省略的字符数。复制自 `apps/web/src/lib/context-queue.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）。 */
export interface LimitedQuotedText {
  text: string;
  omittedCharacterCount: number;
}

/** 序列化进 system-reminder 的单条聊天引用结构。复制自 `apps/web/src/lib/context-queue.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）。 */
export interface SerializedChatQuote extends LimitedQuotedText {
  source?: FileQuoteSource;
  comment?: string;
}

/** Display-only provenance; it never authorizes file access. */
export interface FileQuoteSource {
  path: string;
  location?: string;
  unsaved?: boolean;
}

/** Validate optional provenance at the message and browser-event boundaries. */
export function parseFileQuoteSource(value: unknown): FileQuoteSource | undefined {
  if (!value || typeof value !== "object") return;
  const source = value as Record<string, unknown>;
  if (
    typeof source.path !== "string" ||
    !source.path ||
    source.path.length > 1024 ||
    source.path.includes("\\") ||
    !isWorkspaceRelativeFilePath(source.path) ||
    /^[a-z]:/i.test(source.path)
  )
    return;
  if (
    source.location !== undefined &&
    (typeof source.location !== "string" ||
      source.location.length > 160 ||
      [...source.location].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
  )
    return;
  if (source.unsaved !== undefined && typeof source.unsaved !== "boolean") return;
  return {
    path: source.path,
    ...(typeof source.location === "string" && source.location ? { location: source.location } : {}),
    ...(source.unsaved === true ? { unsaved: true } : {}),
  };
}

const CHAT_QUOTES_PREFIX = "Chat quotes for this turn (JSON): ";

function encodeChatQuotes(quotes: SerializedChatQuote[]): string {
  const payload = quotes.map((quote) => ({
    text: quote.text,
    omittedCharacterCount: quote.omittedCharacterCount,
    ...(quote.source
      ? { source: { path: quote.source.path, location: quote.source.location, unsaved: quote.source.unsaved } }
      : {}),
    ...(quote.comment ? { comment: quote.comment } : {}),
  }));
  return CHAT_QUOTES_PREFIX + JSON.stringify(payload).replaceAll("<", "\\u003c");
}

/** Test the complete escaped payload before accepting or submitting quote drafts. */
export function canSerializeChatQuotes(quotes: SerializedChatQuote[]): boolean {
  return (
    quotes.length <= MAX_QUOTE_COUNT && Array.from(encodeChatQuotes(quotes)).length <= MAX_QUOTE_CONTEXT_PAYLOAD_LENGTH
  );
}

/** 生成仅供界面展示的短预览，不把完整长引用挂到 DOM 属性中。复制自 `apps/web/src/lib/context-queue.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）。 */
export function createQuotePreview(text: string, maximumLength = 240): string {
  const characters = Array.from(text);
  return characters.length <= maximumLength ? text : `${characters.slice(0, maximumLength).join("")}…`;
}

/** 规范化并限制引用正文；按 Unicode code point 截断，避免破坏代理对字符。复制自 `apps/web/src/lib/context-queue.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）。 */
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

/** 对结构化引用执行最终硬限制，保证发给 Agent 的完整 payload 不超过边界。复制自 `apps/web/src/lib/context-queue.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）。 */
export function serializeChatQuotes(quotes: SerializedChatQuote[]): string | undefined {
  const accepted: SerializedChatQuote[] = [];
  for (const quote of quotes.slice(0, MAX_QUOTE_COUNT)) {
    const candidate = [...accepted, quote];
    const serialized = encodeChatQuotes(candidate);
    if (Array.from(serialized).length > MAX_QUOTE_CONTEXT_PAYLOAD_LENGTH) break;
    accepted.push(quote);
  }
  return accepted.length > 0 ? encodeChatQuotes(accepted) : undefined;
}

/** 从 system-reminder 内容中读取 Chat 引用；其他内部提醒不会被误投影成引用卡。复制自 `apps/web/src/lib/context-queue.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）。 */
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
      const source = parseFileQuoteSource(candidate.source);
      return [
        {
          text: createQuotePreview(candidate.text, MAX_QUOTED_TEXT_LENGTH),
          omittedCharacterCount: Math.max(0, candidate.omittedCharacterCount),
          ...(source ? { source } : {}),
          ...(typeof candidate.comment === "string"
            ? { comment: Array.from(candidate.comment).slice(0, 1000).join("") }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

/**
 * 判断内容块是否应当渲染：被完整 `<system-reminder>` 包裹的文本块整体隐藏。
 * 复制自 `apps/web/src/lib/context-queue.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）（仅截断判定，不做消息切分；切分见 `strip-html-tags.ts`）。
 */
export function isVisibleContentBlock(block: { type: string; text?: string }): boolean {
  if (block.type !== "text" || !block.text) return true;
  const trimmed = block.text.trim();
  return !(trimmed.startsWith(SYSTEM_REMINDER_OPEN) && trimmed.endsWith(SYSTEM_REMINDER_CLOSE));
}
