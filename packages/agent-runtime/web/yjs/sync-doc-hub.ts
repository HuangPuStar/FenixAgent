// packages/agent-runtime/web/yjs/sync-doc-hub.ts
// 新同步协议 content Doc → 现有 Chat UI 只读消息投影（隔离实例）。
//
// 为什么另建一份 Y.Doc：`@fenix/chat-channel/sync-client` 的 DocHub 只负责 apply 与 ACK，不暴露已应用
// 文档的读取口；旧 Chat/Session Doc 又不能混入新协议字节（隔离决策）。因此本模块只做**只读镜像**：
// 由 transport 的入站帧旁路喂入，不写回、不发 ACK、不参与协议状态判定。镜像失败（坏 payload、未知记录）
// 只计入 skipped/invalidUpdates，异常不得抛回 WebSocket 事件循环。
//
// 投影规则（与 sync/runtime/ingress.ts、sync/live/live-writer.ts 的写入契约对齐）：
// - 只消费 `root.records` 里的扁平记录（recordId/entryId/entryOrder/contentSlot/partIndex/kind/payload）；
// - `kind: "text" | "text_part"` 按 UTF-8 解码后拼接；`kind: "final"` 只读取 completedAt，不伪造正文；
// - `history_object` / `tool_object` 不在本适配器解码（保真 JSON 尚无展示映射），计入 skipped；
// - 时间戳在 content Doc 中不存在：assistant 取 final descriptor 的 completedAt，其余为 0（限制见报告）。

import type { StructuredMessage } from "@fenix/chat-channel";
import * as Y from "yjs";

/** 只读投影结果；`messages` 与旧 Chat Doc 派生的 StructuredMessage[] 同形。 */
export interface SyncChatProjection {
  readonly messages: readonly StructuredMessage[];
  readonly contentDocCount: number;
  readonly recordCount: number;
  readonly skippedRecords: number;
  readonly invalidUpdates: number;
}

const EMPTY_PROJECTION: SyncChatProjection = Object.freeze({
  messages: Object.freeze([]),
  contentDocCount: 0,
  recordCount: 0,
  skippedRecords: 0,
  invalidUpdates: 0,
});

/** 空投影是稳定单例：hook 在关闭/重置时用它避免无意义的重渲染。 */
export function emptySyncChatProjection(): SyncChatProjection {
  return EMPTY_PROJECTION;
}

/** docId 谱系：`sync/content/<generation>/<blockIndex>/<nonce>`。 */
export function parseContentDocId(docId: string): { generation: string; blockIndex: number } | null {
  const parts = docId.split("/");
  if (parts.length !== 5 || parts[0] !== "sync" || parts[1] !== "content") return null;
  const generation = parts[2];
  const nonce = parts[4];
  if (!/^(0|[1-9][0-9]*)$/.test(parts[3])) return null;
  const blockIndex = Number(parts[3]);
  if (!generation || !nonce || !Number.isSafeInteger(blockIndex) || blockIndex < 0) return null;
  return { generation, blockIndex };
}

export interface SyncContentProjectionHubOptions {
  /** 每次镜像内容变化后回调一次（microtask 合并，同一批 update 只重算一次）。 */
  readonly onProjection: (projection: SyncChatProjection) => void;
}

export interface SyncContentProjectionHub {
  /** 应用一段 content Doc 的 Yjs update；非 content doc / 异代次返回 false。 */
  applyUpdate(input: { readonly docId: string; readonly generation: string; readonly payload: Uint8Array }): boolean;
  /** 换代/重连：销毁全部镜像 Doc 并把可见投影清空。 */
  reset(generation: string | null): void;
  snapshot(): SyncChatProjection;
  dispose(): void;
}

