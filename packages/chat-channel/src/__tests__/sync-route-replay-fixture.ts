import { expect } from "bun:test";
import * as Y from "yjs";
import { AdmissionController, type ServerPoolName } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createSealingMachine } from "../sync/live/sealing";
import { buildDocId, type DocKind, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { SyncDocRecord, SyncGenerationRecord } from "../sync/store/types";

/** 生成可重放的独立 Yjs 快照。 */
export function textSnapshot(text: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    if (text) doc.getText("body").insert(0, text);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** 取得全部真实子池用量，检查拒绝与重放没有残留额度。 */
export function usage(admission: AdmissionController) {
  return Object.fromEntries(
    Object.keys(DEFAULT_SYNC_CAPACITY.serverPools).map((pool) => [pool, admission.used(pool as ServerPoolName)]),
  );
}

/** 当前代、真实预算与可推进时钟；封口和账本均运行真实实现。 */
export async function routeReplayFixture(
  kind: DocKind = "runtime",
  admission = new AdmissionController(DEFAULT_SYNC_CAPACITY),
) {
  const scope = { organizationId: "r7", rcsSessionId: "route-replay" };
  const key = scopeKey(scope);
  const generationId = "gen-r7";
  let now = 1000;
  const clock = { now: () => now };
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
    memoryBudget: admission,
  });
  const lease = await store.acquireWriter(key, "owner", 10000);
  const id = (nonce: string) =>
    buildDocId({ kind, generation: generationId, blockIndex: kind === "content" ? 1 : 0, nonce });
  const a = id("a");
  const b = id("b");
  const empty = textSnapshot("");
  const record = (docId: string, snapshot = empty): SyncDocRecord => ({
    scopeKey: key,
    generation: generationId,
    docId,
    kind,
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: kind === "content" ? 1 : null,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  });
  const generation: SyncGenerationRecord = {
    scopeKey: key,
    generation: generationId,
    acpSessionId: "ses_r7",
    loadId: "load-r7",
    state: "staging",
    importEndOrdinal: null,
    createdAt: now,
    entryRefs: { controlDocId: "control", directoryDocId: "directory", runtimeDocId: a, contentDocIds: [] },
  };
  await store.createGeneration({ scopeKey: key, epoch: lease.epoch, generation });
  await store.createDoc({ scopeKey: key, epoch: lease.epoch, doc: record(a) });
  await store.commitGeneration({
    scopeKey: key,
    epoch: lease.epoch,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    newGeneration: generation,
    entryClosure: generation.entryRefs,
    retired: [],
  });
  const route = (successorDoc?: SyncDocRecord) => ({
    scopeKey: key,
    epoch: lease.epoch,
    predecessorDocId: a,
    successorDocId: b,
    expectedLastSeq: 0,
    ...(successorDoc ? { successorDoc } : {}),
  });
  const request = (snapshot = empty) => ({
    scope,
    lease,
    oldDocId: a,
    finalUpdateSeq: 0,
    successorDocId: b,
    successorInitialState: snapshot,
  });
  const machine = () =>
    createSealingMachine({ store, clock, digest: sha256Digest, random: deterministicRandomSource("r7-replay") });
  async function append(docId: string, bytes: Uint8Array, lastSeq = 0) {
    return store.appendUpdates({
      scopeKey: key,
      epoch: lease.epoch,
      owner: lease.owner,
      batchId: `${docId}-${lastSeq}`,
      digest: sha256Digest(bytes),
      expectedFrontiers: [{ docId, lastSeq }],
      updates: [{ docId, fromSeq: lastSeq + 1, bytes }],
    });
  }
  function dispose(): void {
    store.dispose();
    expect(Object.values(usage(admission)).every((bytes) => bytes === 0)).toBe(true);
  }
  return {
    store,
    admission,
    key,
    lease,
    a,
    b,
    id,
    empty,
    record,
    generation,
    route,
    request,
    machine,
    append,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    dispose,
  };
}
