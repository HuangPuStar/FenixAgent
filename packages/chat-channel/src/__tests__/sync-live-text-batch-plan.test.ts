import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY, validateCapacityProfile } from "../sync/capacity/profile";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import type { LiveRecordValue } from "../sync/live/live-writer-types";
import { planLiveTextBatch } from "../sync/live/text-batch-plan";
import { applyFrontiers, concatParts, expectedFrontiers, records } from "../sync/live/writer-support";
import {
  directoryPageDocId,
  directoryRootDocId,
  readDirectoryPage,
  readDirectoryRoot,
} from "../sync/protocol/directory";
import { textBatchFixture } from "./sync-live-text-batch-plan-fixture";

const decoder = new TextDecoder();

/** 从规划携带的 canonical 与增量重放，独立核对持久化消费者实际可见的文本。 */
function replayText(
  plan: Awaited<ReturnType<typeof planLiveTextBatch>>,
  originalId: string,
  originalSnapshot?: Uint8Array,
) {
  const ids = [originalId, ...plan.newDocs.filter((doc) => doc.kind === "content").map((doc) => doc.docId)];
  return ids.flatMap((docId) => {
    const doc = new Y.Doc();
    try {
      const base = plan.newDocs.find((item) => item.docId === docId);
      if (docId === originalId && originalSnapshot) Y.applyUpdate(doc, originalSnapshot);
      if (base) Y.applyUpdate(doc, base.snapshot);
      for (const slice of plan.slices.filter((item) => item.docId === docId)) Y.applyUpdate(doc, slice.bytes);
      return records<LiveRecordValue>(doc)?.toArray() ?? [];
    } finally {
      doc.destroy();
    }
  });
}

