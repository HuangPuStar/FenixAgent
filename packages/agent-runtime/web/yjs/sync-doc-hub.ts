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
//
// 增量性：每个 content Doc 的解析结果按 Doc 缓存，只有收到更新的 Doc 才重新扫描 records；跨 Doc 的
// entry 聚合只失效受影响 entry 的正文缓存。大基线按块到达时不会每次全量解析所有块（旧实现 O(n²)）。

import type { StructuredMessage } from "@fenix/chat-channel";
import * as Y from "yjs";

/** 只读投影结果；`messages` 与旧 Chat Doc 派生的 StructuredMessage[] 同形。 */
export interface SyncChatProjection {
  readonly messages: readonly StructuredMessage[];
  /** 已解析、但被首屏窗口挡在 `messages` 之外的条目数；用于“显示更早”入口。 */
  readonly hiddenMessageCount: number;
  readonly contentDocCount: number;
  readonly recordCount: number;
  readonly skippedRecords: number;
  readonly invalidUpdates: number;
}

/** 首屏投影条目上限：即使单个内容块包含大量短消息，React 也只接收最近 N 条。 */
export const SYNC_PROJECTION_MESSAGE_WINDOW = 600;
/** 每次“显示更早”扩大的投影窗口条目数。 */
export const SYNC_PROJECTION_MESSAGE_STEP = 300;

