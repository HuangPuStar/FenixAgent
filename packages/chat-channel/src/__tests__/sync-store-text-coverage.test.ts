import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { textClaimLookupId } from "../sync/live/text-claim-identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { SyncRefRecord } from "../sync/store/types";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

/** 一个真实跨块文本仅以最后一片建立身份索引，所有分片都由原子批次证明。 */
async function indexedFixture() {
  const f = await contentBatchFixture();
  f.input.refs = [
    {
      scopeKey: f.input.scopeKey,
      generation: f.input.generation,
      lookupKind: "live-text",
      lookupId: textClaimLookupId(sha256Digest, {
        scopeKey: f.input.scopeKey,
        generation: f.input.generation,
        entryId: "entry",
        contentSlot: "text",
      }),
      contentSlot: 0,
      partIndex: 0,
      docId: f.ids[2],
      recordId: "record-2",
      orderStart: 0,
      orderEnd: 0,
      byteStart: 0,
      byteEnd: 5,
    },
  ];
  expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
  return { ...f, query: { scopeKey: f.input.scopeKey, generation: f.input.generation, docIds: f.ids } };
}

// 证明按逻辑文本身份覆盖，末片索引足以覆盖同批前驱，读取不再重放正文。
test("跨块末片索引覆盖整批文本且查询不重放已证明块", async () => {
  const f = await indexedFixture(),
    apply = spyOn(Y, "applyUpdate");
  try {
    expect([...(await f.store.readLiveTextCoverage(f.query))]).toEqual(f.ids);
    expect(apply.mock.calls.length).toBe(0);
    expect(f.store.exportCommittedState().docs.every((doc) => !("textCoverage" in doc))).toBe(true);
  } finally {
    apply.mockRestore();
    f.store.dispose();
  }
});

// 恢复时派生标记不可被伪造，真实 canonical 与定位只需重建一次。
test("恢复覆盖证明只重建一次并拒绝调用方伪造标记", async () => {
  const f = await indexedFixture();
  try {
    const snapshot = f.store.exportCommittedState();
    for (const doc of snapshot.docs) Object.assign(doc, { textCoverage: true });
    f.store.restoreFromCommittedState(snapshot);
    const apply = spyOn(Y, "applyUpdate");
    try {
      expect([...(await f.store.readLiveTextCoverage(f.query))]).toEqual(f.ids);
      expect(apply.mock.calls.length).toBeGreaterThan(0);
      apply.mockClear();
      expect([...(await f.store.readLiveTextCoverage(f.query))]).toEqual(f.ids);
      expect(apply.mock.calls.length).toBe(0);
    } finally {
      apply.mockRestore();
    }
    const broken = f.store.exportCommittedState();
    broken.refs = [];
    for (const doc of broken.docs) Object.assign(doc, { textCoverage: true, textCoverageRevision: 0 });
    f.store.restoreFromCommittedState(broken);
    expect((await f.store.readLiveTextCoverage(f.query)).size).toBe(0);
  } finally {
    f.store.dispose();
  }
});

// 未经 canonical 校验的通用定位覆盖必须同事务撤销全部旧证明。
test("通用定位覆盖撤销旧块证明且额度拒绝不会半失效", async () => {
  const f = await indexedFixture();
  try {
    const lease = await f.store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
    const input = {
      ...f.input,
      epoch: lease.epoch,
      batchId: "overwrite",
      digest: "overwrite",
      updates: [],
      expectedFrontiers: [],
      refs: [{ ...f.input.refs![0], recordId: "ghost" }],
    };
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    f.admission.remaining = 1;
    await expect(f.store.appendUpdates(input)).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    f.admission.remaining = null;
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
    expect((await f.store.readLiveTextCoverage(f.query)).size).toBe(3);
    expect((await f.store.appendUpdates(input)).outcome).toBe("committed");
    expect((await f.store.readLiveTextCoverage(f.query)).size).toBe(0);
  } finally {
    f.store.dispose();
  }
});

