import { expect, test } from "bun:test";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

/** 两份真实账本共享 scope，但各自的序号与顺序独立。 */
async function fixture() {
  const f = await contentBatchFixture(),
    ids = [f.ids[0], f.pageId];
  for (let seq = 1; seq <= 3; seq++)
    expect(
      (
        await f.store.appendUpdates({
          ...f.input,
          batchId: `ordered-${seq}`,
          digest: `ordered-${seq}`,
          refs: [],
          expectedFrontiers: ids.map((docId) => ({ docId, lastSeq: seq - 1 })),
          updates: ids.map((docId) => ({ docId, fromSeq: seq, bytes: new Uint8Array([0, 0]) })),
        })
      ).outcome,
    ).toBe("committed");
  const snapshot = f.store.exportCommittedState();
  const ledgers = ids.map((id) => snapshot.updates.filter((update) => update.docId === id));
  return { ...f, ids, snapshot, ledgers };
}

// 全局数组允许跨 Doc 交错，只需每份 scope/doc 账本各自严格升序，二分页仍能连续读取。
test("恢复允许跨 Doc 交错的严格升序账本", async () => {
  const f = await fixture();
  try {
    f.snapshot.updates = [0, 1, 2].flatMap((index) => [f.ledgers[0][index], f.ledgers[1][index]]);
    f.store.restoreFromCommittedState(f.snapshot);
    for (const id of f.ids) {
      expect((await f.store.readUpdatesAfter(id, 1, 10)).map((update) => update.updateSeq)).toEqual([2, 3]);
      expect((await f.store.readUpdatesAfter(id, 0, 1)).map((update) => update.updateSeq)).toEqual([1]);
    }
  } finally {
    f.store.dispose();
  }
});

for (const order of [
  [2, 1, 3],
  [1, 3, 2],
  [1, 1, 3],
]) {
  // 外部重排或重复序号不能在恢复时破坏活跃投影；先拒绝，原租约、全部状态和额度均保持。
  test(`恢复在清理原状态前拒绝账本 ${order.join("/")}`, async () => {
    const f = await fixture();
    try {
      f.snapshot.updates = order.flatMap((seq, index) => [f.ledgers[0][seq - 1], f.ledgers[1][index]]);
      const before = f.store.exportCommittedState(),
        usage = f.usage();
      const pointer = await f.store.readScopePointer(f.input.scopeKey);
      expect(() => f.store.restoreFromCommittedState(f.snapshot)).toThrow("strictly ascending");
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(f.usage()).toEqual(usage);
      expect(await f.store.readScopePointer(f.input.scopeKey)).toEqual(pointer);
      expect((await f.store.readUpdatesAfter(f.ids[0], 1, 10)).map((update) => update.updateSeq)).toEqual([2, 3]);
    } finally {
      f.store.dispose();
    }
  });
}

for (const updateSeq of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
  // 序号 0 属于快照，增量须为正安全整数；非法归档在接触旧状态与额度之前拒绝。
  test(`恢复拒绝非法增量序号 ${String(updateSeq)} 并保留原投影`, async () => {
    const f = await fixture();
    try {
      f.snapshot.updates[0] = { ...f.snapshot.updates[0], updateSeq };
      const before = f.store.exportCommittedState(),
        usage = f.usage(),
        pointer = await f.store.readScopePointer(f.input.scopeKey);
      expect(() => f.store.restoreFromCommittedState(f.snapshot)).toThrow("strictly ascending");
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(f.usage()).toEqual(usage);
      expect(await f.store.readScopePointer(f.input.scopeKey)).toEqual(pointer);
    } finally {
      f.store.dispose();
    }
  });
}
