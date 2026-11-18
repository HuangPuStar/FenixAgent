import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { MemoryProjectionStore } from "../sync/store/memory-store";

/** 通过真实发布路径建立当前代，确认操作只观察 Store 现有状态。 */
async function fixture() {
  let now = 1000;
  const store = new MemoryProjectionStore({
    clock: { now: () => now },
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const lease = await store.acquireWriter("scope", "owner", 100);
  const generation = {
    scopeKey: "scope",
    generation: "current",
    acpSessionId: "ses_confirm",
    loadId: "load",
    state: "staging" as const,
    importEndOrdinal: null,
    createdAt: 1000,
    entryRefs: { controlDocId: "control", directoryDocId: "directory", runtimeDocId: "runtime", contentDocIds: [] },
  };
  await store.createGeneration({ scopeKey: "scope", epoch: lease.epoch, generation });
  await store.commitGeneration({
    scopeKey: "scope",
    epoch: lease.epoch,
    newGeneration: generation,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    entryClosure: generation.entryRefs,
    retired: [],
  });
  return { store, lease, expire: () => (now += 100) };
}

// 有效确认不得续租或更改发布状态，调用方只能取得当前写权与代次同时成立的证明。
test("写者确认只读地验证当前 owner、epoch、租约与代次", async () => {
  const f = await fixture();
  try {
    const before = await f.store.readScopePointer("scope");
    await f.store.confirmWriter(f.lease, "current");
    expect(await f.store.readScopePointer("scope")).toEqual(before);
    await expect(f.store.confirmWriter({ ...f.lease, owner: "other" }, "current")).rejects.toMatchObject({
      code: "WRITER_EPOCH_LOST",
    });
    await expect(f.store.confirmWriter({ ...f.lease, epoch: f.lease.epoch + 1 }, "current")).rejects.toMatchObject({
      code: "WRITER_EPOCH_LOST",
    });
    await expect(f.store.confirmWriter(f.lease, "old")).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
    f.expire();
    await expect(f.store.confirmWriter(f.lease, "old")).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(await f.store.readScopePointer("scope")).toEqual(before);
  } finally {
    f.store.dispose();
  }
});
