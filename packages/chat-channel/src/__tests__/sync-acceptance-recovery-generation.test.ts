import { expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { SyncGenerationRecord } from "../sync/store/types";
import { emptyDocBytes, seedCommittedGeneration, seededDocIdsFor } from "./sync-acceptance-recovery-generation";

/** 每个用例有独立Store和固定租约，冲突均由真实登记及CAS原语产生。 */
async function fixture() {
  const store = new MemoryProjectionStore({
    clock: { now: () => 1000 },
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const input = {
    store,
    scopeKey: "recovery-generation-scope",
    generation: "gen-seed",
    owner: "seed-owner",
    leaseTtlMs: 30000,
  };
  const lease = await store.acquireWriter(input.scopeKey, input.owner, input.leaseTtlMs);
  return { store, input, lease };
}

/** 预先登记staging及可选的整套空入口，保留真实create-if-absent冲突边界。 */
async function registerStaging(
  f: Awaited<ReturnType<typeof fixture>>,
  options: {
    generation?: string;
    loadId?: string;
    documents?: boolean;
    conflictingContent?: boolean;
  },
) {
  const generation = options.generation ?? f.input.generation;
  const ids = seededDocIdsFor(generation);
  const row: SyncGenerationRecord = {
    scopeKey: f.input.scopeKey,
    generation,
    acpSessionId: "ses_acceptance_recovery",
    loadId: options.loadId ?? `load_${generation}`,
    state: "staging",
    importEndOrdinal: null,
    createdAt: 0,
    entryRefs: {
      controlDocId: ids.control,
      directoryDocId: ids.directory,
      runtimeDocId: ids.runtime,
      contentDocIds: [],
    },
  };
  expect(
    (await f.store.createGeneration({ scopeKey: f.input.scopeKey, epoch: f.lease.epoch, generation: row })).outcome,
  ).toBe("committed");
  if (!options.documents) return;
  const nonempty = new Y.Doc();
  let conflicting: Uint8Array;
  try {
    nonempty.getMap("root").set("value", "already-stored");
    conflicting = Y.encodeStateAsUpdate(nonempty);
  } finally {
    nonempty.destroy();
  }
  for (const [kind, docId] of Object.entries(ids)) {
    const snapshot = kind === "content" && options.conflictingContent ? conflicting : emptyDocBytes();
    expect(
      (
        await f.store.createDoc({
          scopeKey: f.input.scopeKey,
          epoch: f.lease.epoch,
          doc: {
            scopeKey: f.input.scopeKey,
            generation,
            docId,
            kind: kind as "control" | "runtime" | "directory" | "content",
            state: "active",
            snapshot,
            hash: sha256Digest(snapshot),
            baseSeq: 0,
            finalSeq: null,
            blockIndex: kind === "content" ? 0 : null,
            ordinalStart: null,
            ordinalEnd: null,
            dependsOn: [],
          },
        })
      ).outcome,
    ).toBe("committed");
  }
}

// 不同load占有同staging generation时必须在创建入口文档前停止，不能发布别人的导入。
test("rejects a different staging load without changing or publishing its state", async () => {
  const f = await fixture();
  try {
    await registerStaging(f, { loadId: "other-load" });
    const before = f.store.exportCommittedState();
    await expect(seedCommittedGeneration(f.input)).rejects.toThrow(
      /createGeneration.*conflict.*actualGeneration=null.*pointerRevision=0/,
    );
    expect(f.store.exportCommittedState()).toEqual(before);
    expect((await f.store.readGeneration(f.input.scopeKey, f.input.generation))?.state).toBe("staging");
    expect((await f.store.readScopePointer(f.input.scopeKey))?.currentGeneration).toBeNull();
  } finally {
    f.store.dispose();
  }
});

// 确定性docId已有不同canonical字节时必须停止，不能把旧内容发布成成功的空种子。
test("rejects conflicting seed document bytes and preserves the staging closure", async () => {
  const f = await fixture();
  try {
    await registerStaging(f, { documents: true, conflictingContent: true });
    const before = f.store.exportCommittedState();
    await expect(seedCommittedGeneration(f.input)).rejects.toThrow(
      /createDoc.*conflict.*actualGeneration=null.*pointerRevision=0/,
    );
    expect(f.store.exportCommittedState()).toEqual(before);
    expect((await f.store.readScopePointer(f.input.scopeKey))?.currentGeneration).toBeNull();
  } finally {
    f.store.dispose();
  }
});

// 真实pointer CAS冲突不能返回gen-b已播种，错误应带当前gen-a与revision1诊断。
test("rejects a stale pointer revision without publishing the requested generation", async () => {
  const f = await fixture();
  try {
    const first = await seedCommittedGeneration({ ...f.input, generation: "gen-a" });
    f.lease = first.lease;
    await registerStaging(f, { generation: "gen-b", documents: true });
    const before = f.store.exportCommittedState();
    await expect(
      seedCommittedGeneration({
        ...f.input,
        generation: "gen-b",
        expectedCurrent: "gen-a",
        expectedPointerRevision: 0,
      }),
    ).rejects.toThrow(/commitGeneration.*conflict.*actualGeneration=gen-a.*pointerRevision=1/);
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(await f.store.readScopePointer(f.input.scopeKey)).toMatchObject({
      currentGeneration: "gen-a",
      pointerRevision: 1,
    });
    expect((await f.store.readGeneration(f.input.scopeKey, "gen-b"))?.state).toBe("staging");
  } finally {
    f.store.dispose();
  }
});

// 同load和同hash登记是正常可重放准备步骤，不能被严格回执检查误判失败。
test("accepts matching staging and document registrations before committing the generation", async () => {
  const f = await fixture();
  try {
    await registerStaging(f, { documents: true });
    const result = await seedCommittedGeneration(f.input);
    expect(result.generation).toBe(f.input.generation);
    expect(await f.store.readScopePointer(f.input.scopeKey)).toMatchObject({
      currentGeneration: f.input.generation,
      pointerRevision: 1,
    });
    expect((await f.store.readGeneration(f.input.scopeKey, f.input.generation))?.state).toBe("committed");
  } finally {
    f.store.dispose();
  }
});
