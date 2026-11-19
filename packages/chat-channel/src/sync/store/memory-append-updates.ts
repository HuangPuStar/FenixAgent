import * as Y from "yjs";
import { contentDocOverflow } from "../capacity/content-doc-limits";
import { createEncodedStateBound } from "../capacity/encoded-state-bound";
import type { SyncCapacityProfile } from "../capacity/profile";
import { TEXT_CLAIM_REPLAY_MAX_BYTES } from "../capacity/text-claim-reservations";
import { WORKING_CREDIT } from "../capacity/working-credit";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { commitAccountedSets } from "./memory-accounting";
import { projectMemoryDoc } from "./memory-content-projection";
import { analyzeContentUpdate, appendContentUsage, contentMayShadow, contentUpdateUsage } from "./memory-content-usage";
import type { MemoryContentBatchState } from "./memory-live-content-batch";
import { compositeKey, copyBytes, copyRef, fail, type StoredDoc } from "./memory-store-state";
import { changedCoverageGenerations } from "./memory-text-coverage-revision";
import { canonicalContentRecords, canonicalSelectionChanged } from "./memory-text-records";
import type { AppendUpdatesInput, AppendUpdatesResult, SyncRefRecord } from "./types";

function assertSnapshotSize(snapshot: Uint8Array): void {
  if (snapshot.byteLength > MAX_DOC_SNAPSHOT_BYTES) fail("CAPACITY_EXCEEDED", "snapshot exceeds transport budget");
}
function refKey(ref: SyncRefRecord): string {
  return [ref.scopeKey, ref.generation, ref.lookupKind, ref.lookupId, ref.contentSlot, ref.partIndex].join("\u0000");
}