interface MirrorDoc {
  readonly doc: Y.Doc;
  readonly blockIndex: number;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** final descriptor 的完成时间：非法 JSON / 缺字段一律视为没有时间，不影响正文。 */
function readCompletedAt(payload: Uint8Array): number | null {
  try {
    const value = asRecord(JSON.parse(UTF8_DECODER.decode(payload)));
    const completedAt = value?.completedAt;
    return typeof completedAt === "number" && Number.isFinite(completedAt) && completedAt >= 0 ? completedAt : null;
  } catch {
    return null;
  }
}

interface EntryAccumulator {
  readonly entryId: string;
  readonly parts: Array<{ readonly position: number; readonly text: string }>;
  firstPosition: number;
  firstEntryOrder: number | null;
  completedAt: number | null;
}

interface MessageCacheEntry {
  readonly signature: string;
  readonly message: StructuredMessage;
}

function projectDocs(
  docs: readonly MirrorDoc[],
  invalidUpdates: number,
  messageCache: Map<string, MessageCacheEntry>,
): SyncChatProjection {
  const ordered = [...docs].sort((left, right) => left.blockIndex - right.blockIndex);
  const entries = new Map<string, EntryAccumulator>();
  const seenRecords = new Set<string>();
  let recordCount = 0;
  let skippedRecords = 0;

  for (const [docOrder, mirror] of ordered.entries()) {
    const root = mirror.doc.getMap<unknown>("root");
    const records = root.get("records");
    if (!(records instanceof Y.Array)) continue;
    const values: unknown[] = records.toArray();
    for (const [index, raw] of values.entries()) {
      const record = asRecord(raw);
      if (record === null) {
        skippedRecords += 1;
        continue;
      }
      const entryId = record.entryId;
      const kind = record.kind;
      const payload = record.payload;
      if (
        typeof entryId !== "string" ||
        entryId.length === 0 ||
        typeof kind !== "string" ||
        !(payload instanceof Uint8Array)
      ) {
        skippedRecords += 1;
        continue;
      }
      const position = docOrder * 1_000_000_000 + index;
      const recordId =
        typeof record.recordId === "string" && record.recordId.length > 0
          ? `record:${mirror.doc.guid}:${record.recordId}`
          : `position:${mirror.doc.guid}:${index}`;
      if (seenRecords.has(recordId)) continue;
      seenRecords.add(recordId);

      let entry = entries.get(entryId);
      if (entry === undefined) {
        entry = {
          entryId,
          parts: [],
          firstPosition: position,
          firstEntryOrder: null,
          completedAt: null,
        };
        entries.set(entryId, entry);
      }
      const entryOrder = record.entryOrder;
      if (typeof entryOrder === "number" && Number.isFinite(entryOrder)) {
        entry.firstEntryOrder =
          entry.firstEntryOrder === null ? entryOrder : Math.min(entry.firstEntryOrder, entryOrder);
      }

      if (kind === "final") {
        const completedAt = readCompletedAt(payload);
        if (completedAt !== null) {
          entry.completedAt = entry.completedAt === null ? completedAt : Math.max(entry.completedAt, completedAt);
        }
        recordCount += 1;
        continue;
      }
      if (kind !== "text" && kind !== "text_part") {
        // history_object / tool_object 的保真 JSON 尚无入口映射，不猜正文。
        skippedRecords += 1;
        continue;
      }
      try {
        const text = UTF8_DECODER.decode(payload);
        entry.parts.push({ position, text });
        entry.firstPosition = Math.min(entry.firstPosition, position);
        recordCount += 1;
      } catch {
        skippedRecords += 1;
      }
    }
  }

  const orderedEntries = [...entries.values()].sort((left, right) => {
    const leftOrder = left.firstEntryOrder ?? left.firstPosition;
    const rightOrder = right.firstEntryOrder ?? right.firstPosition;
    return leftOrder - rightOrder || left.firstPosition - right.firstPosition;
  });

  const messages: StructuredMessage[] = [];
  const nextCache = new Map<string, MessageCacheEntry>();
  let seq = 0;
  for (const entry of orderedEntries) {
    const text = entry.parts
      .sort((left, right) => left.position - right.position)
      .map((part) => part.text)
      .join("");
    if (text.length === 0) continue;
    const ts = entry.completedAt ?? 0;
    const type = entry.entryId.endsWith(":user") ? "user_message" : "assistant_message";
    // 内容未变的 entry 复用同一个消息对象，旧 ChatView 的 React.memo 才能跳过整棵子树。
    const signature = `${String(seq)}|${type}|${String(ts)}|${text}`;
    const cachedMessage = messageCache.get(entry.entryId);
    const message: StructuredMessage =
      cachedMessage?.signature === signature
        ? cachedMessage.message
        : type === "user_message"
          ? { type: "user_message", id: entry.entryId, content: text, seq, ts }
          : {
              type: "assistant_message",
              id: entry.entryId,
              chunks: [{ type: "message", text }],
              seq,
              ts,
            };
    nextCache.set(entry.entryId, { signature, message });
    messages.push(message);
    seq += 1;
  }
  messageCache.clear();
  for (const [entryId, cachedEntry] of nextCache) messageCache.set(entryId, cachedEntry);

  return Object.freeze({
    messages: Object.freeze(messages),
    contentDocCount: ordered.length,
    recordCount,
    skippedRecords,
    invalidUpdates,
  });
}

export function createSyncContentProjectionHub(options: SyncContentProjectionHubOptions): SyncContentProjectionHub {
  const docs = new Map<string, MirrorDoc>();
  const messageCache = new Map<string, MessageCacheEntry>();
  let generation: string | null = null;
  let invalidUpdates = 0;
  let dirty = true;
  let cached: SyncChatProjection = EMPTY_PROJECTION;
  let disposed = false;
  let notifyScheduled = false;

  function scheduleNotify(): void {
    if (disposed || notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      if (!disposed) options.onProjection(snapshot());
    });
  }

  function snapshot(): SyncChatProjection {
    if (!dirty) return cached;
    cached = projectDocs([...docs.values()], invalidUpdates, messageCache);
    dirty = false;
    return cached;
  }

  return {
    applyUpdate(input: { readonly docId: string; readonly generation: string; readonly payload: Uint8Array }): boolean {
      if (disposed) return false;
      const parsed = parseContentDocId(input.docId);
      if (parsed === null || parsed.generation !== input.generation) return false;
      if (generation === null) generation = input.generation;
      if (generation !== input.generation) return false;
      let mirror = docs.get(input.docId);
      const created = mirror === undefined;
      if (mirror === undefined) {
        mirror = { doc: new Y.Doc({ guid: input.docId }), blockIndex: parsed.blockIndex };
        docs.set(input.docId, mirror);
      }
      try {
        Y.applyUpdate(mirror.doc, input.payload);
        dirty = true;
        scheduleNotify();
        return true;
      } catch {
        // 失败候选可能已被部分写入：丢弃它，后续完整基线会重新建立镜像。
        if (created) {
          mirror.doc.destroy();
          docs.delete(input.docId);
        }
        invalidUpdates += 1;
        dirty = true;
        scheduleNotify();
        return false;
      }
    },

    reset(nextGeneration: string | null): void {
      if (disposed) return;
      generation = nextGeneration;
      for (const mirror of docs.values()) mirror.doc.destroy();
      docs.clear();
      messageCache.clear();
      invalidUpdates = 0;
      dirty = true;
      scheduleNotify();
    },

    snapshot,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const mirror of docs.values()) mirror.doc.destroy();
      docs.clear();
      messageCache.clear();
    },
  };
}
