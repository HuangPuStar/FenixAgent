import { expect } from "bun:test";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { createLiveWriter, type LiveRecordValue, type LiveWriter } from "../sync/live/live-writer";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { records } from "../sync/live/writer-support";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";

/** 两个独立 scope 共用真实 Store 与同一个 Controller，不能用独立池掩盖工作额度竞争。 */
export async function textWorkingFixture() {
  const capacity = DEFAULT_SYNC_CAPACITY;
  const admission = new AdmissionController(capacity);
  const clock = { now: () => 1000 };
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity,
    memoryBudget: admission,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const scopes = [
    { organizationId: "working-org", rcsSessionId: "working-a" },
    { organizationId: "working-org", rcsSessionId: "working-b" },
  ];
  const writers: LiveWriter[] = [];
  for (const [index, scope] of scopes.entries()) {
    const key = scopeKey(scope),
      generation = `gen_working_${index}`;
    const id = (kind: "content" | "runtime" | "control" | "directory") =>
      buildDocId({ kind, generation, blockIndex: 0, nonce: kind });
    const entryRefs = {
      contentDocIds: [id("content")],
      runtimeDocId: id("runtime"),
      controlDocId: id("control"),
      directoryDocId: id("directory"),
    };
    const lease = await store.acquireWriter(key, "bootstrap", 1000);
    const row = {
      scopeKey: key,
      generation,
      acpSessionId: `working-acp-${index}`,
      loadId: `working-load-${index}`,
      state: "staging" as const,
      importEndOrdinal: 0,
      createdAt: 1000,
      entryRefs,
    };
    expect((await store.createGeneration({ scopeKey: key, epoch: lease.epoch, generation: row })).outcome).toBe(
      "committed",
    );
    expect(
      (
        await store.commitGeneration({
          scopeKey: key,
          epoch: lease.epoch,
          newGeneration: row,
          entryClosure: entryRefs,
          expectedCurrent: null,
          expectedPointerRevision: 0,
          retired: [],
        })
      ).outcome,
    ).toBe("committed");
    const doc = new Y.Doc(),
      snapshot = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    for (const kind of ["runtime", "content"] as const)
      expect(
        (
          await store.createDoc({
            scopeKey: key,
            epoch: lease.epoch,
            doc: {
              scopeKey: key,
              generation,
              docId: id(kind),
              kind,
              state: "active",
              snapshot,
              hash: sha256Digest(snapshot),
              baseSeq: 0,
              finalSeq: null,
              blockIndex: 0,
              ordinalStart: null,
              ordinalEnd: null,
              dependsOn: [],
            },
          })
        ).outcome,
      ).toBe("committed");
    await store.releaseWriter(lease);
    const writer = createLiveWriter({
      scope,
      store,
      clock,
      digest: sha256Digest,
      capacity,
      admission,
      random: deterministicRandomSource(`working-writer-${index}`),
      merge: { maxDelayMs: 600000, maxBytes: 1 << 20 },
      limits: RUNTIME_DOC_LIMITS,
      rotation: {
        clock,
        random: deterministicRandomSource(`working-rotation-${index}`),
        limits: RUNTIME_DOC_LIMITS,
        maxResidentMs: 600000,
        maxTransactions: 1000,
      },
    });
    await writer.acquire();
    writers.push(writer);
  }
  return {
    store,
    admission,
    scopes,
    writers,
    async texts(index: number) {
      const values: string[] = [];
      for (const row of store
        .exportCommittedState()
        .docs.filter((doc) => doc.scopeKey === scopeKey(scopes[index]!) && doc.kind === "content")
        .sort((a, b) => a.blockIndex! - b.blockIndex!)) {
        const loaded = await loadCommittedDoc(store, row.docId);
        if (!loaded) throw new Error("missing committed working content");
        try {
          values.push(
            ...(records<LiveRecordValue>(loaded.doc)?.toArray() ?? []).map((record) =>
              new TextDecoder().decode(record.payload),
            ),
          );
        } finally {
          loaded.doc.destroy();
        }
      }
      return values;
    },
    async close() {
      for (const writer of writers) await writer.close();
      store.dispose();
    },
  };
}
