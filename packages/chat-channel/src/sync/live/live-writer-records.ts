// packages/chat-channel/src/sync/live/live-writer-records.ts
// 实时写者的语义实体/终态描述符构造（从 live-writer.ts 拆出，纯函数）。

import type * as Y from "yjs";
import type { DigestFn, RandomSource } from "../clock";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import type { Identity } from "./live-writer-internal";
import type { BarrierKind, LiveRecordValue } from "./live-writer-types";
import type { FinalEntityDescriptor, RuntimeEntityRecord } from "./runtime-doc";
import { bytes, hex, records, requireObject, requireString } from "./writer-support";

const ENTITY_KINDS: ReadonlySet<string> = new Set(["tool", "permission", "error", "cancel"]);

function malformed(message: string): never {
  const code: SyncErrorCode = "MALFORMED_FRAME";
  throw new SyncProtocolError(code, { message });
}

function isEntityKind(value: unknown): value is FinalEntityDescriptor["kind"] {
  return typeof value === "string" && ENTITY_KINDS.has(value);
}

export function entityOf(kind: BarrierKind, payload: Record<string, unknown>): RuntimeEntityRecord {
  if (kind === "final" || !ENTITY_KINDS.has(kind)) malformed(`semantic kind ${kind} is not a runtime entity`);
  const toolCallId = payload.toolCallId;
  if (toolCallId !== undefined && typeof toolCallId !== "string") malformed("invalid toolCallId");
  const metadata = payload.metadata === undefined ? {} : requireObject(payload.metadata, "semantic metadata");
  const entity = { entityId: requireString(payload, "entityId"), kind, metadata, state: "open" as const };
  return toolCallId === undefined ? entity : { ...entity, toolCallId };
}

export function descriptorOf(payload: Record<string, unknown>, entityId: string): FinalEntityDescriptor {
  const { kind, contentRef, digest, byteLength, completedAt } = requireObject(payload.finalDescriptor, "descriptor");
  if (!isEntityKind(kind) || typeof contentRef !== "string" || typeof digest !== "string") malformed("bad descriptor");
  const size = typeof byteLength === "number" ? byteLength : Number.NaN;
  if (!Number.isSafeInteger(size) || size < 0 || typeof completedAt !== "number") malformed("bad descriptor");
  if (!Number.isFinite(completedAt)) malformed("bad descriptor");
  return { entityId, kind, contentRef, digest, byteLength: size, completedAt };
}

/** 固定记录身份与物理字节，重复提交使用同一份记录。 */
export function buildLiveRecord(
  random: RandomSource,
  id: Identity,
  kind: LiveRecordValue["kind"],
  payload: Uint8Array,
  partIndex: number,
): LiveRecordValue {
  return {
    recordId: `rec_${hex(random, 8)}`,
    entryId: id.entryId,
    contentSlot: id.contentSlot,
    contentType: id.contentType ?? "",
    partIndex,
    kind,
    payload,
  };
}
/** 已提交块内同槽的下一条文本片段序号。 */
export function nextContentPartIndex(doc: Y.Doc, key: { entryId: string; contentSlot: string }): number {
  const existing = records<LiveRecordValue>(doc)?.toArray() ?? [];
  return existing.filter((value) => value.entryId === key.entryId && value.contentSlot === key.contentSlot).length;
}

/** 从当前块的同槽前沿构造下一条记录；分片序号随块内实际记录推进。 */
export function buildNextLiveRecord(
  random: RandomSource,
  doc: Y.Doc,
  id: Identity,
  kind: LiveRecordValue["kind"],
  payload: Uint8Array,
): LiveRecordValue {
  return buildLiveRecord(random, id, kind, payload, nextContentPartIndex(doc, id));
}

/** 构造终态内容与引用描述符，调用方须与运行态实体移除一同提交。 */
export function buildTerminalRecords(input: {
  readonly random: RandomSource;
  readonly digest: DigestFn;
  readonly doc: Y.Doc;
  readonly entityId: string;
  readonly kind: Exclude<BarrierKind, "final">;
  readonly metadata: Record<string, unknown>;
  readonly completedAt: number;
}): readonly [LiveRecordValue, LiveRecordValue] {
  const identity: Identity = {
    entryId: `${input.entityId}:final`,
    contentSlot: "final",
    contentType: "final-descriptor",
  };
  const payload = bytes(JSON.stringify({ entityId: input.entityId, kind: input.kind, metadata: input.metadata }));
  const record = buildNextLiveRecord(input.random, input.doc, identity, "final", payload);
  const descriptor: FinalEntityDescriptor = {
    entityId: input.entityId,
    kind: input.kind,
    contentRef: record.recordId,
    digest: input.digest(payload),
    byteLength: payload.byteLength,
    completedAt: input.completedAt,
  };
  return [
    record,
    buildLiveRecord(input.random, identity, "final", bytes(JSON.stringify(descriptor)), record.partIndex + 1),
  ];
}
