import { expect, test } from "bun:test";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile, validateCapacityProfile } from "../sync/capacity/profile";
import { minimumTextPlanReservations } from "../sync/capacity/text-plan-reservations";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createLiveWriter, type LiveRecordValue } from "../sync/live/live-writer";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { records } from "../sync/live/writer-support";
import { buildDocId, MAX_IDENTIFIER_BYTES, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";

/** 保持总池额不变，只把热池和持久化池收紧到启动校验声明的精确最低值。 */
function minimumCapacity(): SyncCapacityProfile {
  const minimum = minimumTextPlanReservations(DEFAULT_SYNC_CAPACITY.inputs);
  const pools = DEFAULT_SYNC_CAPACITY.serverPools;
  return {
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: {
      ...pools,
      ...minimum,
      ingressSpool:
        pools.ingressSpool + pools.hotDocLive + pools.persistSeal - minimum.hotDocLive - minimum.persistSeal,
    },
  };
}

// 启动接受的最低预算必须覆盖 planner 与 Store 同时持有的字节，最长合法身份也能实际提交首字节。
test("精确最低档位与 Store 共享预算时最长合法身份的一字节文本可提交", async () => {
  const capacity = minimumCapacity();
  validateCapacityProfile(capacity);
  const admission = new AdmissionController(capacity);
  const scope = { organizationId: "minimum-org", rcsSessionId: "minimum-session" };
  const key = scopeKey(scope);
  const generation = "minimum-generation";
  const clock = { now: () => 1000 };
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity,
    memoryBudget: admission,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const id = (kind: "content" | "runtime" | "control" | "directory") => {
    const prefix = `sync/${kind}/${generation}/0/`;
    return buildDocId({
      kind,
      generation,
      blockIndex: 0,
      nonce: kind === "content" ? "n".repeat(MAX_IDENTIFIER_BYTES - prefix.length) : kind,
    });
  };
  const entryRefs = {
    contentDocIds: [id("content")],
    runtimeDocId: id("runtime"),
    controlDocId: id("control"),
    directoryDocId: id("directory"),
  };
  const lease = await store.acquireWriter(key, "bootstrap", 1000);
  try {
    const row = {
      scopeKey: key,
      generation,
      acpSessionId: "minimum-acp",
      loadId: "minimum-load",
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
    const empty = new Y.Doc();
    const snapshot = Y.encodeStateAsUpdate(empty);
    empty.destroy();
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
  } finally {
    await store.releaseWriter(lease);
  }
  const writer = createLiveWriter({
    scope,
    store,
    clock,
    digest: sha256Digest,
    random: deterministicRandomSource("minimum-writer"),
    capacity,
    admission,
    merge: { maxDelayMs: 600000, maxBytes: 1 },
    limits: RUNTIME_DOC_LIMITS,
    rotation: {
      clock,
      random: deterministicRandomSource("minimum-rotation"),
      limits: RUNTIME_DOC_LIMITS,
      maxResidentMs: 600000,
      maxTransactions: 1000,
    },
  });
  try {
    await writer.acquire();
    const identity = "i".repeat(MAX_IDENTIFIER_BYTES);
    await writer.accept({
      kind: "text-delta",
      turnId: "turn",
      entryId: identity,
      contentSlot: identity,
      contentType: identity,
      delta: "x",
      idempotent: true,
    });
    const committed = store.exportCommittedState();
    expect(committed.updates).toHaveLength(1);
    expect(committed.refs).toHaveLength(1);
    const doc = new Y.Doc();
    try {
      for (const update of committed.updates) Y.applyUpdate(doc, update.bytes);
      const values = records<LiveRecordValue>(doc)?.toArray() ?? [];
      expect(values).toHaveLength(1);
      expect(new TextDecoder().decode(values[0]!.payload)).toBe("x");
      expect(values[0]).toMatchObject({ entryId: identity, contentSlot: identity, contentType: identity });
      const { payload: _payload, ...header } = values[0]!;
      expect(new TextEncoder().encode(JSON.stringify(header)).byteLength).toBeLessThanOrEqual(
        capacity.inputs.recordHeaderMaxBytes,
      );
    } finally {
      doc.destroy();
    }
    await writer.close();
    expect(admission.used("persistSeal")).toBe(0);
    expect(admission.used("hotDocLive")).toBe(
      committed.updates.reduce((sum, update) => sum + update.bytes.byteLength * 2, 0),
    );
  } finally {
    await writer.close();
    store.dispose();
  }
  expect(admission.used("hotDocLive")).toBe(0);
  expect(admission.used("persistSeal")).toBe(0);
});
