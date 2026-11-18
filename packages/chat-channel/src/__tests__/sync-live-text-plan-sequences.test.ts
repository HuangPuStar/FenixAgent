import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { captureChange } from "../sync/live/change-capture";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import type { LiveRecordValue } from "../sync/live/live-writer-types";
import { planLiveTextBatch } from "../sync/live/text-batch-plan";
import { applyFrontiers, concatParts, expectedFrontiers, records } from "../sync/live/writer-support";
import { textBatchFixture } from "./sync-live-text-batch-plan-fixture";

// 同批物理片也占事务硬额度；轮换必须在下一片越限前发生，确认前不得提前推进游标。
test.each([
  { maxTransactions: 1, counts: [1, 1, 1, 1], finalSeqs: [1, 1, 1] },
  { maxTransactions: 2, counts: [2, 2], finalSeqs: [2] },
])("rotates at $maxTransactions transactions and confirms each physical frontier after commit", async ({
  maxTransactions,
  counts,
  finalSeqs,
}) => {
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: {
      ...DEFAULT_SYNC_CAPACITY.inputs,
      payloadChunkMaxBytes: 64,
      activeHardEncodedBytes: 1000,
      maxTransactionsPerDoc: maxTransactions,
    },
  };
  const f = await textBatchFixture(capacity);
  const text = "A".repeat(64) + "B".repeat(64) + "C".repeat(64) + "D".repeat(64);
  const plan = await planLiveTextBatch({ ...f, request: f.request(text) });
  try {
    const content = [...plan.cursors.values()].filter((cursor) => cursor.kind === "content");
    expect(content.map((cursor) => plan.slices.filter((slice) => slice.docId === cursor.docId).length)).toEqual([
      ...counts,
    ]);
    expect(plan.seals.map((seal) => seal.finalSeq)).toEqual([...finalSeqs]);
    expect(content.every((cursor) => cursor.lastSeq === 0)).toBe(true);
    expect(f.cursor.lastSeq).toBe(0);
    for (const cursor of content) {
      expect(plan.slices.filter((slice) => slice.docId === cursor.docId).map((slice) => slice.fromSeq)).toEqual(
        maxTransactions === 1 ? [1] : [1, 2],
      );
    }
    const result = await f.store.commitContentBatch({
      scopeKey: f.scopeKey,
      epoch: f.lease.epoch,
      owner: f.lease.owner,
      generation: f.generation,
      batchId: `transaction-limit-${maxTransactions}`,
      digest: f.digest(concatParts(plan.slices.map((slice) => slice.bytes))),
      updates: [...plan.slices],
      expectedFrontiers: expectedFrontiers(plan.slices),
      newDocs: [...plan.newDocs],
      seals: [...plan.seals],
      expectedPointerRevision: plan.expectedPointerRevision,
    });
    expect(result.outcome).toBe("committed");
    applyFrontiers(plan.cursors, result.frontiers);
    plan.commit();
    expect(content.map((cursor) => cursor.lastSeq)).toEqual([...counts]);
    expect(plan.finalCursor.lastSeq).toBe(maxTransactions);
    const restored: string[] = [];
    for (const cursor of content) {
      const loaded = await loadCommittedDoc(f.store, cursor.docId);
      try {
        expect(loaded!.lastSeq).toBe(maxTransactions);
        restored.push(
          ...(records<LiveRecordValue>(loaded!.doc)?.toArray() ?? []).map((record) =>
            new TextDecoder().decode(record.payload),
          ),
        );
      } finally {
        loaded?.doc.destroy();
      }
    }
    expect(restored.join("")).toBe(text);
  } finally {
    plan.dispose();
    plan.finalCursor.doc.destroy();
    f.cursor.doc.destroy();
    f.store.dispose();
  }
  expect(f.admission.used("hotDocLive")).toBe(0);
  expect(f.admission.used("persistSeal")).toBe(0);
});

// 已提交事务与本批物理片共用同一个硬限，旧块确认至2，新块从1连续开始。
test("counts the committed frontier before planning additional transactions in the current document", async () => {
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: {
      ...DEFAULT_SYNC_CAPACITY.inputs,
      payloadChunkMaxBytes: 64,
      activeHardEncodedBytes: 1000,
      maxTransactionsPerDoc: 2,
    },
  };
  const f = await textBatchFixture(capacity);
  const priorPayload = new TextEncoder().encode("prior|");
  const prior = captureChange(f.cursor.doc, () =>
    records(f.cursor.doc, [
      {
        recordId: "prior-record",
        entryId: "entry",
        contentSlot: "text",
        contentType: "text/plain",
        kind: "text",
        partIndex: 0,
        payload: priorPayload,
      },
    ]),
  );
  if (prior === null) throw new Error("fixture produced no prior update");
  await f.store.appendUpdates({
    scopeKey: f.scopeKey,
    epoch: f.lease.epoch,
    owner: f.lease.owner,
    batchId: "prior-transaction",
    digest: f.digest(prior),
    expectedFrontiers: [{ docId: f.cursor.docId, lastSeq: 0 }],
    updates: [{ docId: f.cursor.docId, fromSeq: 1, bytes: prior }],
  });
  f.cursor.lastSeq = 1;
  const text = "A".repeat(64) + "B".repeat(64) + "C".repeat(64);
  const plan = await planLiveTextBatch({ ...f, request: f.request(text) });
  try {
    expect(plan.seals.map((seal) => seal.finalSeq)).toEqual([2]);
    expect(plan.slices.filter((slice) => slice.docId === f.cursor.docId).map((slice) => slice.fromSeq)).toEqual([2]);
    expect(plan.slices.filter((slice) => slice.docId === plan.finalCursor.docId).map((slice) => slice.fromSeq)).toEqual(
      [1, 2],
    );
    expect(plan.cursors.get(f.cursor.docId)!.lastSeq).toBe(1);
    expect(plan.finalCursor.lastSeq).toBe(0);
    const result = await f.store.commitContentBatch({
      scopeKey: f.scopeKey,
      epoch: f.lease.epoch,
      owner: f.lease.owner,
      generation: f.generation,
      batchId: "continued-transactions",
      digest: f.digest(concatParts(plan.slices.map((slice) => slice.bytes))),
      updates: [...plan.slices],
      expectedFrontiers: expectedFrontiers(plan.slices),
      newDocs: [...plan.newDocs],
      seals: [...plan.seals],
      expectedPointerRevision: plan.expectedPointerRevision,
    });
    expect(result.outcome).toBe("committed");
    applyFrontiers(plan.cursors, result.frontiers);
    plan.commit();
    expect(plan.cursors.get(f.cursor.docId)!.lastSeq).toBe(2);
    expect(plan.finalCursor.lastSeq).toBe(2);
    const restored: string[] = [];
    for (const docId of [f.cursor.docId, plan.finalCursor.docId]) {
      const loaded = await loadCommittedDoc(f.store, docId);
      try {
        restored.push(
          ...(records<LiveRecordValue>(loaded!.doc)?.toArray() ?? []).map((record) =>
            new TextDecoder().decode(record.payload),
          ),
        );
      } finally {
        loaded?.doc.destroy();
      }
    }
    expect(restored.join("")).toBe(`prior|${text}`);
  } finally {
    plan.dispose();
    plan.finalCursor.doc.destroy();
    f.cursor.doc.destroy();
    f.store.dispose();
  }
  expect(f.admission.used("hotDocLive")).toBe(0);
  expect(f.admission.used("persistSeal")).toBe(0);
});
