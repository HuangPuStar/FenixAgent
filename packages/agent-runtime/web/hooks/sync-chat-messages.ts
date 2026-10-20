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

function entryBaseId(id: string): string {
  const separator = id.indexOf("#");
  return separator < 0 ? id : id.slice(0, separator);
}

/**
 * 旧展示模型按工具位置把一条助手 entry 拆成 `entryId` / `entryId#1` 多段。
 * 新投影按整条 entry 导入为一条文本，无法表达段间工具顺序；这类 entry 必须保留完整旧结构。
 */
function segmentedEntryBases(legacy: readonly StructuredMessage[]): Set<string> {
  const bases = new Set<string>();
  for (const message of legacy) {
    if (message.id.includes("#")) bases.add(entryBaseId(message.id));
  }
  return bases;
}

/** 分段 entry 的旧文本并集；用于判断新投影的合并正文是否已被旧结构完整覆盖。 */
function segmentedTextByBase(legacy: readonly StructuredMessage[], bases: ReadonlySet<string>): Map<string, string> {
  const texts = new Map<string, string>();
  for (const message of legacy) {
    const base = entryBaseId(message.id);
    if (!bases.has(base) || !isText(message)) continue;
    texts.set(base, `${texts.get(base) ?? ""}${textOf(message)}`);
  }
  return texts;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, "");
}

/**
 * 纯文本旧消息：用户消息，或无错误、只含 message chunk 的助手消息。
 * 工具、计划、思考与错误属于旧通道仍需保留的非文本能力。
 */
function isPureText(message: StructuredMessage): boolean {
  if (message.type === "user_message") return true;
  if (message.type !== "assistant_message") return false;
  return !message.error && message.chunks.every((chunk) => chunk.type === "message");
}

export interface SyncMessageMergerOptions {
  /**
   * 新投影一旦含有文本，就丢弃未配对到新消息的纯文本旧消息（默认开启）。
   *
   * 新协议的历史由旧 Chat Doc 已提交时间线导入并分页，旧通道的完整历史若继续参与合并会
   * 绕过首屏窗口并产生重复；非文本（工具/计划/思考/错误）仍从旧通道补充。
   * 新投影为空时保留旧全量，覆盖回退与导入未就绪场景。
   */
  readonly retireLegacyText?: boolean;
}

/**
 * 每个会话持有一个合并器：别名一对一锁定，已显示的 key/相对顺序不因双写追平改变。
 * 无协议时间戳的记录用首次观察时间，仅用于跨来源配对，不拿未知时间 0 去匹配任意历史。
 *
 * 复杂度：身份/别名/正文均为一次索引，缺省历史按线性链表顺序插入；大基线 hydrate 时
 * 不会因逐条 `Array.find` / `slice().reverse()` 退化为 O(n²)（旧实现 5k 条双写可达 19s）。
 * `matchWindowMs` 仅在「完整基线后到」时放宽（调用方传 Infinity）；实时双写仍用 5s 窗口。
 */
