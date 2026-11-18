import { SyncProtocolError } from "../protocol/errors";
import { assertIdentifier } from "../protocol/identity";
import type { HistoryRecordKind, HistoryRecordMeta } from "./ingest";

/** 归一化后的记录头：缺省字段收敛成 `null`，重复判定与身份键都不必再做 `undefined` 分叉。 */
interface NormalizedMeta {
  kind: HistoryRecordKind;
  entryId: string | null;
  contentSlot: number | null;
  partIndex: number | null;
  sourceRevision: number | null;
}

/** 非法输入统一出口：message 只描述字段与违规类型，绝不回显内容。 */
function malformed(message: string): SyncProtocolError {
  return new SyncProtocolError("MALFORMED_FRAME", { message });
}

/** kind 是记录结构的第一分叉：未知 kind 说明调用方与帧格式脱节，必须在写入任何字节之前拒绝。 */
function assertRecordKind(value: unknown): HistoryRecordKind {
  switch (value) {
    case "history_object":
    case "text_part":
    case "tool_object":
    case "tool_boundary":
      return value;
    default:
      throw malformed("unknown history record kind");
  }
}

/** `entryId` 是重复判定的唯一来源：给出时必须是合法标识（非空、≤256 字节、无控制字符）。 */
function requireEntryId(value: unknown): string {
  if (typeof value !== "string") {
    throw malformed('record meta "entryId" must be a string');
  }
  assertIdentifier(value, "entryId");
  return value;
}

/** 槽位与片段号必须是非负安全整数：负数或小数会让「第几片」在重组时不可解释。 */
function optionalIndex(value: unknown, field: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(`record meta "${field}" must be a non-negative integer`);
  }
  return value;
}

/** 校验并归一化记录头；字段全程可选，但给出即必须合法（缺省字段不猜测语义，见 `identityOf`）。 */
export function normalizeMeta(meta: HistoryRecordMeta): NormalizedMeta {
  if (typeof meta !== "object" || meta === null) {
    throw malformed("record meta must be an object");
  }
  if (meta.role !== undefined && meta.role !== "user" && meta.role !== "assistant" && meta.role !== "system") {
    throw malformed('record meta "role" must be user, assistant or system');
  }
  return {
    sourceRevision: optionalIndex(meta.sourceRevision, "sourceRevision"),
    kind: assertRecordKind(meta.kind),
    entryId: meta.entryId === undefined ? null : requireEntryId(meta.entryId),
    contentSlot: optionalIndex(meta.contentSlot, "contentSlot"),
    partIndex: optionalIndex(meta.partIndex, "partIndex"),
  };
}

/**
 * 记录身份 = `kind` + `entryId` + `contentSlot` + `partIndex`。规格里「同一 `sourceOrdinal` 二次提交」与「已接收
 * 对象再提交」在本模块是同一件事：ordinal 由本模块签发，调用方无法自带 ordinal，重复只能表现为「同一身份第二次
 * 提交」；没有 `entryId` 时返回 `null`——没有稳定源身份就不去重（设计 §5.3），内容相同的对象都必须保留。
 */
export function identityOf(meta: NormalizedMeta): string | null {
  if (meta.entryId === null) {
    return null;
  }
  return JSON.stringify([meta.kind, meta.entryId, meta.contentSlot, meta.partIndex, meta.sourceRevision]);
}
