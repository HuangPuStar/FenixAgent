import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { captureChange } from "../sync/live/change-capture";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { records } from "../sync/live/writer-support";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

/** 在同一真实正文块生成连续追加，失败重试保持原字节和前沿。 */
function append(f: Awaited<ReturnType<typeof contentBatchFixture>>, doc: Y.Doc, seq: number, values: unknown[]) {
  const bytes = captureChange(doc, () => records(doc, values))!;
  return {
    ...f.input,
    batchId: `usage-${seq}`,
    digest: `usage-${seq}`,
    updates: [{ docId: f.ids[0], fromSeq: seq, bytes }],
    expectedFrontiers: [{ docId: f.ids[0], lastSeq: seq - 1 }],
  };
}

// 小增量应按新增内容检查，连续写入不能同步重放全部旧 tail。
test("安全水位下连续正文追加的重放次数保持线性", async () => {
  const f = await contentBatchFixture();
  const doc = new Y.Doc();
  const apply = spyOn(Y, "applyUpdate");
  try {
    for (let seq = 1; seq <= 80; seq++)
      expect(
        (await f.store.appendUpdates(append(f, doc, seq, [{ recordId: `r-${seq}`, payload: new Uint8Array([seq]) }])))
          .outcome,
      ).toBe("committed");
    expect(apply.mock.calls.length).toBeLessThan(240);
    apply.mockRestore();
    const loaded = await loadCommittedDoc(f.store, f.ids[0]);
    try {
      expect(records(loaded!.doc)?.length).toBe(80);
    } finally {
      loaded!.doc.destroy();
    }
  } finally {
    apply.mockRestore();
    doc.destroy();
    f.store.dispose();
  }
});

// 同一 ContentAny 可带多条记录，不能把 structs 个数误作新增记录数。
test("单个更新中的多记录仍按完整记录数拒绝", async () => {
  const f = await contentBatchFixture({
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRecordsPerDoc: 2 },
  });
  const doc = new Y.Doc();
  try {
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    await expect(
      f.store.appendUpdates(
        append(
          f,
          doc,
          1,
          [1, 2, 3].map((n) => ({ recordId: `r-${n}`, payload: new Uint8Array([n]) })),
        ),
      ),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
  } finally {
    doc.destroy();
    f.store.dispose();
  }
});

// 恢复入口不能信任调用方伪造的派生用量，否则旧记录会被当成空块。
test("恢复时忽略伪造用量并保留记录与载荷限制", async () => {
  const f = await contentBatchFixture({
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRecordsPerDoc: 2 },
  });
  const doc = new Y.Doc();
  try {
    await f.store.appendUpdates(append(f, doc, 1, [{ recordId: "old", payload: new Uint8Array([1]) }]));
    const snapshot = f.store.exportCommittedState();
    for (const value of snapshot.docs)
      Object.assign(value, { contentUsage: { recordCountUpper: 0, maxPayloadBytes: 0 } });
    f.store.restoreFromCommittedState(snapshot);
    const lease = await f.store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
    const input = append(f, doc, 2, [
      { recordId: "next", payload: new Uint8Array([2]) },
      { recordId: "overflow", payload: new Uint8Array([3]) },
    ]);
    await expect(f.store.appendUpdates({ ...input, epoch: lease.epoch })).rejects.toMatchObject({
      code: "CAPACITY_EXCEEDED",
    });
    expect(f.store.exportCommittedState().docs.every((value) => !("contentUsage" in value))).toBe(true);
  } finally {
    doc.destroy();
    f.store.dispose();
  }
});

// 额度拒绝不能推进用量缓存，原批重试仍可达到同一个合法前沿。
test("正文用量与额度准备一同回滚", async () => {
  const f = await contentBatchFixture({
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRecordsPerDoc: 2 },
  });
  const doc = new Y.Doc();
  try {
    await f.store.appendUpdates(append(f, doc, 1, [{ recordId: "first", payload: new Uint8Array([1]) }]));
    const input = append(f, doc, 2, [{ recordId: "second", payload: new Uint8Array([2]) }]);
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    f.admission.remaining = 0;
    await expect(f.store.appendUpdates(input)).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
    f.admission.remaining = null;
    expect((await f.store.appendUpdates(input)).outcome).toBe("committed");
  } finally {
    doc.destroy();
    f.store.dispose();
  }
});

// 先到达的子结构可以暂存在 Yjs pending，后续父引用接入不得激活超限旧载荷。
test("待接入结构的载荷也纳入保守上界", async () => {
  const f = await contentBatchFixture({
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, payloadChunkMaxBytes: 64 },
  });
  const doc = new Y.Doc();
  try {
    const parent = captureChange(doc, () => records(doc, []))!;
    const child = captureChange(doc, () => records(doc, [{ recordId: "pending", payload: new Uint8Array(65) }]))!;
    const first = {
      ...f.input,
      batchId: "pending-child",
      digest: "pending-child",
      updates: [{ docId: f.ids[0], fromSeq: 1, bytes: child }],
      expectedFrontiers: [{ docId: f.ids[0], lastSeq: 0 }],
    };
    expect((await f.store.appendUpdates(first)).outcome).toBe("committed");
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    await expect(
      f.store.appendUpdates({
        ...first,
        batchId: "pending-parent",
        digest: "pending-parent",
        updates: [{ docId: f.ids[0], fromSeq: 2, bytes: parent }],
        expectedFrontiers: [{ docId: f.ids[0], lastSeq: 1 }],
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
  } finally {
    doc.destroy();
    f.store.dispose();
  }
});

// 通用追加和原子文本批次交替使用同一前沿，不能沿用原子提交前的旧上界。
test("原子正文批次刷新后续通用追加的用量", async () => {
  const f = await contentBatchFixture({
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRecordsPerDoc: 3 },
  });
  const doc = new Y.Doc();
  try {
    await f.store.appendUpdates(append(f, doc, 1, [{ recordId: "first", payload: new Uint8Array([1]) }]));
    const second = append(f, doc, 2, [
      { recordId: "second", payload: new Uint8Array([2]) },
      { recordId: "third", payload: new Uint8Array([3]) },
    ]);
    expect((await f.store.commitContentBatch({ ...second, newDocs: [], seals: [] })).outcome).toBe("committed");
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    await expect(
      f.store.appendUpdates(append(f, doc, 3, [{ recordId: "overflow", payload: new Uint8Array([4]) }])),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
  } finally {
    doc.destroy();
    f.store.dispose();
  }
});