export function createSyncMessageMerger(now: () => number = Date.now, options: SyncMessageMergerOptions = {}) {
  const retireLegacyText = options.retireLegacyText ?? true;
  let previous: StructuredMessage[] = [];
  let aliases = new Map<string, string>();
  let observed = new Map<string, number>();

  return (
    legacy: readonly StructuredMessage[],
    sync: readonly StructuredMessage[],
    matchWindowMs: number = SYNC_MESSAGE_MATCH_WINDOW_MS,
  ): StructuredMessage[] => {
    const nextAliases = new Map<string, string>();
    const nextObserved = new Map<string, number>();
    const candidates = new Map<string, StructuredMessage>();
    const times = new Map<string, number>();
    const legacyKeys: string[] = [];
    const used = new Set<string>();
    // 新投影已有文本即视为文本覆盖成立；不因某次实时帧暂时为空而回退旧全量。
    // 分段 entry 除外：新投影只能表达合并后的整条正文，覆盖证明不成立。
    const segmentedBases = segmentedEntryBases(legacy);
    const segmentedText = segmentedTextByBase(legacy, segmentedBases);
    const syncCoversText = retireLegacyText && sync.some(isText);
    const syncTextUnion = normalizedText(
      sync
        .filter(isText)
        .map((message) => textOf(message))
        .join(""),
    );
    // 分段 entry 的单条合并文本，只有被旧结构正文完整覆盖时才可退役。
    const coveredBySegments = (message: StructuredMessage): boolean => {
      if (message.type !== "assistant_message") return false;
      const legacyText = segmentedText.get(message.id);
      if (legacyText === undefined) return false;
      return normalizedText(legacyText).includes(normalizedText(textOf(message)));
    };

    const legacyTimes = new WeakMap<StructuredMessage, number>();
    const syncTimes = new WeakMap<StructuredMessage, number>();
    const readTime = (source: "legacy" | "sync", message: StructuredMessage): number => {
      const key = `${source}:${message.id}`;
      const time = observed.get(key) ?? (isText(message) && message.ts > 0 ? message.ts : now());
      nextObserved.set(key, time);
      return time;
    };
    for (const message of legacy) legacyTimes.set(message, readTime("legacy", message));
    for (const message of sync) syncTimes.set(message, readTime("sync", message));

    const legacyById = new Map(legacy.map((message) => [message.id, message]));
    const exactIds = new Set<string>();
    for (const message of sync) {
      if (legacyById.has(message.id)) exactIds.add(message.id);
    }

    // 别名 → 旧消息：旧实现每次同步消息都线性扫描 legacy 找别名，双写流下同样退化。
    const aliasToLegacy = new Map<string, StructuredMessage>();
    for (const message of legacy) {
      const alias = aliases.get(`legacy:${message.id}`);
      if (alias !== undefined && !aliasToLegacy.has(alias)) aliasToLegacy.set(alias, message);
    }

    // 正文 → 旧消息：模糊配对只扫描同角色同正文的候选，保持 legacy 顺序（与逐个 find 等价）。
    const textIndex = new Map<string, StructuredMessage[]>();
    for (const message of legacy) {
      if (!isText(message) || exactIds.has(message.id)) continue;
      const key = `${message.type}\u0000${textOf(message)}`;
      const bucket = textIndex.get(key);
      if (bucket) bucket.push(message);
      else textIndex.set(key, [message]);
    }

    const pairs = new Map<string, StructuredMessage>();
    for (const message of sync) {
      // 分段 entry 不参与配对：旧结构决定工具顺序，合并文本只作为缺段时的兜底消息。
      if (segmentedBases.has(message.id)) continue;
      const alias = aliases.get(`sync:${message.id}`);
      let match = legacyById.get(message.id);
      if (!match && alias !== undefined) match = aliasToLegacy.get(alias);
      if (!match && isText(message)) {
        const bucket = textIndex.get(`${message.type}\u0000${textOf(message)}`);
        if (bucket !== undefined) {
          const syncTime = syncTimes.get(message);
          match = bucket.find(
            (item) =>
              !used.has(item.id) &&
              !segmentedBases.has(entryBaseId(item.id)) &&
              syncTime !== undefined &&
              Math.abs((legacyTimes.get(item) ?? 0) - syncTime) <= matchWindowMs,
          );
        }
      }
      if (match && !used.has(match.id)) {
        pairs.set(match.id, message);
        used.add(match.id);
      }
    }

    for (const message of legacy) {
      const pair = pairs.get(message.id);
      // 未配对用户消息必须保留：任意 sync 文本不构成“该轮已被覆盖”的证明。
      // 助手纯文本仅在正文被新投影实际包含时退役（分段 entry 另由结构覆盖判定）。
      if (
        pair === undefined &&
        syncCoversText &&
        message.type === "assistant_message" &&
        isPureText(message) &&
        !segmentedBases.has(entryBaseId(message.id)) &&
        syncTextUnion.includes(normalizedText(textOf(message)))
      )
        continue;
      const key = aliases.get(`legacy:${message.id}`) ?? (pair && aliases.get(`sync:${pair.id}`)) ?? message.id;
      nextAliases.set(`legacy:${message.id}`, key);
      if (pair) nextAliases.set(`sync:${pair.id}`, key);
      candidates.set(key, pair ? preferredMessage(message, pair) : message);
      times.set(key, legacyTimes.get(message) ?? now());
      legacyKeys.push(key);
    }
    for (const message of sync) {
      // 旧分段完整覆盖时合并文本退役；缺段（分页/旧结构缺失）时保留为兜底，不能整条丢弃。
      if (segmentedBases.has(message.id) && coveredBySegments(message)) continue;
      if (nextAliases.has(`sync:${message.id}`)) continue;
      const key = aliases.get(`sync:${message.id}`) ?? message.id;
      nextAliases.set(`sync:${message.id}`, key);
      candidates.set(key, message);
      times.set(key, syncTimes.get(message) ?? now());
    }

    // 旧侧插入顺序：已有 key 保持原相对位置；缺失 key 归入“下一个已有旧 key 之前”的块。
    // 只有尾部缺失块需要时间回退定位——旧实现的 `slice().reverse().find` 与逐次 splice
    // 在整段历史一次性到达时是 O(n²)，这里用一次前向扫描 + 块拼接保持同一顺序语义。
    const initialOrder: string[] = [];
    const initialIndex = new Map<string, number>();
    for (const message of previous) {
      if (!candidates.has(message.id) || initialIndex.has(message.id)) continue;
      initialIndex.set(message.id, initialOrder.length);
      initialOrder.push(message.id);
    }

    const pendingBefore = new Map<number, string[]>();
    const placed = new Set<string>(initialOrder);
    let pending: string[] = [];
    let precedingPosition = -1;
    for (const key of legacyKeys) {
      const position = initialIndex.get(key);
      if (position !== undefined) {
        if (pending.length > 0) {
          const bucket = pendingBefore.get(position);
          if (bucket) bucket.push(...pending);
          else pendingBefore.set(position, pending);
          pending = [];
        }
        precedingPosition = position;
        continue;
      }
      if (placed.has(key)) continue;
      placed.add(key);
      pending.push(key);
    }

    let fallbackPosition = initialOrder.length;
    if (pending.length > 0) {
      const trailingKey = pending[pending.length - 1]!;
      const laterPosition = initialOrder.findIndex((id) => (times.get(id) ?? 0) >= (times.get(trailingKey) ?? 0));
      fallbackPosition = Math.max(precedingPosition + 1, laterPosition < 0 ? initialOrder.length : laterPosition);
    }

    const orderKeys: string[] = [];
    for (let index = 0; index <= initialOrder.length; index += 1) {
      if (index === fallbackPosition) orderKeys.push(...pending);
      const before = pendingBefore.get(index);
      if (before) orderKeys.push(...before);
      const key = initialOrder[index];
      if (key !== undefined) orderKeys.push(key);
    }
    const present = new Set(orderKeys);
    for (const key of candidates.keys()) {
      if (!present.has(key)) {
        orderKeys.push(key);
        present.add(key);
      }
    }

    const cache = new Map(previous.map((message) => [message.id, message]));
    const result = orderKeys.map((id) => {
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
