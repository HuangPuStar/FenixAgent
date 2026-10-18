import type { StructuredMessage } from "@fenix/chat-channel";

/** 异 ID 双写仅在同角色、完全相同正文且时间差不超过 5 秒时配对。 */
export const SYNC_MESSAGE_MATCH_WINDOW_MS = 5000;

type TextMessage = Extract<StructuredMessage, { type: "user_message" | "assistant_message" }>;

function isText(message: StructuredMessage): message is TextMessage {
  return message.type === "user_message" || message.type === "assistant_message";
}

function textOf(message: TextMessage): string {
  return message.type === "user_message"
    ? message.content
    : message.chunks
        .filter((chunk) => chunk.type === "message")
        .map((chunk) => chunk.text)
        .join("");
}

/** 旧侧保留非文本/错误；纯文本取更完整的一侧，避免双写传输先后导致流式正文回退。 */
function preferredMessage(legacy: StructuredMessage, sync: StructuredMessage): StructuredMessage {
  if (!isText(legacy) || !isText(sync) || legacy.type !== sync.type) return legacy;
  if (legacy.type === "assistant_message" && (legacy.error || legacy.chunks.some((c) => c.type !== "message"))) {
    return legacy;
  }
  return textOf(sync).length >= textOf(legacy).length ? sync : legacy;
}

/**
 * 每个会话持有一个合并器：别名一对一锁定，已显示的 key/相对顺序不因双写追平改变。
 * 无协议时间戳的记录用首次观察时间，仅用于跨来源配对，不拿未知时间 0 去匹配任意历史。
 */
export function createSyncMessageMerger(now: () => number = Date.now) {
  let previous: StructuredMessage[] = [];
  let aliases = new Map<string, string>();
  let observed = new Map<string, number>();

  return (legacy: readonly StructuredMessage[], sync: readonly StructuredMessage[]): StructuredMessage[] => {
    const nextAliases = new Map<string, string>();
    const nextObserved = new Map<string, number>();
    const candidates = new Map<string, StructuredMessage>();
    const times = new Map<string, number>();
    const legacyKeys: string[] = [];
    const used = new Set<string>();
    const timestamp = (source: string, message: StructuredMessage): number => {
      const key = `${source}:${message.id}`;
      const time = observed.get(key) ?? (isText(message) && message.ts > 0 ? message.ts : now());
      nextObserved.set(key, time);
      return time;
    };
    for (const message of legacy) timestamp("legacy", message);
    for (const message of sync) timestamp("sync", message);
    const legacyById = new Map(legacy.map((message) => [message.id, message]));
    const exactIds = new Set(sync.filter((message) => legacyById.has(message.id)).map((message) => message.id));
    const pairs = new Map<string, StructuredMessage>();
    for (const message of sync) {
      const alias = aliases.get(`sync:${message.id}`);
      let match = legacyById.get(message.id);
      if (!match && alias) match = legacy.find((item) => aliases.get(`legacy:${item.id}`) === alias);
      if (!match && isText(message)) {
        match = legacy.find(
          (item) =>
            !used.has(item.id) &&
            !exactIds.has(item.id) &&
            isText(item) &&
            item.type === message.type &&
            textOf(item) === textOf(message) &&
            Math.abs(timestamp("legacy", item) - timestamp("sync", message)) <= SYNC_MESSAGE_MATCH_WINDOW_MS,
        );
      }
      if (match && !used.has(match.id)) {
        pairs.set(match.id, message);
        used.add(match.id);
      }
    }
    for (const message of legacy) {
      const pair = pairs.get(message.id);
      const key = aliases.get(`legacy:${message.id}`) ?? (pair && aliases.get(`sync:${pair.id}`)) ?? message.id;
      nextAliases.set(`legacy:${message.id}`, key);
      if (pair) nextAliases.set(`sync:${pair.id}`, key);
      candidates.set(key, pair ? preferredMessage(message, pair) : message);
      times.set(key, timestamp("legacy", message));
      legacyKeys.push(key);
    }
    for (const message of sync) {
      if (nextAliases.has(`sync:${message.id}`)) continue;
      const key = aliases.get(`sync:${message.id}`) ?? message.id;
      nextAliases.set(`sync:${message.id}`, key);
      candidates.set(key, message);
      times.set(key, timestamp("sync", message));
    }

    // 后到的历史插入下一个已有历史锚点之前；其余新消息追加，已有消息不按浮动时间戳重排。
    const order = previous.map((message) => message.id).filter((id) => candidates.has(id));
    const present = new Set(order);
    for (let index = legacyKeys.length - 1; index >= 0; index -= 1) {
      const key = legacyKeys[index];
      if (present.has(key)) continue;
      const next = legacyKeys[index + 1];
      const position = next === undefined ? -1 : order.indexOf(next);
      const preceding = legacyKeys
        .slice(0, index)
        .reverse()
        .find((id) => present.has(id));
      const laterPosition = order.findIndex((id) => (times.get(id) ?? 0) >= (times.get(key) ?? 0));
      const fallbackPosition = Math.max(
        preceding === undefined ? 0 : order.indexOf(preceding) + 1,
        laterPosition < 0 ? order.length : laterPosition,
      );
      order.splice(position < 0 ? fallbackPosition : position, 0, key);
      present.add(key);
    }
    for (const key of candidates.keys()) {
      if (!present.has(key)) order.push(key);
    }
    const cache = new Map(previous.map((message) => [message.id, message]));
    const result = order.map((id) => {
      const source = candidates.get(id)!;
      const cached = cache.get(id);
      if (cached === source) return cached;
      const candidate = source.id === id ? source : { ...source, id };
      return cached && JSON.stringify(cached) === JSON.stringify(candidate) ? cached : candidate;
    });
    aliases = nextAliases;
    observed = nextObserved;
    if (result.length !== previous.length || result.some((message, index) => message !== previous[index])) {
      previous = result;
    }
    return previous;
  };
}
