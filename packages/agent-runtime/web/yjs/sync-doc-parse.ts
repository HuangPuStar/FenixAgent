// packages/agent-runtime/web/yjs/sync-doc-parse.ts
// content Doc 记录解析：把扁平记录映射为按 entry 聚合的文本/边界 parts。
// 与投影构建拆分，便于独立测试记录 kind 的兼容性（text / text_part / tool_boundary / final）。

import * as Y from "yjs";

export interface ParsedPart {
  readonly index: number;
  readonly kind: "text" | "boundary";
  readonly text: string;
  /** 边界记录的工具 id：用于重放/重复标记去重；缺失时按普通边界处理。 */
  readonly toolCallId: string | null;
  /** 边界序号（writer/history 提供）；旧标记缺省为 null，无法做连续性校验。 */
  readonly ordinal: number | null;
}

export interface DocEntryContribution {
  entryOrder: number | null;
  completedAt: number | null;
  /** 该 entry 在本 Doc 全部记录中的最小下标（含 final/跳过记录，与旧 firstPosition 语义一致）。 */
  firstRecordIndex: number;
  readonly parts: ParsedPart[];
  recordCount: number;
}

export interface ParsedContentDoc {
  readonly contribution: Map<string, DocEntryContribution>;
  readonly recordCount: number;
  readonly skippedRecords: number;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * 正文槽位：实时写者用字符串 `text`，历史导入的 `text_part` 用数字 0。
 * reasoning 等其余字符串槽位不属于正文；放进正文会让思考混入回答（issue #37）。
 */
function isBodySlot(contentSlot: unknown): boolean {
  return typeof contentSlot !== "string" || contentSlot === "text";
}

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
export function parseContentDoc(doc: Y.Doc): ParsedContentDoc {
  const contribution = new Map<string, DocEntryContribution>();
  let recordCount = 0;
  let skippedRecords = 0;
  const records = doc.getMap<unknown>("root").get("records");
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
      // 有序工具边界：新载荷 { toolCallId, ordinal }；旧载荷是 JSON 字符串形式的工具 id。
      let toolCallId: string | null = null;
      let ordinal: number | null = null;
      try {
        const value: unknown = JSON.parse(UTF8_DECODER.decode(payload));
        if (typeof value === "string" && value.length > 0) {
          toolCallId = value;
        } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const boundary = value as Record<string, unknown>;
          if (typeof boundary.toolCallId === "string" && boundary.toolCallId.length > 0) {
            toolCallId = boundary.toolCallId;
          }
          if (typeof boundary.ordinal === "number" && Number.isInteger(boundary.ordinal) && boundary.ordinal >= 0) {
            ordinal = boundary.ordinal;
          }
        }
      } catch {
        toolCallId = null;
      }
      entry.parts.push({ index, kind: "boundary", text: "", toolCallId, ordinal });
      entry.recordCount += 1;
      recordCount += 1;
      continue;
    }
    if (kind === "text_part") {
      if (!isBodySlot(record.contentSlot)) {
        entry.recordCount += 1;
        recordCount += 1;
        continue;
      }
      // 历史记录的载荷是保真 JSON：字符串值带引号与转义，直接按 UTF-8 当正文会显示成 `"hello"`。
      // 实时 `text` 记录才是裸 UTF-8 片段（见 live-writer 的 writeText）。
      try {
        const value: unknown = JSON.parse(UTF8_DECODER.decode(payload));
        if (typeof value !== "string") {
          skippedRecords += 1;
          continue;
        }
        entry.parts.push({ index, kind: "text", text: value, toolCallId: null, ordinal: null });
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
    if (!isBodySlot(record.contentSlot)) {
      entry.recordCount += 1;
      recordCount += 1;
      continue;
    }
    try {
      const text = UTF8_DECODER.decode(payload);
      entry.parts.push({ index, kind: "text", text, toolCallId: null, ordinal: null });
      entry.recordCount += 1;
      recordCount += 1;
    } catch {
      skippedRecords += 1;
    }
  }
  return { contribution, recordCount, skippedRecords };
}
