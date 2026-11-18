import { expect, test } from "bun:test";
import { SyncProtocolError } from "../sync/protocol/errors";
import { fixture, contentObjectInput as object } from "./sync-live-admission-fixture";

// 已有正文缓冲继续共享，剩余额度只须容纳新增记录，而非再容纳整份旧账本。
test("账本接近额度上限时仍能追加可容纳的小更新", async () => {
  const f = await fixture();
  let hold: ReturnType<typeof f.admission.reserve> | undefined;
  try {
    await f.writer.accept({
      ...object("large"),
      object: { value: { text: "x".repeat(64 * 1024) }, meta: { kind: "history_object", entryId: "large" } },
    });
    const before = await f.readAll();
    const used = f.admission.used("hotDocLive");
    hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive") - 4096);
    await f.writer.accept(object("after"));
    expect(await f.readAll()).toHaveLength(before.length + 1);
    hold.release();
    expect(f.admission.used("hotDocLive")).toBeGreaterThan(used);
    expect(f.admission.used("hotDocLive") - used).toBeLessThanOrEqual(4096);
  } finally {
    hold?.release();
    await f.close();
  }
  expect(f.admission.used("hotDocLive")).toBe(0);
  expect(f.admission.used("controlIndex")).toBe(0);
});

for (const cutoff of [2, 3, 4]) {
  // 新增正文、定位与批次的任一索引预留失败，都不得归还或覆盖旧账本的存量计费。
  test(`保留旧账本的追加在第${cutoff}个索引预留拒绝时完整回滚`, async () => {
    const f = await fixture();
    const reserve = f.admission.reserve.bind(f.admission);
    try {
      await f.writer.accept(object("before"));
      const before = f.store.exportCommittedState();
      const used = f.admission.used("hotDocLive");
      const control = f.admission.used("controlIndex");
      let calls = 0;
      f.admission.reserve = (pool, bytes) => {
        if (pool === "controlIndex" && ++calls === cutoff)
          throw new SyncProtocolError("ADMISSION_REJECTED", { message: "test index capacity exhausted" });
        return reserve(pool, bytes);
      };
      await expect(f.writer.accept(object("after"))).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(f.admission.used("hotDocLive")).toBe(used);
      expect(f.admission.used("controlIndex")).toBe(control);
      f.admission.reserve = reserve;
      await f.writer.accept(object("after"));
      expect(await f.readAll()).toHaveLength(2);
    } finally {
      f.admission.reserve = reserve;
      await f.close();
    }
  });
}

// 第二份 ledger 额度不足时，第一份已准备的正文与索引额度也必须撤回，两文档前沿保持一致。
test("双文档批次在第二份账本拒绝后完整回滚并可幂等重试", async () => {
  const f = await fixture();
  let hold: ReturnType<typeof f.admission.reserve> | undefined;
  try {
    await f.writer.close();
    const scopeKey = f.store.exportCommittedState().scopes[0].scopeKey;
    const lease = await f.store.acquireWriter(scopeKey, "batch-writer", 1000);
    const docIds = [f.contentId, f.runtimeId];
    const batch = (fromSeq: number) => ({
      scopeKey,
      epoch: lease.epoch,
      owner: lease.owner,
      batchId: `two-docs-${fromSeq}`,
      digest: `digest-${fromSeq}`,
      expectedFrontiers: docIds.map((docId) => ({ docId, lastSeq: fromSeq - 1 })),
      updates: docIds.map((docId) => ({ docId, fromSeq, bytes: new Uint8Array([0, 0]) })),
    });
    await f.store.appendUpdates(batch(1));
    const before = f.store.exportCommittedState();
    const used = f.admission.used("hotDocLive");
    const control = f.admission.used("controlIndex");
    hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive") - 6);
    const input = batch(2);
    await expect(f.store.appendUpdates(input)).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.admission.available("hotDocLive")).toBe(6);
    expect(f.admission.used("controlIndex")).toBe(control);
    hold.release();
    expect(f.admission.used("hotDocLive")).toBe(used);
    expect((await f.store.appendUpdates(input)).outcome).toBe("committed");
    expect((await f.store.appendUpdates(input)).outcome).toBe("already-committed");
    for (const docId of docIds) {
      expect((await f.store.readUpdatesAfter(docId, 0, 10)).map((update) => update.updateSeq)).toEqual([1, 2]);
      expect(f.store.exportCommittedState().docs.find((doc) => doc.docId === docId)?.lastSeq).toBe(2);
    }
    expect(f.admission.used("hotDocLive")).toBe(used + 8);
  } finally {
    hold?.release();
    await f.close();
  }
  expect(f.admission.used("hotDocLive")).toBe(0);
  expect(f.admission.used("controlIndex")).toBe(0);
});
