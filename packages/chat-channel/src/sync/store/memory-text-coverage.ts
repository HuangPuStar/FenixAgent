import * as Y from "yjs";
import type { Reservation } from "../capacity/admission";
import type { DigestFn } from "../clock";
import { textClaimLookupId } from "../live/text-claim-identity";
import { commitAccountedSets } from "./memory-accounting";
import { isCoverageBudgetRefusal, loadCoverageDoc } from "./memory-coverage-loader";
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

/** 证明只暂留身份和行前像；候选销毁后才加载其它目标，默认池无需同时容纳两个正文。 */
export function readMemoryTextCoverage(
  query: LiveTextCoverageQuery,
  state: MemoryContentBatchState,
  digest: DigestFn,
): ReadonlySet<string> {
  let queryCharge: Reservation | undefined;
  try {
    const queryBytes = query.docIds.reduce((sum, id) => sum + 128 + id.length * 2, 128);
    try {
      queryCharge = state.memoryBudget?.reserve("controlIndex", queryBytes * 2);
    } catch (error) {
      if (isCoverageBudgetRefusal(error)) return new Set();
      throw error;
    }
    const result = new Set<string>(),
      generationKey = compositeKey(query.scopeKey, query.generation),
      generation = state.generations.get(generationKey);
    if (!generation) return result;
    const revision = coverageRevision(generation);
    for (const id of new Set(query.docIds)) {
      const key = compositeKey(query.scopeKey, id),
        doc = state.docs.get(key);
      if (doc?.kind !== "content" || doc.generation !== query.generation || doc.state === "retired") continue;
      if (doc.textCoverage === true && doc.textCoverageRevision === revision) {
        result.add(id);
        continue;
      }
      const loaded = loadCoverageDoc(doc, state);
      if (!loaded) continue;
      const observedRefs = new Map<string, SyncRefRecord>(),
        observedDocs = new Map<string, StoredDoc>([[key, doc]]),
        targets = new Map<StoredDoc, SyncRefRecord[]>();
      let covered = true;
      try {
        // 此作用域不向后携带 canonical 对象或 payload，只留下身份和已计费的存储行指针。
        (() => {
          const value = loaded.value,
            canonical = canonicalContentRecords(value),
            identities = textLookupIds(loaded.snapshot(), query.scopeKey, query.generation, digest);
          if (!identities) {
            covered = false;
            return;
          }
          for (const lookupId of identities) {
            const refKey = [query.scopeKey, query.generation, "live-text", lookupId, 0, 0].join("\u0000"),
              ref = state.refs.get(refKey);
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
            if (target === doc) {
              if (!validLiveTextRef(ref, canonical.get(ref.recordId), digest)) {
                covered = false;
                break;
              }
            } else {
              const refs = targets.get(target) ?? [];
              refs.push(ref);
              targets.set(target, refs);
            }
          }
        })();
        loaded.releaseBody();
        if (covered)
          for (const [target, refs] of targets) {
            const other = loadCoverageDoc(target, state);
            if (!other) {
              covered = false;
              break;
            }
            try {
              const valid = (() => {
                const canonical = canonicalContentRecords(other.value);
                return refs.every((ref) => validLiveTextRef(ref, canonical.get(ref.recordId), digest));
              })();
              if (!valid) {
                covered = false;
                break;
              }
            } finally {
              other.dispose();
            }
          }
        commitAccountedSets((pending) => {
          if (covered)
            try {
              pending.push(
                state.docs.prepareSharing(key, { ...doc, textCoverage: true, textCoverageRevision: revision }, [
                  "transportCache",
                ]),
              );
            } catch (error) {
              if (!isCoverageBudgetRefusal(error)) throw error;
              covered = false;
            }
          if (
            state.generations.get(generationKey) !== generation ||
            coverageRevision(generation) !== revision ||
            [...observedDocs].some(([k, before]) => state.docs.get(k) !== before) ||
            [...observedRefs].some(([k, before]) => state.refs.get(k) !== before)
          )
            fail("SEQUENCE_GAP", "text coverage changed during admission");
        });
        if (covered) result.add(id);
      } finally {
        targets.clear();
        observedDocs.clear();
        observedRefs.clear();
        loaded.dispose();
      }
    }
    if (state.generations.get(generationKey) !== generation || coverageRevision(generation) !== revision)
      fail("SEQUENCE_GAP", "text coverage generation changed during admission");
    return result;
  } finally {
    queryCharge?.release();
  }
}
