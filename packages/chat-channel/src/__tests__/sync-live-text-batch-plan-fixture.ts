import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { loadCommittedDoc, openLiveCursor } from "../sync/live/committed-doc";
import { createDirectoryAppender } from "../sync/live/directory-appender";
import type { MergeFlushRequest } from "../sync/live/merge-buffer";
import { buildDocId } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { SyncDocRecord } from "../sync/store/types";

/** 使用真实存储与目录恢复，只把输入文本和内容硬限作为测试边界。 */
export async function textBatchFixture(capacity: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY, directoryCount = 1) {
  const scopeKey = "planner-org/planner-session";
  const generation = "planner-generation";
  const store = new MemoryProjectionStore({
    clock: { now: () => 1000 },
    digest: sha256Digest,
    capacity,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const random = deterministicRandomSource("text-batch-plan");
  const lease = await store.acquireWriter(scopeKey, "planner-writer", 30000);
  const contentId = buildDocId({ kind: "content", generation, blockIndex: directoryCount - 1, nonce: "seed" });
  const contentDocIds = Array.from({ length: directoryCount }, (_, index) =>
    buildDocId({ kind: "content", generation, blockIndex: index, nonce: "seed" }),
  );
  const entryRefs = {
    controlDocId: buildDocId({ kind: "control", generation, blockIndex: 0, nonce: "control" }),
    directoryDocId: buildDocId({ kind: "directory", generation, blockIndex: 0, nonce: "directory" }),
    runtimeDocId: buildDocId({ kind: "runtime", generation, blockIndex: 0, nonce: "runtime" }),
    contentDocIds,
  };
  const record = {
    scopeKey,
    generation,
    acpSessionId: "acp-planner",
    loadId: "load-planner",
    state: "staging" as const,
    importEndOrdinal: 0,
    entryRefs,
    createdAt: 1000,
  };
  await store.createGeneration({ scopeKey, epoch: lease.epoch, generation: record });
  await store.commitGeneration({
    scopeKey,
    epoch: lease.epoch,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    newGeneration: record,
    retired: [],
    entryClosure: entryRefs,
  });
  const doc = new Y.Doc({ guid: contentId });
  const snapshot = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  const initial: SyncDocRecord = {
    scopeKey,
    generation,
    docId: contentId,
    kind: "content",
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: directoryCount - 1,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
  await store.createDoc({ scopeKey, epoch: lease.epoch, doc: initial });
  const directory = createDirectoryAppender({ store, scopeKey, digest: sha256Digest, random });
  await directory.load(lease, generation, entryRefs);
  const cursor = openLiveCursor(contentId, "content", snapshot);
  const admission = new AdmissionController(capacity);
  return {
    store,
    directory,
    cursor,
    admission,
    scopeKey,
    generation,
    capacity,
    random,
    digest: sha256Digest,
    lease,
    request(text: string): MergeFlushRequest {
      return {
        key: { generation, turnId: "turn", entryId: "entry", contentSlot: "text", contentType: "text/plain" },
        text,
        bytes: new TextEncoder().encode(text).byteLength,
        firstArrivalAt: 1,
        lastArrivalAt: 2,
      };
    },
    async read(docId: string) {
      return await loadCommittedDoc(store, docId);
    },
  };
}