describe("offline live text batch planning", () => {
  // 小载荷也会产生记录头、Y.Doc和封口字节，计费不得只随正文长度增长。
  test("reserves the retained bytes and document overhead of validated one-byte chunks", async () => {
    const capacity = {
      ...DEFAULT_SYNC_CAPACITY,
      inputs: {
        ...DEFAULT_SYNC_CAPACITY.inputs,
        payloadChunkMaxBytes: 1,
        activeHardEncodedBytes: 1024,
        directoryHardBytes: 8192,
      },
    };
    validateCapacityProfile(capacity);
    const f = await textBatchFixture(capacity);
    const plan = await planLiveTextBatch({ ...f, request: f.request("x".repeat(4000)) });
    try {
      const retained = new Set([
        ...plan.slices.map((value) => value.bytes),
        ...plan.seals.map((value) => value.finalSnapshot),
        ...plan.newDocs.map((value) => value.snapshot),
      ]);
      const bufferBytes = [...retained].reduce((sum, value) => sum + value.byteLength, 0);
      expect(bufferBytes).toBeLessThanOrEqual(f.admission.used("persistSeal"));
      expect(plan.cursors.size * 4096).toBeLessThanOrEqual(f.admission.used("hotDocLive"));
      expect(
        replayText(plan, f.cursor.docId)
          .map((record) => decoder.decode(record.payload))
          .join(""),
      ).toBe("x".repeat(4000));
    } finally {
      plan.dispose();
      f.cursor.doc.destroy();
      f.store.dispose();
    }
    expect(f.admission.used("hotDocLive")).toBe(0);
    expect(f.admission.used("persistSeal")).toBe(0);
  });

  // 可用额度不足时必须在构造众多小Doc之前拒绝，并保留整条输入可重试。
  test.each([
    2, 7, 12,
  ])("rejects record-heavy plans and releases partial reservations with a %i MiB live budget", async (limitMiB) => {
    const capacity = {
      ...DEFAULT_SYNC_CAPACITY,
      serverPools: { ...DEFAULT_SYNC_CAPACITY.serverPools, hotDocLive: limitMiB * 1024 * 1024 },
      inputs: {
        ...DEFAULT_SYNC_CAPACITY.inputs,
        payloadChunkMaxBytes: 1,
        activeHardEncodedBytes: 1024,
        directoryHardBytes: 8192,
      },
    };
    const f = await textBatchFixture(capacity);
    try {
      await expect(planLiveTextBatch({ ...f, request: f.request("x".repeat(4000)) })).rejects.toMatchObject({
        code: "ADMISSION_REJECTED",
      });
      await expect(
        planLiveTextBatch({ ...f, admission: undefined, request: f.request("x".repeat(4000)) }),
      ).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
      expect(records(f.cursor.doc)).toBeUndefined();
      expect(f.directory.tailContentDocId()).toBe(f.cursor.docId);
      expect(f.admission.used("hotDocLive")).toBe(0);
      expect(f.admission.used("persistSeal")).toBe(0);
    } finally {
      f.cursor.doc.destroy();
      f.store.dispose();
    }
  });

  // 原子化只改变提交边界；低soft水位不能新增正文轮换或改变已有订阅入口。
  test("keeps the existing content document until its encoded hard limit is reached", async () => {
    const capacity = {
      ...DEFAULT_SYNC_CAPACITY,
      inputs: {
        ...DEFAULT_SYNC_CAPACITY.inputs,
        activeSoftPayloadBytes: 100,
        payloadChunkMaxBytes: 100,
        activeHardEncodedBytes: 10000,
      },
    };
    const f = await textBatchFixture(capacity);
    const plan = await planLiveTextBatch({ ...f, request: f.request("x".repeat(350)) });
    try {
      expect(plan.finalCursor.docId).toBe(f.cursor.docId);
      expect(plan.newDocs).toHaveLength(0);
      expect(plan.seals).toHaveLength(0);
      expect(plan.slices).toHaveLength(1);
      expect(
        replayText(plan, f.cursor.docId)
          .map((record) => decoder.decode(record.payload))
          .join(""),
      ).toBe("x".repeat(350));
    } finally {
      plan.dispose();
      f.cursor.doc.destroy();
      f.store.dispose();
    }
  });

  // 若规划直接改动当前 Doc 或持久化，失败整批重试就会残留前缀。
  test("keeps the current document and committed state unchanged until the whole batch commits", async () => {
    const f = await textBatchFixture();
    const before = Y.encodeStateAsUpdate(f.cursor.doc);
    const plan = await planLiveTextBatch({ ...f, request: f.request("hello" + "hello") });
    try {
      expect(Y.encodeStateAsUpdate(f.cursor.doc)).toEqual(before);
      expect(await f.store.readUpdatesAfter(f.cursor.docId, 0, 100)).toHaveLength(0);
      expect(
        replayText(plan, f.cursor.docId)
          .map((record) => decoder.decode(record.payload))
          .join(""),
      ).toBe("hellohello");
      expect(plan.finalCursor.docId).toBe(f.cursor.docId);
      expect(plan.expectedPointerRevision).toBe(1);
      expect(f.admission.used("hotDocLive")).toBeGreaterThan(0);
    } finally {
      plan.dispose();
      f.cursor.doc.destroy();
    }
    expect(f.admission.used("hotDocLive")).toBe(0);
  });

  // 若按片提交或错用本次片序号，跨块文本会丢失、重复，或同槽 partIndex 不能从块内前沿推进。
  test("coalesces each document into one update while preserving text and block-local part indices", async () => {
    const capacity = {
      ...DEFAULT_SYNC_CAPACITY,
      inputs: {
        ...DEFAULT_SYNC_CAPACITY.inputs,
        payloadChunkMaxBytes: 100,
        activeSoftPayloadBytes: 200,
        activeHardEncodedBytes: 1000,
        maxRecordsPerDoc: 2,
      },
    };
    const f = await textBatchFixture(capacity);
    const text = "汉🙂".repeat(100);
    const plan = await planLiveTextBatch({ ...f, request: f.request(text) });
    try {
      const counts = new Map<string, number>();
      for (const slice of plan.slices) counts.set(slice.docId, (counts.get(slice.docId) ?? 0) + 1);
      expect([...counts.values()].every((count) => count === 1)).toBe(true);
      const content = replayText(plan, f.cursor.docId);
      expect(content.map((record) => decoder.decode(record.payload)).join("")).toBe(text);
      expect(content.map((record) => record.partIndex)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
      expect(content.every((record) => record.contentType === "text/plain" && record.entryId === "entry")).toBe(true);
      expect(plan.seals.length).toBeGreaterThan(0);
      expect(
        plan.newDocs
          .filter((doc) => doc.kind === "content")
          .every((doc) => {
            const initial = new Y.Doc();
            try {
              Y.applyUpdate(initial, doc.snapshot);
              return records(initial) === undefined;
            } finally {
              initial.destroy();
            }
          }),
      ).toBe(true);
    } finally {
      plan.dispose();
      f.cursor.doc.destroy();
    }
  });

  // 若目录翻页在内容批次之外提交，成功正文可能不能被订阅方发现。
  test("includes directory rollover and only installs its cached tail after commit", async () => {
    const capacity = {
      ...DEFAULT_SYNC_CAPACITY,
      inputs: {
        ...DEFAULT_SYNC_CAPACITY.inputs,
        payloadChunkMaxBytes: 100,
        activeSoftPayloadBytes: 100,
        activeHardEncodedBytes: 400,
      },
    };
    const f = await textBatchFixture(capacity, 64);
    const originalTail = f.directory.tailContentDocId();
    const plan = await planLiveTextBatch({ ...f, request: f.request("x".repeat(350)) });
    try {
      expect(f.directory.tailContentDocId()).toBe(originalTail);
      const newPage = plan.newDocs.find((doc) => doc.docId === directoryPageDocId(f.generation, 2));
      expect(newPage).toBeDefined();
      const page = new Y.Doc();
      try {
        Y.applyUpdate(page, newPage!.snapshot);
        for (const slice of plan.slices.filter((item) => item.docId === newPage!.docId))
          Y.applyUpdate(page, slice.bytes);
        expect(readDirectoryPage(page).contentDocIds.at(-1)).toBe(plan.finalCursor.docId);
        expect(readDirectoryPage(page).previousPageId).toBe(directoryPageDocId(f.generation, 1));
      } finally {
        page.destroy();
      }
      const rootId = directoryRootDocId(f.generation);
      const committedRoot = await loadCommittedDoc(f.store, rootId);
      try {
        for (const slice of plan.slices.filter((item) => item.docId === rootId))
          Y.applyUpdate(committedRoot!.doc, slice.bytes);
        expect(readDirectoryRoot(committedRoot!.doc).latestPageId).toBe(newPage!.docId);
      } finally {
        committedRoot?.doc.destroy();
      }
      const result = await f.store.commitContentBatch({
        scopeKey: f.scopeKey,
        epoch: f.lease.epoch,
        owner: f.lease.owner,
        generation: f.generation,
        batchId: "directory-plan",
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
      expect(f.directory.tailContentDocId()).toBe(plan.finalCursor.docId);
      const recovered = await loadCommittedDoc(f.store, plan.finalCursor.docId);
      try {
        expect(
          records<LiveRecordValue>(recovered!.doc)
            ?.toArray()
            .map((record) => decoder.decode(record.payload))
            .join(""),
        ).toBe("x".repeat(50));
      } finally {
        recovered?.doc.destroy();
      }
    } finally {
      plan.dispose();
      plan.finalCursor.doc.destroy();
      f.cursor.doc.destroy();
    }
  });

  // 若把16KiB合并阈值当作delta上限，合法大输入会被拒或截断；完整输入必须可跨多个硬限块。
  test("plans a legal four MiB flush across multiple content blocks without loss", async () => {
    const f = await textBatchFixture();
    records(f.cursor.doc, [
      {
        recordId: "seed",
        entryId: "seed",
        contentSlot: "text",
        contentType: "text/plain",
        kind: "text",
        partIndex: 0,
        payload: new TextEncoder().encode("seed"),
      },
    ]);
    const originalSnapshot = Y.encodeStateAsUpdate(f.cursor.doc);
    const text = "x".repeat(4 * 1024 * 1024);
    const plan = await planLiveTextBatch({ ...f, request: f.request(text) });
    try {
      expect(plan.seals.length).toBeGreaterThan(1);
      expect(
        plan.seals.every((seal) => seal.finalSnapshot.byteLength <= f.capacity.inputs.activeHardEncodedBytes),
      ).toBe(true);
      expect(
        replayText(plan, f.cursor.docId, originalSnapshot)
          .filter((record) => record.entryId === "entry")
          .map((record) => decoder.decode(record.payload))
          .join(""),
      ).toBe(text);
      expect(f.admission.used("hotDocLive")).toBeLessThanOrEqual(DEFAULT_SYNC_CAPACITY.serverPools.hotDocLive);
    } finally {
      plan.dispose();
      f.cursor.doc.destroy();
    }
    expect(f.admission.used("hotDocLive")).toBe(0);
  });

  // 若未预留规划驻留空间，多个合法delta会在单进程内无界堆积。
  test("rejects unavailable planning memory without leaking reservations or mutations", async () => {
    const f = await textBatchFixture();
    const occupied = f.admission.reserve("hotDocLive", DEFAULT_SYNC_CAPACITY.serverPools.hotDocLive - 1);
    try {
      await expect(planLiveTextBatch({ ...f, request: f.request("hello") })).rejects.toMatchObject({
        code: "ADMISSION_REJECTED",
      });
      expect(records(f.cursor.doc)).toBeUndefined();
      expect(f.directory.tailContentDocId()).toBe(f.cursor.docId);
    } finally {
      occupied.release();
      f.cursor.doc.destroy();
    }
    expect(f.admission.used("hotDocLive")).toBe(0);
  });

  // 合并窗口可能包含先前已接纳的短delta，完整flush不能被误按单raw帧上限拒绝。
  test("admits a configured flush containing a maximum frame plus the preceding merge window", async () => {
    const capacity = {
      ...DEFAULT_SYNC_CAPACITY,
      inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRawAcpFrameBytes: 100, liveMergeMaxBytes: 16 },
    };
    const f = await textBatchFixture(capacity);
    const plan = await planLiveTextBatch({ ...f, request: f.request("x".repeat(250)), maxFlushBytes: 300 });
    try {
      expect(
        replayText(plan, f.cursor.docId)
          .map((record) => decoder.decode(record.payload))
          .join(""),
      ).toBe("x".repeat(250));
    } finally {
      plan.dispose();
      f.cursor.doc.destroy();
    }
  });

  // 编码头也占硬限；失败试写不能把越界片留在前驱，也不能遗漏该片。
  test("moves an overflowing piece into the next document without leaving a prefix mutation", async () => {
    const capacity = {
      ...DEFAULT_SYNC_CAPACITY,
      inputs: {
        ...DEFAULT_SYNC_CAPACITY.inputs,
        payloadChunkMaxBytes: 100,
        activeSoftPayloadBytes: 10000,
        activeHardEncodedBytes: 700,
      },
    };
    const f = await textBatchFixture(capacity);
    const text = "x".repeat(1500);
    const plan = await planLiveTextBatch({ ...f, request: f.request(text) });
    try {
      expect(plan.seals.length).toBeGreaterThan(0);
      expect(plan.seals.every((seal) => seal.finalSnapshot.byteLength <= 700)).toBe(true);
      expect(Y.encodeStateAsUpdate(plan.finalCursor.doc).byteLength).toBeLessThanOrEqual(700);
      expect(
        replayText(plan, f.cursor.docId)
          .map((record) => decoder.decode(record.payload))
          .join(""),
      ).toBe(text);
      expect(records(f.cursor.doc)).toBeUndefined();
    } finally {
      plan.dispose();
      f.cursor.doc.destroy();
    }
  });

  // 记录连空Doc都装不下时须归还全部规划额度，原正文与目录保持可重试。
  test("releases planning memory when a text record cannot fit an empty document", async () => {
    const capacity = {
      ...DEFAULT_SYNC_CAPACITY,
      inputs: {
        ...DEFAULT_SYNC_CAPACITY.inputs,
        payloadChunkMaxBytes: 100,
        activeSoftPayloadBytes: 100,
        activeHardEncodedBytes: 100,
      },
    };
    const f = await textBatchFixture(capacity);
    await expect(planLiveTextBatch({ ...f, request: f.request("x".repeat(100)) })).rejects.toMatchObject({
      code: "CAPACITY_EXCEEDED",
    });
    expect(f.admission.used("hotDocLive")).toBe(0);
    expect(records(f.cursor.doc)).toBeUndefined();
    expect(f.directory.tailContentDocId()).toBe(f.cursor.docId);
    f.cursor.doc.destroy();
  });

  // 已提交槽位的片号从实际前沿继续；轮换后按新块局部前沿重新起算。
  test("continues the committed slot frontier and restores every piece after the atomic commit", async () => {
    const capacity = {
      ...DEFAULT_SYNC_CAPACITY,
      inputs: {
        ...DEFAULT_SYNC_CAPACITY.inputs,
        payloadChunkMaxBytes: 100,
        activeSoftPayloadBytes: 200,
        activeHardEncodedBytes: 1000,
        maxRecordsPerDoc: 2,
      },
    };
    const f = await textBatchFixture(capacity);
    records(f.cursor.doc, [
      {
        recordId: "prior",
        entryId: "entry",
        contentSlot: "text",
        contentType: "text/plain",
        kind: "text",
        partIndex: 0,
        payload: new TextEncoder().encode("prefix"),
      },
    ]);
    const priorSnapshot = Y.encodeStateAsUpdate(f.cursor.doc);
    await f.store.appendUpdates({
      scopeKey: f.scopeKey,
      epoch: f.lease.epoch,
      owner: f.lease.owner,
      batchId: "prior-text",
      digest: f.digest(priorSnapshot),
      expectedFrontiers: [{ docId: f.cursor.docId, lastSeq: 0 }],
      updates: [{ docId: f.cursor.docId, fromSeq: 1, bytes: priorSnapshot }],
    });
    f.cursor.lastSeq = 1;
    const text = "x".repeat(240);
    const plan = await planLiveTextBatch({ ...f, request: f.request(text) });
    try {
      expect(replayText(plan, f.cursor.docId, priorSnapshot).map((record) => record.partIndex)).toEqual([0, 1, 0, 1]);
      expect(plan.seals[0]?.finalSeq).toBe(2);
      const result = await f.store.commitContentBatch({
        scopeKey: f.scopeKey,
        epoch: f.lease.epoch,
        owner: f.lease.owner,
        generation: f.generation,
        batchId: "continued-text",
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
      const restored: string[] = [];
      for (const docId of [
        f.cursor.docId,
        ...plan.newDocs.filter((doc) => doc.kind === "content").map((doc) => doc.docId),
      ]) {
        const current = await loadCommittedDoc(f.store, docId);
        try {
          restored.push(
            ...(records<LiveRecordValue>(current!.doc)?.toArray() ?? []).map((record) =>
              decoder.decode(record.payload),
            ),
          );
        } finally {
          current?.doc.destroy();
        }
      }
      expect(restored.join("")).toBe(`prefix${text}`);
      expect(f.directory.tailContentDocId()).toBe(plan.finalCursor.docId);
    } finally {
      plan.dispose();
      plan.finalCursor.doc.destroy();
      f.cursor.doc.destroy();
    }
    expect(f.admission.used("hotDocLive")).toBe(0);
  });
});
