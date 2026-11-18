import { expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { captureChange } from "../sync/live/change-capture";
import { records } from "../sync/live/writer-support";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

/** 同一 Doc 的相邻更新仍属于同一次原子批次，封口必须使用本批的最终前沿。 */
async function multiUpdateFixture() {
  const f = await contentBatchFixture();
  for (const index of [0, 1]) {
    const initial = f.input.updates.find((update) => update.docId === f.ids[index])!;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, initial.bytes);
      const delta = captureChange(doc, () =>
        records(doc, [
          {
            recordId: `extra-${index}`,
            entryId: "entry",
            contentSlot: "text",
            contentType: "text/plain",
            partIndex: 1,
            kind: "text",
            payload: new TextEncoder().encode(`extra-${index}`),
          },
        ]),
      )!;
      const at = f.input.updates.indexOf(initial);
      f.input.updates.splice(at + 1, 0, { docId: initial.docId, fromSeq: 2, bytes: delta });
      const snapshot = Y.encodeStateAsUpdate(doc);
      f.input.seals[index] = {
        ...f.input.seals[index],
        finalSeq: 2,
        finalSnapshot: snapshot,
        finalHash: sha256Digest(snapshot),
      };
    } finally {
      doc.destroy();
    }
  }
  return f;
}

// 原子性属于整批提交，而不是将同 Doc 的所有物理更新压成一个不可发送的大帧。
test("同一原子批次允许新旧内容块的多条连续更新", async () => {
  const f = await multiUpdateFixture();
  try {
    const result = await f.store.commitContentBatch(f.input);
    expect(result.outcome).toBe("committed");
    for (const id of f.ids.slice(0, 2)) {
      const updates = await f.store.readUpdatesAfter(id, 0, 8);
      expect(updates.map((update) => update.updateSeq)).toEqual([1, 2]);
      expect(updates.every((update) => update.batchId === f.input.batchId && update.digest === f.input.digest)).toBe(
        true,
      );
      expect(result.frontiers).toContainEqual({ docId: id, lastSeq: 2 });
      expect(await f.store.readSuccessor(f.input.scopeKey, id)).toMatchObject({
        state: "sealed",
        route: { expectedLastSeq: 2 },
      });
    }
  } finally {
    f.store.dispose();
  }
});

// 末尾更新前沿错误不能把合法前缀发布，修正计划后仍可完整提交同一批次。
test("多更新原子批次拒绝末尾缺口且保持所有写前像", async () => {
  const f = await multiUpdateFixture();
  try {
    const before = f.store.exportCommittedState();
    const usage = f.usage();
    const last = f.input.updates.find((update) => update.docId === f.ids[1] && update.fromSeq === 2)!;
    last.fromSeq = 3;
    await expect(f.store.commitContentBatch(f.input)).rejects.toMatchObject({ code: "SEQUENCE_GAP" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
    last.fromSeq = 2;
    expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
  } finally {
    f.store.dispose();
  }
});
