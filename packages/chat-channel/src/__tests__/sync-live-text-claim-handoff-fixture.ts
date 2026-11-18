import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createLiveWriter, type LiveInput } from "../sync/live/live-writer";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import type { ProjectionStore } from "../sync/store/types";
import { fixture } from "./sync-live-admission-fixture";

/** 真实存储配单记录内容块，稳定复现 live 前驱与当前尾块分离后的接管。 */
export async function textClaimHandoffFixture(wrap: (store: ProjectionStore) => ProjectionStore = (store) => store) {
  const base = await fixture();
  await base.writer.close();
  const store = wrap(base.store);
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRecordsPerDoc: 1, payloadChunkMaxBytes: 64 },
  };
  const clock = { now: () => 1000 };
  let seed = 0;
  const makeWriter = () =>
    createLiveWriter({
      scope: base.scope,
      store,
      clock,
      digest: sha256Digest,
      random: deterministicRandomSource(`text-claim-handoff-${seed++}`),
      capacity,
      admission: base.admission,
      merge: { maxDelayMs: 600000, maxBytes: 1 },
      limits: RUNTIME_DOC_LIMITS,
      rotation: {
        clock,
        random: deterministicRandomSource(`text-claim-rotation-${seed}`),
        limits: RUNTIME_DOC_LIMITS,
        maxResidentMs: 600000,
        maxTransactions: 1000,
      },
    });
  let writer = makeWriter();
  await writer.acquire();
  return {
    ...base,
    get writer() {
      return writer;
    },
    async append(entryId: string, contentSlot = "text", delta = "same text") {
      const input: LiveInput = {
        kind: "text-delta",
        turnId: entryId,
        entryId,
        contentSlot,
        contentType: "text/plain",
        idempotent: true,
        delta,
      };
      await writer.accept(input);
    },
    async reopen(transform?: () => void) {
      await writer.close();
      transform?.();
      writer = makeWriter();
      await writer.acquire();
    },
    async replaceGeneration() {
      await writer.close();
      const key = scopeKey(base.scope);
      const lease = await store.acquireWriter(key, "replace-generation", 30000);
      const pointer = await store.readScopePointer(key);
      if (!pointer) throw new Error("Missing scope pointer");
      const generation = "new-generation";
      const id = (kind: "control" | "directory" | "runtime" | "content") =>
        buildDocId({ kind, generation, blockIndex: 0, nonce: kind });
      const entryRefs = {
        controlDocId: id("control"),
        directoryDocId: id("directory"),
        runtimeDocId: id("runtime"),
        contentDocIds: [id("content")],
      };
      const row = {
        scopeKey: key,
        generation,
        acpSessionId: "new-acp",
        loadId: "new-load",
        state: "staging" as const,
        importEndOrdinal: 0,
        createdAt: 1000,
        entryRefs,
      };
      await store.createGeneration({ scopeKey: key, epoch: lease.epoch, generation: row });
      for (const kind of ["runtime", "content"] as const) {
        const doc = new Y.Doc();
        const snapshot = Y.encodeStateAsUpdate(doc);
        doc.destroy();
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
        });
      }
      await store.commitGeneration({
        scopeKey: key,
        epoch: lease.epoch,
        newGeneration: row,
        entryClosure: entryRefs,
        expectedCurrent: pointer.currentGeneration,
        expectedPointerRevision: pointer.pointerRevision,
        retired: pointer.currentGeneration ? [pointer.currentGeneration] : [],
      });
      await store.releaseWriter?.(lease);
      writer = makeWriter();
      await writer.acquire();
    },
    async close() {
      await writer.close();
      await base.close();
    },
  };
}
