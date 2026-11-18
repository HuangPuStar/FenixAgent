import { expect, test } from "bun:test";
import { AdmissionController, type ServerPoolName } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  AppendUpdatesInput,
  CommitGenerationInput,
  SyncGenerationRecord,
  SyncRefRecord,
} from "../sync/store/types";

/** 使用已发布代次和 active 文档验证真实 Store 的批次原子性。 */
async function fixture() {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const store = new MemoryProjectionStore({
    clock: { now: () => 1000 },
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
    memoryBudget: admission,
  });
  const lease = await store.acquireWriter("scope", "owner", 1000);
  const generation: SyncGenerationRecord = {
    scopeKey: "scope",
    generation: "old",
    acpSessionId: "ses_duplicates",
    loadId: "load",
    state: "staging",
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
  const snapshot = new Uint8Array([0, 0]);
  await store.createDoc({
    scopeKey: "scope",
    epoch: lease.epoch,
    doc: {
      scopeKey: "scope",
      generation: "old",
      docId: "doc",
      kind: "content",
      state: "active",
      snapshot,
      hash: sha256Digest(snapshot),
      baseSeq: 0,
      finalSeq: null,
      blockIndex: 0,
      ordinalStart: 0,
      ordinalEnd: 0,
      dependsOn: [],
    },
  });
  const usage = () =>
    (Object.keys(DEFAULT_SYNC_CAPACITY.serverPools) as ServerPoolName[]).map((pool) => admission.used(pool));
  return { admission, store, lease, generation, snapshot, usage };
}

for (const existingRef of [false, true]) {
  // 相同唯一键的 refs 不能留下已提交 ledger、前沿、幂等标记或无法回收的索引额度。
  test(`重复 refs 原子拒绝，旧索引存在=${existingRef}，合法重试与释放正常`, async () => {
    const f = await fixture();
    try {
      const ref: SyncRefRecord = {
        scopeKey: "scope",
        generation: "old",
        lookupKind: "entry",
        lookupId: "entry",
        contentSlot: 0,
        partIndex: 0,
        docId: "doc",
        recordId: "record",
        orderStart: 0,
        orderEnd: 0,
        byteStart: 0,
        byteEnd: 2,
      };
      const input: AppendUpdatesInput = {
        scopeKey: "scope",
        epoch: f.lease.epoch,
        owner: f.lease.owner,
        batchId: "duplicate-batch",
        digest: "duplicate-digest",
        expectedFrontiers: [{ docId: "doc", lastSeq: 0 }],
        updates: [{ docId: "doc", fromSeq: 1, bytes: f.snapshot }],
        refs: [ref, { ...ref, recordId: "different-record" }],
      };
      if (existingRef) await f.store.appendUpdates({ ...input, batchId: "initial-ref", updates: [], refs: [ref] });
      const before = f.store.exportCommittedState();
      const usage = f.usage();
      await expect(f.store.appendUpdates(input)).rejects.toThrow(/pending/);
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(f.usage()).toEqual(usage);
      const valid = { ...input, refs: [ref, { ...ref, partIndex: 1, recordId: "next-record" }] };
      expect((await f.store.appendUpdates(valid)).outcome).toBe("committed");
      expect((await f.store.appendUpdates(valid)).outcome).toBe("already-committed");
      expect((await f.store.readUpdatesAfter("doc", 0, 10)).map((update) => update.updateSeq)).toEqual([1]);
      expect(
        await f.store.locateRefs({ generation: "old", lookupKind: "entry", lookupId: "entry", limit: 10 }),
      ).toEqual(valid.refs);
    } finally {
      f.store.dispose();
    }
    expect(f.usage().every((bytes) => bytes === 0)).toBe(true);
  });
}

// 重复退休代次不能覆盖同批已准备的记账归属，拒绝后旧代与发布指针必须保持原状。
test("重复退休代次原子拒绝，修正批次后仍可正常发布并归还额度", async () => {
  const f = await fixture();
  try {
    const generation = { ...f.generation, generation: "new", loadId: "new-load" };
    await f.store.createGeneration({ scopeKey: "scope", epoch: f.lease.epoch, generation });
    const input: CommitGenerationInput = {
      scopeKey: "scope",
      epoch: f.lease.epoch,
      newGeneration: generation,
      expectedCurrent: "old",
      expectedPointerRevision: 1,
      entryClosure: generation.entryRefs,
      retired: ["old", "old"],
    };
    const before = f.store.exportCommittedState();
    const usage = f.usage();
    await expect(f.store.commitGeneration(input)).rejects.toThrow(/pending/);
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
    const valid = { ...input, retired: ["old"] };
    expect((await f.store.commitGeneration(valid)).outcome).toBe("committed");
    expect((await f.store.commitGeneration(valid)).outcome).toBe("already-committed");
    expect((await f.store.readScopePointer("scope"))?.currentGeneration).toBe("new");
    expect((await f.store.readGeneration("scope", "old"))?.state).toBe("retired");
  } finally {
    f.store.dispose();
  }
  expect(f.usage().every((bytes) => bytes === 0)).toBe(true);
});
