import * as Y from "yjs";
import type { Reservation } from "../capacity/admission";
import { TEXT_DOCUMENT_METADATA_BYTES } from "../capacity/text-plan-reservations";
import type { DigestFn } from "../clock";
import { textClaimLookupId } from "../live/text-claim-identity";
import { commitAccountedSets } from "./memory-accounting";
import type { MemoryContentBatchState } from "./memory-live-content-batch";
import { compositeKey, fail, type StoredDoc } from "./memory-store-state";
import { coverageRevision } from "./memory-text-coverage-revision";
import { canonicalContentRecords, validLiveTextRef } from "./memory-text-records";
import type { LiveTextCoverageQuery } from "./read-types";
import type { SyncRefRecord } from "./types";

/** 记录可能尚未接入 root；按完整编码保守纳入所有潜在 live 文本身份。 */
export function textLookupIds(
  snapshot: Uint8Array,
  scopeKey: string,
  generation: string,
  digest: DigestFn,
): ReadonlySet<string> | null {
  const result = new Set<string>();
  for (const struct of Y.decodeUpdate(snapshot).structs) {
    if (!(struct instanceof Y.Item)) continue;
    const content = struct.content;
    if (!(content instanceof Y.ContentAny || content instanceof Y.ContentJSON || content instanceof Y.ContentEmbed))
      continue;
    for (const value of content.getContent() as unknown[]) {
      if (value === null || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (record.kind !== "text") continue;
      if (
        typeof record.entryId !== "string" ||
        typeof record.contentSlot !== "string" ||
        !(record.payload instanceof Uint8Array)
      )
        return null;
      result.add(
        textClaimLookupId(digest, { scopeKey, generation, entryId: record.entryId, contentSlot: record.contentSlot }),
      );
    }
  }
  return result;
}

/** 恢复后的证明仅由当前 canonical 与实际索引重建；一次只持有一个候选和一个索引目标。 */
export function readMemoryTextCoverage(
  query: LiveTextCoverageQuery,
  state: MemoryContentBatchState,
  digest: DigestFn,
): ReadonlySet<string> {
  const queryBytes = query.docIds.reduce((sum, id) => sum + 128 + id.length * 2, 128);
  const queryCharge = state.memoryBudget?.reserve("controlIndex", queryBytes * 2);
  try {
    const result = new Set<string>();
    const generationKey = compositeKey(query.scopeKey, query.generation);
    const generation = state.generations.get(generationKey);
    if (!generation) return result;
    const revision = coverageRevision(generation);
    const load = (doc: StoredDoc) => {
      const ledger = state.updates.get(compositeKey(doc.scopeKey, doc.docId)) ?? [];
      const encodedBytes = doc.baseSnapshot.byteLength + ledger.reduce((sum, item) => sum + item.bytes.byteLength, 0);
      const charges: Reservation[] = [];
      // 更新可能含密集小结构；编码字节同时覆盖解码放大、身份集和 canonical 定位临时 Map。
      try {
        const hot = state.memoryBudget?.reserve("hotDocLive", TEXT_DOCUMENT_METADATA_BYTES + encodedBytes * 64);
        if (hot) charges.push(hot);
        const indexes = state.memoryBudget?.reserve("controlIndex", 4096 + encodedBytes * 16);
        if (indexes) charges.push(indexes);
      } catch (error) {
        for (const charge of charges) charge.release();
        throw error;
      }
      const value = new Y.Doc();
      const dispose = () => {
        value.destroy();
        for (const charge of charges) charge.release();
      };
      try {
        Y.applyUpdate(value, doc.baseSnapshot);
        for (const update of ledger) Y.applyUpdate(value, update.bytes);
        return { value, dispose };
      } catch (error) {
        dispose();
        throw error;
      }
    };
    for (const id of new Set(query.docIds)) {
      const key = compositeKey(query.scopeKey, id),
        doc = state.docs.get(key);
      if (doc?.kind !== "content" || doc.generation !== query.generation || doc.state === "retired") continue;
      if (doc.textCoverage === true && doc.textCoverageRevision === revision) {
        result.add(id);
        continue;
      }
      const loaded = load(doc),
        value = loaded.value;
      const observedRefs = new Map<string, SyncRefRecord>();
      const observedDocs = new Map<string, StoredDoc>([[key, doc]]);
      let covered = true;
      try {
        const identities = textLookupIds(Y.encodeStateAsUpdate(value), query.scopeKey, query.generation, digest);
        if (!identities) covered = false;
        for (const lookupId of identities ?? []) {
          const refKey = [query.scopeKey, query.generation, "live-text", lookupId, 0, 0].join("\u0000");
          const ref = state.refs.get(refKey);
          const targetKey = ref && compositeKey(query.scopeKey, ref.docId),
            target = targetKey && state.docs.get(targetKey);
          if (
            !ref ||
            !target ||
            target.generation !== query.generation ||
            target.kind !== "content" ||
            target.state === "retired"
          ) {
            covered = false;
            break;
          }
          observedRefs.set(refKey, ref);
          observedDocs.set(targetKey, target);
          const targetLoaded = target === doc ? null : load(target);
          const targetValue = targetLoaded?.value ?? value;
          try {
            if (!validLiveTextRef(ref, canonicalContentRecords(targetValue).get(ref.recordId), digest)) {
              covered = false;
              break;
            }
          } finally {
            targetLoaded?.dispose();
          }
        }
      } finally {
        loaded.dispose();
      }
      let valid = true;
      commitAccountedSets((pending) => {
        if (covered)
          pending.push(
            state.docs.prepareSharing(key, { ...doc, textCoverage: covered, textCoverageRevision: revision }, [
              "transportCache",
            ]),
          );
        valid =
          state.generations.get(generationKey) === generation &&
          coverageRevision(generation) === revision &&
          [...observedDocs].every(([k, before]) => state.docs.get(k) === before) &&
          [...observedRefs].every(([k, before]) => state.refs.get(k) === before);
        if (!valid) fail("SEQUENCE_GAP", "text coverage changed during admission");
      });
      if (covered && valid) result.add(id);
    }
    if (state.generations.get(generationKey) !== generation || coverageRevision(generation) !== revision)
      fail("SEQUENCE_GAP", "text coverage generation changed during admission");
    return result;
  } finally {
    queryCharge?.release();
  }
}