// 预算申请重入可替换已观察定位，旧证明不能覆盖内层已提交的新索引。
test("覆盖证明的元数据准备重校定位前像", async () => {
  const f = await indexedFixture();
  let nested: ReturnType<typeof f.store.appendUpdates> | undefined;
  const apply = spyOn(Y, "applyUpdate");
  try {
    const snapshot = f.store.exportCommittedState();
    f.store.restoreFromCommittedState(snapshot);
    const lease = await f.store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
    const hotBefore = f.admission.used("hotDocLive");
    f.admission.beforeReserve = (pool) => {
      if (pool !== "controlIndex" || apply.mock.calls.length === 0 || f.admission.used("hotDocLive") !== hotBefore)
        return;
      f.admission.beforeReserve = null;
      nested = f.store.appendUpdates({
        ...f.input,
        epoch: lease.epoch,
        batchId: "nested-ref",
        digest: "nested-ref",
        updates: [],
        expectedFrontiers: [],
        refs: [{ ...f.input.refs![0], recordId: "ghost" }],
      });
    };
    await expect(f.store.readLiveTextCoverage({ ...f.query, docIds: [f.ids[0]] })).rejects.toMatchObject({
      code: "SEQUENCE_GAP",
    });
    expect((await nested)?.outcome).toBe("committed");
    expect((await f.store.readLiveTextCoverage(f.query)).size).toBe(0);
  } finally {
    apply.mockRestore();
    f.store.dispose();
  }
});

for (const remaining of [1, 2]) {
  // 可选证明预算不足时保守交给 fallback，零解码且不留下半份缓存或租约。
  test(`覆盖证明在正文重建前取得临时预算，拒绝点=${remaining}`, async () => {
    const f = await indexedFixture();
    try {
      f.store.restoreFromCommittedState(f.store.exportCommittedState());
      const before = f.store.exportCommittedState(),
        usage = f.usage(),
        apply = spyOn(Y, "applyUpdate");
      try {
        f.admission.remaining = remaining;
        expect((await f.store.readLiveTextCoverage({ ...f.query, docIds: [f.ids[0]] })).size).toBe(0);
        expect(apply.mock.calls.length).toBe(0);
        expect(f.store.exportCommittedState()).toEqual(before);
        expect(f.usage()).toEqual(usage);
        f.admission.remaining = null;
        expect((await f.store.readLiveTextCoverage(f.query)).size).toBe(3);
      } finally {
        apply.mockRestore();
      }
    } finally {
      f.store.dispose();
    }
  });
}

/** 仅在测试中修改已经观察的 ref 行，不触发代次或正文变化，单独检验 ref CAS。 */
class RefOnlyMutationStore extends MemoryProjectionStore {
  replaceRef(ref: SyncRefRecord): void {
    this.refs.set(
      [ref.scopeKey, ref.generation, ref.lookupKind, ref.lookupId, ref.contentSlot, ref.partIndex].join("\u0000"),
      { ...ref },
    );
  }
  revision(scopeKey: string, generation: string): number {
    return this.generations.get(`${scopeKey}\u0000${generation}`)?.textCoverageRevision ?? 0;
  }
}

for (const refuse of [false, true]) {
  // 单独更换 ref 行时，即使最终缓存预算拒绝，旧证明仍必须复核前像并暴露竞态。
  test(`覆盖准备独立复核 ref 行前像，缓存拒绝=${refuse}`, async () => {
    const f = await indexedFixture(),
      snapshot = f.store.exportCommittedState();
    f.store.dispose();
    const store = new RefOnlyMutationStore({
      clock: { now: () => 1000 },
      digest: sha256Digest,
      capacity: DEFAULT_SYNC_CAPACITY,
      memoryBudget: f.admission,
      lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
    });
    store.restoreFromCommittedState(snapshot);
    const apply = spyOn(Y, "applyUpdate");
    let changed = false;
    try {
      const revision = store.revision(f.input.scopeKey, f.input.generation);
      const hotBefore = f.admission.used("hotDocLive");
      f.admission.beforeReserve = (pool) => {
        if (pool !== "controlIndex" || apply.mock.calls.length === 0 || f.admission.used("hotDocLive") !== hotBefore)
          return;
        f.admission.beforeReserve = null;
        changed = true;
        store.replaceRef({ ...f.input.refs![0], recordId: "ghost" });
        if (refuse) f.admission.remaining = 0;
      };
      await expect(store.readLiveTextCoverage({ ...f.query, docIds: [f.ids[0]] })).rejects.toMatchObject({
        code: "SEQUENCE_GAP",
      });
      expect(changed).toBe(true);
      expect(store.revision(f.input.scopeKey, f.input.generation)).toBe(revision);
      expect((await store.readLiveTextCoverage(f.query)).size).toBe(0);
    } finally {
      apply.mockRestore();
      store.dispose();
    }
  });
}
