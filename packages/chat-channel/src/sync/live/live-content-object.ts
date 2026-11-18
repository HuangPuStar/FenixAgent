import type { AdmissionController } from "../capacity/admission";
import type { SyncCapacityProfile } from "../capacity/profile";
import type { DigestFn } from "../clock";
import { fidelitySerialize } from "../history/fidelity-json";
import { admitHistoryObject } from "../history/object-admission";
import { planHistoryParts } from "../history/object-parts";
import { identityOf, normalizeMeta } from "../history/record-identity";
import { SyncProtocolError } from "../protocol/errors";
import type { ProjectionStore, SyncRefRecord } from "../store/types";
import { loadCommittedDoc } from "./committed-doc";
import type { LiveInput, LiveRecordValue } from "./live-writer-types";
import { records } from "./writer-support";

/** 分片定位与正文同事务写入，docId/recordId 由实际轮换后的追加入口补齐。 */
export type ContentObjectRef = Omit<SyncRefRecord, "docId" | "recordId">;

/** 定位命中仍以 canonical + tail 的记录为准，损坏索引不能冒充已提交。 */
async function alreadyCommitted(
  store: ProjectionStore,
  ref: ContentObjectRef,
  expected: LiveRecordValue,
): Promise<boolean> {
  const [located] = await store.locateRefs({ ...ref, limit: 1 });
  if (!located) return false;
  if (located.recordId !== expected.recordId)
    throw new SyncProtocolError("DIGEST_CONFLICT", { message: "live object identity already holds different content" });
  const loaded = await loadCommittedDoc(store, located.docId);
  if (!loaded)
    throw new SyncProtocolError("DOC_NOT_FOUND", { message: "live object reference has no committed document" });
  try {
    const record = records<LiveRecordValue>(loaded.doc)
      ?.toArray()
      .find((value) => value.recordId === expected.recordId);
    if (
      !record ||
      record.entryId !== expected.entryId ||
      record.partIndex !== expected.partIndex ||
      record.kind !== expected.kind ||
      record.role !== expected.role ||
      record.entryOrder !== expected.entryOrder ||
      record.contentType !== expected.contentType ||
      record.sourceRevision !== expected.sourceRevision ||
      record.contentSlot !== expected.contentSlot ||
      record.payload.byteLength !== expected.payload.byteLength ||
      record.payload.some((byte, i) => byte !== expected.payload[i])
    )
      throw new SyncProtocolError("MALFORMED_FRAME", {
        message: "live object reference differs from committed content",
      });
    return true;
  } finally {
    loaded.doc.destroy();
  }
}

/** 通用完整对象沿既有 live 提交与轮换入口写入；全部片提交后才结束。 */
export async function writeLiveContentObject(input: {
  readonly object: NonNullable<LiveInput["object"]>;
  readonly capacity: SyncCapacityProfile;
  readonly digest: DigestFn;
  readonly admission?: AdmissionController;
  readonly store: ProjectionStore;
  readonly scopeKey: string;
  readonly generation: string;
  readonly append: (
    record: Omit<LiveRecordValue, "recordId"> & { readonly recordId?: string },
    ref?: ContentObjectRef,
  ) => Promise<void>;
}): Promise<void> {
  const { value } = input.object;
  const meta = { ...input.object.meta };
  const accepted = admitHistoryObject(value, input.capacity, input.admission);
  try {
    const identity = identityOf(normalizeMeta(meta));
    const parts = planHistoryParts({
      value,
      meta,
      serializedBytes: accepted.bytes,
      recordBudgetBytes: input.capacity.inputs.payloadChunkMaxBytes,
      digest: input.digest,
    });
    if (parts.length > 1 && identity === null)
      throw new SyncProtocolError("MALFORMED_FRAME", { message: "multipart live content requires a stable entryId" });
    const lookupId = identity === null ? null : input.digest(fidelitySerialize(identity));
    const objectDigest = input.digest(accepted.bytes);
    for (const [index, part] of parts.entries()) {
      const payload = fidelitySerialize(part.value);
      const record = {
        entryId: meta.entryId ?? "content-object",
        entryOrder: meta.entryOrder,
        sourceRevision: meta.sourceRevision,
        role: meta.role,
        contentSlot: String(meta.contentSlot ?? 0),
        contentType: "application/json",
        kind: meta.kind,
        partIndex: part.meta.partIndex ?? 0,
        payload,
      };
      if (lookupId === null) {
        await input.append(record);
        continue;
      }
      const ref: ContentObjectRef = {
        scopeKey: input.scopeKey,
        generation: input.generation,
        lookupKind: "live-object",
        lookupId,
        contentSlot: 0,
        partIndex: index,
        orderStart: meta.entryOrder ?? 0,
        orderEnd: meta.entryOrder ?? 0,
        byteStart: 0,
        byteEnd: payload.byteLength,
      };
      const identified: LiveRecordValue = {
        ...record,
        recordId: `rec_${input.digest(fidelitySerialize([1, identity, objectDigest, parts.length, record.partIndex, record.role ?? null, record.entryOrder ?? null, input.digest(payload)]))}`,
      };
      if (!(await alreadyCommitted(input.store, ref, identified))) await input.append(identified, ref);
    }
  } finally {
    accepted.reservation?.release();
  }
}
