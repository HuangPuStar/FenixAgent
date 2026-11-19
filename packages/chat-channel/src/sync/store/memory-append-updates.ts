import * as Y from "yjs";
import { contentDocOverflow } from "../capacity/content-doc-limits";
import type { SyncCapacityProfile } from "../capacity/profile";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { commitAccountedSets } from "./memory-accounting";
import { analyzeContentUpdate, appendContentUsage, contentUpdateUsage } from "./memory-content-usage";
import type { MemoryContentBatchState } from "./memory-live-content-batch";
import { compositeKey, copyBytes, copyRef, fail, type StoredDoc } from "./memory-store-state";
import { changedCoverageGenerations } from "./memory-text-coverage-revision";
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
    // 便宜上界能证明安全时不重建；临界区按真实 Yjs 编码检查，整批提交前失败不污染任何 Doc。
    const accountedBytes = state.updates.accountedBytes(key, "hotDocLive");
    const bound =
      doc.baseSnapshot.byteLength +
      (accountedBytes === undefined
        ? ledger.reduce((sum, item) => sum + item.bytes.byteLength, 0)
        : accountedBytes / 2) +
      records.reduce((sum, item) => sum + item.bytes.byteLength, 0);
    let contentUsage = doc.contentUsage;
    const deltas = doc.kind === "content" ? records.map((record) => analyzeContentUpdate(record.bytes)) : [];
    if (doc.kind === "content") {
      if (list.at(-1)!.fromSeq - doc.baseSeq > deps.capacity.inputs.maxTransactionsPerDoc)
        fail("CAPACITY_EXCEEDED", "content transaction capacity exceeded");
      if (contentUsage) contentUsage = appendContentUsage(contentUsage, deltas);
    }
    const limits = deps.capacity.inputs;
    const needsContentCheck =
      doc.kind === "content" &&
      (!contentUsage ||
        contentUsage.recordCountUpper > limits.maxRecordsPerDoc ||
        contentUsage.maxPayloadBytes > limits.payloadChunkMaxBytes ||
        bound > limits.activeHardEncodedBytes);
    if (bound > MAX_DOC_SNAPSHOT_BYTES || needsContentCheck) {
      const projection = new Y.Doc();
      try {
        Y.applyUpdate(projection, doc.baseSnapshot);
        for (const item of ledger) Y.applyUpdate(projection, item.bytes);
        for (const item of records) Y.applyUpdate(projection, item.bytes);
        const snapshot = Y.encodeStateAsUpdate(projection);
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
      invalidatesCoverage: deltas.some(
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
        ...(doc.kind === "content" ? { contentUsage, textCoverage: undefined, textCoverageRevision: undefined } : {}),
      },
    };
  });
  const generations = changedCoverageGenerations(state, [
    ...pending.filter((item) => item.invalidatesCoverage).map((item) => item.doc),
    ...refs.filter((ref) => ref.value.lookupKind === "live-text" && state.refs.has(ref.key)).map((ref) => ref.value),
  ]);
  const batch = { digest: input.digest, frontiers: frontiers.map((item) => ({ ...item })) };
  commitAccountedSets((changes) => {
    for (const generation of generations) changes.push(state.generations.prepare(generation.key, generation.next));
    for (const { doc, records, next } of pending) {
      const key = compositeKey(input.scopeKey, doc.docId);
      changes.push(state.docs.prepareSharing(key, next, ["transportCache"]));
      changes.push(state.updates.prepareAppend(key, records));
    }
    for (const ref of refs) changes.push(state.refs.prepare(ref.key, ref.value));
    changes.push(state.batches.prepare(batchKey, batch));
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