const EMPTY_PROJECTION: SyncChatProjection = Object.freeze({
  messages: Object.freeze([]),
  hiddenMessageCount: 0,
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
  /** 首屏投影条目上限；缺省 200。 */
  readonly messageWindow?: number;
}

export interface SyncContentProjectionHub {
  /** 应用一段 content Doc 的 Yjs update；非 content doc / 异代次返回 false。 */
  applyUpdate(input: { readonly docId: string; readonly generation: string; readonly payload: Uint8Array }): boolean;
  /** 释放一个不再驻留的 content Doc 镜像；其独占条目从投影移除，跨 Doc 条目重新拼接。 */
  release(docId: string): boolean;
  /** 换代/重连：销毁全部镜像 Doc 并把可见投影清空，窗口回到首屏上限。 */
  reset(generation: string | null): void;
  /** 用户显式加载更早：扩大可见投影条目上限。 */
  growWindow(count?: number): void;
  snapshot(): SyncChatProjection;
  dispose(): void;
}

interface ParsedPart {
  readonly index: number;
  readonly kind: "text" | "boundary";
  readonly text: string;
  /** 边界记录的工具 id：用于重放/重复标记去重；缺失时按普通边界处理。 */
  readonly toolCallId: string | null;
}

interface DocEntryContribution {
  entryOrder: number | null;
  completedAt: number | null;
  /** 该 entry 在本 Doc 全部记录中的最小下标（含 final/跳过记录，与旧 firstPosition 语义一致）。 */
  firstRecordIndex: number;
  readonly parts: ParsedPart[];
  recordCount: number;
}

interface MirrorDoc {
  readonly doc: Y.Doc;
  readonly blockIndex: number;
  contribution: Map<string, DocEntryContribution>;
  dirty: boolean;
  recordCount: number;
  skippedRecords: number;
}

interface GlobalEntry {
  readonly byDoc: Map<string, DocEntryContribution>;
  firstEntryOrder: number | null;
  completedAt: number | null;
  /** 正文分段缓存：有序工具边界把文本切成与旧投影一致的段。 */
  segments: Array<{ ordinal: number; text: string }> | null;
  messages: StructuredMessage[] | null;
  signature: string | null;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const POSITION_STRIDE = 1_000_000_000;

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

/** 解析单个 Doc 的全部 records；返回的 contribution 只属于该 Doc。 */
function parseDoc(mirror: MirrorDoc): {
  contribution: Map<string, DocEntryContribution>;
  recordCount: number;
  skippedRecords: number;
} {
  const contribution = new Map<string, DocEntryContribution>();
  let recordCount = 0;
  let skippedRecords = 0;
  const records = mirror.doc.getMap<unknown>("root").get("records");
  if (!(records instanceof Y.Array)) return { contribution, recordCount, skippedRecords };

  const seenRecords = new Set<string>();
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
    const recordId =
      typeof record.recordId === "string" && record.recordId.length > 0
        ? `record:${record.recordId}`
        : `position:${index}`;
    if (seenRecords.has(recordId)) continue;
    seenRecords.add(recordId);

    let entry = contribution.get(entryId);
    if (entry === undefined) {
      entry = {
        entryOrder: null,
        completedAt: null,
        firstRecordIndex: index,
        parts: [],
        recordCount: 0,
      };
      contribution.set(entryId, entry);
    } else {
      entry.firstRecordIndex = Math.min(entry.firstRecordIndex, index);
    }
    const entryOrder = record.entryOrder;
    if (typeof entryOrder === "number" && Number.isFinite(entryOrder)) {
      entry.entryOrder = entry.entryOrder === null ? entryOrder : Math.min(entry.entryOrder, entryOrder);
    }

    if (kind === "final") {
      const completedAt = readCompletedAt(payload);
      if (completedAt !== null) {
        entry.completedAt = entry.completedAt === null ? completedAt : Math.max(entry.completedAt, completedAt);
      }
      entry.recordCount += 1;
      recordCount += 1;
      continue;
    }
    if (kind === "tool_boundary") {
      // 有序工具边界：载荷是工具 id 的保真 JSON 字符串；坏载荷仍保留边界（无法去重但不丢正文）。
      let toolCallId: string | null = null;
      try {
        const value: unknown = JSON.parse(UTF8_DECODER.decode(payload));
        if (typeof value === "string" && value.length > 0) toolCallId = value;
      } catch {
        toolCallId = null;
      }
      entry.parts.push({ index, kind: "boundary", text: "", toolCallId });
      entry.recordCount += 1;
      recordCount += 1;
      continue;
    }
    if (kind === "text_part") {
      // 历史记录的载荷是保真 JSON：字符串值带引号与转义，直接按 UTF-8 当正文会显示成 `"hello"`。
      // 实时 `text` 记录才是裸 UTF-8 片段（见 live-writer 的 writeText）。
      try {
        const value: unknown = JSON.parse(UTF8_DECODER.decode(payload));
        if (typeof value !== "string") {
          skippedRecords += 1;
          continue;
        }
        entry.parts.push({ index, kind: "text", text: value, toolCallId: null });
        entry.recordCount += 1;
        recordCount += 1;
      } catch {
        skippedRecords += 1;
      }
      continue;
    }
    if (kind !== "text") {
      // history_object / tool_object 的保真 JSON 尚无入口映射，不猜正文。
      skippedRecords += 1;
      continue;
    }
    try {
      const text = UTF8_DECODER.decode(payload);
      entry.parts.push({ index, kind: "text", text, toolCallId: null });
      entry.recordCount += 1;
      recordCount += 1;
    } catch {
      skippedRecords += 1;
    }
  }
  return { contribution, recordCount, skippedRecords };
}

export function createSyncContentProjectionHub(options: SyncContentProjectionHubOptions): SyncContentProjectionHub {
  const initialMessageWindow = Math.max(1, Math.floor(options.messageWindow ?? SYNC_PROJECTION_MESSAGE_WINDOW));
  let messageWindow = initialMessageWindow;
  const docs = new Map<string, MirrorDoc>();
  const entries = new Map<string, GlobalEntry>();
  let generation: string | null = null;
  let invalidUpdates = 0;
  let dirty = true;
  let cached: SyncChatProjection = EMPTY_PROJECTION;
  let disposed = false;
  let notifyScheduled = false;

  function invalidateEntry(entry: GlobalEntry): void {
    let firstEntryOrder: number | null = null;
    let completedAt: number | null = null;
    for (const contribution of entry.byDoc.values()) {
      if (contribution.entryOrder !== null) {
        firstEntryOrder =
          firstEntryOrder === null ? contribution.entryOrder : Math.min(firstEntryOrder, contribution.entryOrder);
      }
      if (contribution.completedAt !== null) {
        completedAt = completedAt === null ? contribution.completedAt : Math.max(completedAt, contribution.completedAt);
      }
    }
    entry.firstEntryOrder = firstEntryOrder;
    entry.completedAt = completedAt;
    entry.segments = null;
    entry.messages = null;
    entry.signature = null;
  }

  /** 同一 entry 的内容未变时复用旧贡献对象，保住正文/消息对象引用（React.memo 依赖）。 */
  function sameContribution(left: DocEntryContribution, right: DocEntryContribution): boolean {
    if (
      left.entryOrder !== right.entryOrder ||
      left.completedAt !== right.completedAt ||
      left.firstRecordIndex !== right.firstRecordIndex ||
      left.recordCount !== right.recordCount ||
      left.parts.length !== right.parts.length
    ) {
      return false;
    }
    for (let index = 0; index < left.parts.length; index += 1) {
      const leftPart = left.parts[index]!;
      const rightPart = right.parts[index]!;
      if (
        leftPart.index !== rightPart.index ||
        leftPart.kind !== rightPart.kind ||
        leftPart.text !== rightPart.text ||
        leftPart.toolCallId !== rightPart.toolCallId
      )
        return false;
    }
    return true;
  }

  /** 用新解析结果替换该 Doc 的贡献；只失效受影响的 entry，不动其他块的缓存。 */
  function replaceContribution(
    docId: string,
    mirror: MirrorDoc,
    next: Map<string, DocEntryContribution>,
    recordCount: number,
    skippedRecords: number,
  ): void {
    for (const entryId of mirror.contribution.keys()) {
      if (next.has(entryId)) continue;
      const entry = entries.get(entryId);
      if (entry === undefined) continue;
      entry.byDoc.delete(docId);
      if (entry.byDoc.size === 0) entries.delete(entryId);
      else invalidateEntry(entry);
    }
    for (const [entryId, contribution] of next) {
      const previous = mirror.contribution.get(entryId);
      if (previous !== undefined && sameContribution(previous, contribution)) {
        next.set(entryId, previous);
        continue;
      }
      let entry = entries.get(entryId);
      if (entry === undefined) {
        entry = {
          byDoc: new Map(),
          firstEntryOrder: null,
          completedAt: null,
          segments: null,
          messages: null,
          signature: null,
        };
        entries.set(entryId, entry);
      }
      entry.byDoc.set(docId, contribution);
      invalidateEntry(entry);
    }
    mirror.contribution = next;
    mirror.recordCount = recordCount;
    mirror.skippedRecords = skippedRecords;
  }

  function refreshDirtyDocs(): void {
    for (const [docId, mirror] of docs) {
      if (!mirror.dirty) continue;
      const parsed = parseDoc(mirror);
      replaceContribution(docId, mirror, parsed.contribution, parsed.recordCount, parsed.skippedRecords);
      mirror.dirty = false;
    }
  }

  function buildProjection(): SyncChatProjection {
    const orderedDocs = [...docs.entries()].sort((left, right) => left[1].blockIndex - right[1].blockIndex);
    const rank = new Map<string, number>();
    for (const [index, [docId]] of orderedDocs.entries()) rank.set(docId, index);

    const rows: Array<{ order: number; firstPosition: number; entryId: string; entry: GlobalEntry }> = [];
    for (const [entryId, entry] of entries) {
      let firstPosition = Number.POSITIVE_INFINITY;
      for (const docId of entry.byDoc.keys()) {
        const docRank = rank.get(docId);
        if (docRank === undefined) continue;
        const contribution = entry.byDoc.get(docId)!;
        firstPosition = Math.min(firstPosition, docRank * POSITION_STRIDE + contribution.firstRecordIndex);
      }
      if (!Number.isFinite(firstPosition)) continue;
      rows.push({ order: entry.firstEntryOrder ?? firstPosition, firstPosition, entryId, entry });
    }
    rows.sort((left, right) => left.order - right.order || left.firstPosition - right.firstPosition);

    let recordCount = 0;
    let skippedRecords = 0;
    for (const mirror of docs.values()) {
      recordCount += mirror.recordCount;
      skippedRecords += mirror.skippedRecords;
    }

    const messages: StructuredMessage[] = [];
    let seq = 0;
    for (const row of rows) {
      const entry = row.entry;
      if (entry.segments === null) {
        const parts: Array<{
          rank: number;
          index: number;
          kind: "text" | "boundary";
          text: string;
          toolCallId: string | null;
        }> = [];
        for (const [docId, contribution] of entry.byDoc) {
          const docRank = rank.get(docId);
          if (docRank === undefined) continue;
          for (const part of contribution.parts) {
            parts.push({
              rank: docRank,
              index: part.index,
              kind: part.kind,
              text: part.text,
              toolCallId: part.toolCallId,
            });
          }
        }
        parts.sort((left, right) => left.rank - right.rank || left.index - right.index);
        // 有序边界把正文切成段：连续边界（同一工具 run）不产生空段；
        // 同一 toolCallId 的重放标记被忽略，避免在文本中间多切一段。
        const segments: Array<{ ordinal: number; text: string }> = [];
        const seenBoundaries = new Set<string>();
        let current = "";
        let ordinal = 0;
        const flush = (): void => {
          if (current.length === 0) return;
          segments.push({ ordinal, text: current });
          ordinal += 1;
          current = "";
        };
        for (const part of parts) {
          if (part.kind === "boundary") {
            if (part.toolCallId !== null) {
              if (seenBoundaries.has(part.toolCallId)) continue;
              seenBoundaries.add(part.toolCallId);
            }
            flush();
            continue;
          }
          current += part.text;
        }
        flush();
        entry.segments = segments;
      }
      const segments = entry.segments;
      if (segments.length === 0) continue;
      const ts = entry.completedAt ?? 0;
      const type = row.entryId.endsWith(":user") ? "user_message" : "assistant_message";
      const signature = `${String(seq)}|${type}|${String(ts)}|${segments
        .map((segment) => `${String(segment.ordinal)}:${segment.text}`)
        .join("\u0000")}`;
      if (entry.messages === null || entry.signature !== signature) {
        // 内容未变的 entry 复用同一批消息对象，旧 ChatView 的 React.memo 才能跳过整棵子树。
        entry.messages = segments.map((segment, index) => {
          const id = segment.ordinal === 0 ? row.entryId : `${row.entryId}#${segment.ordinal}`;
          const messageSeq = seq + index;
          return type === "user_message"
            ? { type: "user_message", id, content: segment.text, seq: messageSeq, ts }
            : {
                type: "assistant_message",
                id,
                entryBaseId: row.entryId,
                chunks: [{ type: "message", text: segment.text }],
                seq: messageSeq,
                ts,
              };
        });
        entry.signature = signature;
      }
      for (const message of entry.messages) messages.push(message);
      seq += entry.messages.length;
    }

    return Object.freeze({
      messages: Object.freeze(messages.slice(Math.max(0, messages.length - messageWindow))),
      hiddenMessageCount: Math.max(0, messages.length - messageWindow),
      contentDocCount: orderedDocs.length,
      recordCount,
      skippedRecords,
      invalidUpdates,
    });
  }

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
    refreshDirtyDocs();
    cached = buildProjection();
    dirty = false;
    return cached;
  }

  function clearAll(): void {
    for (const mirror of docs.values()) mirror.doc.destroy();
    docs.clear();
    entries.clear();
    invalidUpdates = 0;
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
        mirror = {
          doc: new Y.Doc({ guid: input.docId }),
          blockIndex: parsed.blockIndex,
          contribution: new Map(),
          dirty: false,
          recordCount: 0,
          skippedRecords: 0,
        };
        docs.set(input.docId, mirror);
      }
      try {
        Y.applyUpdate(mirror.doc, input.payload);
        mirror.dirty = true;
        dirty = true;
        scheduleNotify();
        return true;
      } catch {
        // 失败候选可能已被部分写入：丢弃它，后续完整基线会重新建立镜像。
        if (created) {
          mirror.doc.destroy();
          docs.delete(input.docId);
        } else {
          mirror.dirty = true;
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
      messageWindow = initialMessageWindow;
      clearAll();
      dirty = true;
      scheduleNotify();
    },

    release(docId: string): boolean {
      if (disposed) return false;
      const mirror = docs.get(docId);
      if (mirror === undefined) return false;
      docs.delete(docId);
      mirror.doc.destroy();
      // 只失效该 Doc 参与的条目：独占条目直接移除，跨 Doc 条目重新拼接正文。
      for (const [entryId, entry] of [...entries]) {
        if (!entry.byDoc.delete(docId)) continue;
        if (entry.byDoc.size === 0) entries.delete(entryId);
        else invalidateEntry(entry);
      }
      dirty = true;
      scheduleNotify();
      return true;
    },

    growWindow(count = SYNC_PROJECTION_MESSAGE_STEP): void {
      if (disposed) return;
      messageWindow += Math.max(1, Math.floor(count));
      dirty = true;
      scheduleNotify();
    },

    snapshot,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearAll();
    },
  };
}
