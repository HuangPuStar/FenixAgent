import { expect, test } from "bun:test";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { AccountedMap, commitAccountedSets } from "../sync/store/memory-accounting";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { SyncDocRecord } from "../sync/store/types";

// 部分预留失败不能把同批的其他记录变成已提交内容。
test("内存索引整批先预留，失败不留下部分写入或额度", () => {
  const admission = new AdmissionController({
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: { ...DEFAULT_SYNC_CAPACITY.serverPools, controlIndex: 1024 },
  });
  const rows = new AccountedMap<string, number>(admission, (_key, bytes) => ({ controlIndex: bytes }));
  rows.set("old", 100);
  expect(() =>
    commitAccountedSets((pending) => {
      pending.push(rows.prepare("first", 600));
      pending.push(rows.prepare("second", 600));
    }),
  ).toThrow();
  expect([...rows]).toEqual([["old", 100]]);
  expect(admission.used("controlIndex")).toBe(100);
  rows.clear();
  expect(admission.used("controlIndex")).toBe(0);
});

for (const state of ["sealed", "active"] as const) {
  // 同一基线的只读字节只驻留一次，且写入、读取、恢复边界不能暴露内部缓冲。
  test(`${state} 快照在预算内导入及恢复，并隔离调用方的字节修改`, async () => {
    const admission = new AdmissionController({
      ...DEFAULT_SYNC_CAPACITY,
      serverPools: { ...DEFAULT_SYNC_CAPACITY.serverPools, transportCache: 256 * 1024 },
    });
    const options = {
      clock: { now: () => 1000 },
      digest: sha256Digest,
      capacity: DEFAULT_SYNC_CAPACITY,
      lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
      memoryBudget: admission,
    };
    const store = new MemoryProjectionStore(options);
    const lease = await store.acquireWriter("scope", "owner", 1000);
    await store.createGeneration({
      scopeKey: "scope",
      epoch: lease.epoch,
      generation: {
        scopeKey: "scope",
        generation: "generation",
        acpSessionId: "ses_test",
        loadId: "load",
        state: "staging",
        importEndOrdinal: null,
        createdAt: 1000,
        entryRefs: { controlDocId: "control", directoryDocId: "directory", runtimeDocId: "runtime", contentDocIds: [] },
      },
    });
    try {
      for (let index = 0; index < 3; index++) {
        const snapshot = new Uint8Array(64 * 1024).fill(7);
        const doc: SyncDocRecord = {
          scopeKey: "scope",
          generation: "generation",
          docId: `doc-${index}`,
          kind: "content",
          state,
          snapshot,
          hash: sha256Digest(snapshot),
          baseSeq: 0,
          finalSeq: state === "sealed" ? 0 : null,
          blockIndex: index,
          ordinalStart: index,
          ordinalEnd: index,
          dependsOn: [],
        };
        const input = { scopeKey: "scope", epoch: lease.epoch, doc };
        await (state === "sealed" ? store.putSealedIfAbsent(input) : store.createDoc(input));
        snapshot.fill(9);
      }
      expect(admission.used("transportCache")).toBe(192 * 1024);
      const read = await store.readDocStateAt("doc-0", 0);
      expect(read?.snapshot[0]).toBe(7);
      read!.snapshot.fill(3);
      expect((await store.readDocStateAt("doc-0", 0))?.snapshot[0]).toBe(7);
      const committed = store.exportCommittedState();
      store.dispose();
      store.restoreFromCommittedState(committed);
      expect(admission.used("transportCache")).toBe(192 * 1024);
      committed.docs[0].snapshot.fill(5);
      committed.docs[0].baseSnapshot.fill(6);
      expect((await store.readDocStateAt("doc-0", 0))?.snapshot[0]).toBe(7);
    } finally {
      store.dispose();
    }
    expect(admission.used("transportCache")).toBe(0);
  });
}
