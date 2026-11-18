import { expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { captureChange } from "../sync/live/change-capture";
import { records } from "../sync/live/writer-support";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

/** 在旧写入配置下创建真实已提交内容，随后按新配置恢复，避免伪造无法提交的前驱。 */
async function legacyBlock(limits: Partial<typeof DEFAULT_SYNC_CAPACITY.inputs>, texts: readonly string[]) {
  const f = await contentBatchFixture();
  const doc = new Y.Doc();
  for (const [index, text] of texts.entries()) {
    const update = captureChange(doc, () =>
      records(doc, [
        {
          recordId: `old-${index}`,
          entryId: `old-${index}`,
          contentSlot: "text",
          contentType: "text/plain",
          kind: "text",
          partIndex: 0,
          payload: new TextEncoder().encode(text),
        },
      ]),
    )!;
    await f.store.appendUpdates({
      ...f.input,
      batchId: `old-${index}`,
      updates: [{ docId: f.ids[0], fromSeq: index + 1, bytes: update }],
      expectedFrontiers: [{ docId: f.ids[0], lastSeq: index }],
    });
  }
  const snapshot = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  const exported = f.store.exportCommittedState();
  f.store.dispose();
  const store = new MemoryProjectionStore({
    clock: { now: () => 1000 },
    digest: sha256Digest,
    capacity: { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, ...limits } },
    memoryBudget: f.admission,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  store.restoreFromCommittedState(exported);
  const lease = await store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
  f.input.epoch = lease.epoch;
  f.input.updates = f.input.updates.filter((update) => update.docId !== f.ids[0]);
  f.input.expectedFrontiers = f.input.expectedFrontiers.map((frontier) =>
    frontier.docId === f.ids[0] ? { ...frontier, lastSeq: texts.length } : frontier,
  );
  f.input.seals[0] = {
    ...f.input.seals[0],
    finalSeq: texts.length,
    finalSnapshot: snapshot,
    finalHash: sha256Digest(snapshot),
  };
  return { ...f, store, snapshot };
}

for (const item of [
  { name: "事务", limits: { maxTransactionsPerDoc: 2 }, texts: ["a", "b", "c"] },
  { name: "记录", limits: { maxRecordsPerDoc: 1 }, texts: ["a", "b"] },
  { name: "编码和载荷", limits: { activeHardEncodedBytes: 500, payloadChunkMaxBytes: 64 }, texts: ["x".repeat(700)] },
]) {
  // 新写入限制不能反向禁止封口已提交的旧块，未增长的旧前沿必须完整保留。
  test(`已超过新${item.name}限制的旧块仍可无新增封口`, async () => {
    const f = await legacyBlock(item.limits, item.texts);
    try {
      expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
      const sealed = await f.store.readDocStateAt(f.ids[0], item.texts.length);
      expect(sealed?.snapshot).toEqual(f.snapshot);
      expect(await f.store.readSuccessor(f.input.scopeKey, f.ids[0])).toMatchObject({
        state: "sealed",
        route: { successorDocId: f.ids[1], expectedLastSeq: item.texts.length },
      });
    } finally {
      f.store.dispose();
    }
  });
}

for (const limit of ["maxRecordsPerDoc", "maxTransactionsPerDoc"] as const) {
  // 通用追加与文本原子批次对增长中的正文使用相同硬限制，拒绝时不留下任何前缀。
  test(`通用追加同样拒绝增长超过${limit}的正文`, async () => {
    const f = await contentBatchFixture({
      ...DEFAULT_SYNC_CAPACITY,
      inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, [limit]: 1 },
    });
    const doc = new Y.Doc();
    try {
      for (let index = 0; index < 2; index++) {
        const update = captureChange(doc, () =>
          records(doc, [{ recordId: `grow-${index}`, payload: new Uint8Array([index]) }]),
        )!;
        const input = {
          ...f.input,
          batchId: `grow-${index}`,
          updates: [{ docId: f.ids[0], fromSeq: index + 1, bytes: update }],
          expectedFrontiers: [{ docId: f.ids[0], lastSeq: index }],
        };
        if (index === 0) expect((await f.store.appendUpdates(input)).outcome).toBe("committed");
        else {
          const before = f.store.exportCommittedState(),
            usage = f.usage();
          await expect(f.store.appendUpdates(input)).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
          expect(f.store.exportCommittedState()).toEqual(before);
          expect(f.usage()).toEqual(usage);
        }
      }
    } finally {
      doc.destroy();
      f.store.dispose();
    }
  });
}