/** 通用追加与原子正文批次共用正文增长限制；整批拒绝不发布任何 Doc 或派生索引。 */
export function appendMemoryUpdates(
  raw: AppendUpdatesInput,
  state: MemoryContentBatchState,
  deps: {
    readonly capacity: SyncCapacityProfile;
    readonly assertLease: () => void;
    readonly assertWritableDoc: (scopeKey: string, docId: string) => StoredDoc;
  },
): AppendUpdatesResult {
  const input = {
    ...raw,
    expectedFrontiers: raw.expectedFrontiers.map((v) => ({ ...v })),
    updates: raw.updates.map((v) => ({ ...v })),
    refs: raw.refs?.map(copyRef),
  };

  const batchKey = compositeKey(input.scopeKey, input.batchId);
  const prior = state.batches.get(batchKey);
  if (prior !== undefined)
    return prior.digest === input.digest
      ? { outcome: "already-committed", frontiers: prior.frontiers.map((item) => ({ ...item })) }
      : { outcome: "conflict", frontiers: [] };
  const expected = new Map(input.expectedFrontiers.map((item) => [item.docId, item.lastSeq]));
  if (expected.size !== input.expectedFrontiers.length) fail("MALFORMED_FRAME", "duplicate document frontier");
  const grouped = new Map<string, typeof input.updates>();
  for (const update of input.updates) {
    const doc = deps.assertWritableDoc(input.scopeKey, update.docId);
    if (!expected.has(update.docId)) fail("SEQUENCE_GAP", "missing expected frontier");
    if (doc.state !== "active") fail("RESOURCE_RETIRED", "sealing or sealed document cannot receive updates");
    const list = grouped.get(update.docId) ?? [];
    list.push(update);
    grouped.set(update.docId, list);
  }
  const frontiers: { docId: string; lastSeq: number }[] = [];
  for (const frontier of input.expectedFrontiers) {
    const doc = deps.assertWritableDoc(input.scopeKey, frontier.docId);
    if (doc.state !== "active") fail("RESOURCE_RETIRED", "sealing or sealed document cannot receive updates");
    if (doc.lastSeq !== frontier.lastSeq) fail("SEQUENCE_GAP", "document frontier is stale");
    let next = doc.lastSeq + 1;
    for (const update of grouped.get(doc.docId) ?? []) {
      if (update.fromSeq !== next) fail("SEQUENCE_GAP", "update sequence is not contiguous");
      next += 1;
    }
    frontiers.push({ docId: doc.docId, lastSeq: next - 1 });
  }
  // 先验证整批索引及 ledger 并复制字节，提交段不再执行可能失败的输入校验。
  const refs = (input.refs ?? []).map((ref) => {
    const doc = state.docs.get(compositeKey(input.scopeKey, ref.docId));
    if (ref.scopeKey !== input.scopeKey || doc === undefined || ref.generation !== doc.generation)
      fail("DOC_NOT_FOUND", "reference target is unknown");
    deps.assertWritableDoc(input.scopeKey, ref.docId);
    return { key: refKey(ref), value: copyRef(ref) };
  });
  const pending = [...grouped].map(([docId, list]) => {
    const key = compositeKey(input.scopeKey, docId);
    const ledger = state.updates.get(key);
    const doc = state.docs.get(key);
    if (ledger === undefined || doc === undefined) fail("DOC_NOT_FOUND", "document update ledger is unknown");
    const records = list.map((update) => ({
      scopeKey: input.scopeKey,
      generation: doc.generation,
      docId,
      updateSeq: update.fromSeq,
      bytes: copyBytes(update.bytes),
      batchId: input.batchId,
      digest: input.digest,
    }));
    let contentUsage = doc.contentUsage;
    let rewroteRecords = false;
    const deltas = doc.kind === "content" ? records.map((record) => analyzeContentUpdate(record.bytes)) : [];
    const mayShadow = contentUsage && contentMayShadow(contentUsage, deltas);
    const encoded = createEncodedStateBound(doc.encodedStateBound ?? doc.baseSnapshot);
    if (!doc.encodedStateBound) for (const item of ledger) encoded.add(item.bytes);
    let needsReplayCheck = false;
    for (let index = 0; index < records.length; index++) {
      if (doc.kind === "content") assertSnapshotSize(records[index].bytes);
      encoded.add(records[index].bytes, deltas[index]?.encoding);
      needsReplayCheck ||= doc.kind === "content" && encoded.upperBytes > TEXT_CLAIM_REPLAY_MAX_BYTES;
    }
    const bound = encoded.upperBytes;
    if (doc.kind === "content") {
      if (list.at(-1)!.fromSeq - doc.baseSeq > deps.capacity.inputs.maxTransactionsPerDoc)
        fail("CAPACITY_EXCEEDED", "content transaction capacity exceeded");
      if (contentUsage) contentUsage = appendContentUsage(contentUsage, deltas);
    }
    const limits = deps.capacity.inputs;
    const needsContentCheck =
      doc.kind === "content" &&
      (needsReplayCheck ||
        mayShadow ||
        !contentUsage ||
        contentUsage.recordCountUpper > limits.maxRecordsPerDoc ||
        contentUsage.maxPayloadBytes > limits.payloadChunkMaxBytes ||
        bound > limits.activeHardEncodedBytes);
    if (bound > MAX_DOC_SNAPSHOT_BYTES || needsContentCheck) {
      let priorRecords: unknown;
      let beforeCanonical: ReadonlyMap<string, unknown> = new Map();
      const projection = projectMemoryDoc(doc, ledger, records, (value) => {
        priorRecords = doc.kind === "content" ? value.getMap<unknown>("root").get("records") : undefined;
        if (doc.kind === "content") beforeCanonical = canonicalContentRecords(value);
      });
      try {
        rewroteRecords =
          (priorRecords instanceof Y.Array && projection.getMap<unknown>("root").get("records") !== priorRecords) ||
          (doc.kind === "content" && canonicalSelectionChanged(beforeCanonical, canonicalContentRecords(projection)));
        const snapshot = Y.encodeStateAsUpdate(projection);
        encoded.calibrate(snapshot.byteLength, projection);
        assertSnapshotSize(snapshot);
        if (doc.kind === "content") {
          const overflow = contentDocOverflow({
            doc: projection,
            capacity: deps.capacity,
            lastSeq: list.at(-1)!.fromSeq,
            baseSeq: doc.baseSeq,
            snapshot,
          });
          if (overflow) fail("CAPACITY_EXCEEDED", overflow);
          contentUsage = contentUpdateUsage(snapshot);
        }
      } finally {
        projection.destroy();
      }
    }
    return {
      doc,
      records,
      invalidatesCoverage:
        rewroteRecords ||
        deltas.some(
          (delta) =>
            delta.deletes ||
            delta.usage.hasLiveText ||
            (delta.opaque &&
              !(
                doc.lastSeq === 0 &&
                doc.baseSnapshot.length === 2 &&
                doc.baseSnapshot[0] === 0 &&
                doc.baseSnapshot[1] === 0
              )),
        ),
      next: {
        ...doc,
        lastSeq: list.at(-1)!.fromSeq,
        encodedStateBound: encoded.snapshot(),
        ...(doc.kind === "content" ? { contentUsage, textCoverage: undefined, textCoverageRevision: undefined } : {}),
      },
    };
  });
  const generations = changedCoverageGenerations(state, [
    ...pending.filter((item) => item.invalidatesCoverage).map((item) => item.doc),
    ...refs.filter((ref) => ref.value.lookupKind === "live-text" && state.refs.has(ref.key)).map((ref) => ref.value),
  ]);
  const batch = { digest: input.digest, frontiers: frontiers.map((item) => ({ ...item })) };
  const credit = input[WORKING_CREDIT];
  commitAccountedSets((changes) => {
    for (const generation of generations)
      changes.push(state.generations.prepare(generation.key, generation.next, credit));
    for (const { doc, records, next } of pending) {
      const key = compositeKey(input.scopeKey, doc.docId);
      changes.push(state.docs.prepareSharing(key, next, ["transportCache"], credit));
      changes.push(state.updates.prepareAppend(key, records, credit));
    }
    for (const ref of refs) changes.push(state.refs.prepare(ref.key, ref.value, credit));
    changes.push(state.batches.prepare(batchKey, batch, credit));
    deps.assertLease();
    for (const generation of generations)
      if (state.generations.get(generation.key) !== generation.before)
        fail("SEQUENCE_GAP", "text coverage generation changed during admission");
    if (state.batches.has(batchKey)) fail("DIGEST_CONFLICT", "batch identity changed during admission");
    for (const { doc } of pending) {
      const current = deps.assertWritableDoc(input.scopeKey, doc.docId);
      if (current !== doc || current.state !== "active" || current.lastSeq !== expected.get(doc.docId))
        fail("SEQUENCE_GAP", "append frontier changed during admission");
    }
  });
  return { outcome: "committed", frontiers };
}
