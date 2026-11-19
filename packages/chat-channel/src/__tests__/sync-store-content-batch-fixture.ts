import * as Y from "yjs";
import { AdmissionController, type ServerPoolName } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { type DigestFn, sha256Digest } from "../sync/clock";
import { captureChange } from "../sync/live/change-capture";
import { records } from "../sync/live/writer-support";
import {
  appendDirectoryPageContent,
  buildDirectoryPageSnapshot,
  buildDirectoryRootSnapshot,
  directoryPageDocId,
  directoryRootDocId,
} from "../sync/protocol/directory";
import { SyncProtocolError } from "../sync/protocol/errors";
import { buildDocId } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { CommitContentBatchInput, SyncDocRecord, SyncGenerationRecord } from "../sync/store/types";

/** 在真实预算申请处拒绝，验证最后一份额度失败也不会发布文本前缀。 */
class BatchAdmission extends AdmissionController {
  remaining: number | null = null;
  beforeReserve: ((pool: ServerPoolName, bytes: number) => void) | null = null;
  override reserve(pool: ServerPoolName, bytes: number) {
    this.beforeReserve?.(pool, bytes);
    if (this.remaining !== null && this.remaining-- === 0)
      throw new SyncProtocolError("ADMISSION_REJECTED", { message: "test batch budget exhausted" });
    return super.reserve(pool, bytes);
  }
}

/** 真实跨三块文本与同批目录更新，只保留当前块和本次新增块。 */
export async function contentBatchFixture(
  capacity: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY,
  options: { readonly digest?: DigestFn } = {},
) {
  let now = 1000;
  const admission = new BatchAdmission(capacity);
  const store = new MemoryProjectionStore({
    clock: { now: () => now },
    digest: options.digest ?? sha256Digest,
    capacity,
    memoryBudget: admission,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const scopeKey = "scope_content_batch";
  const generation = "gen_content_batch";
  const lease = await store.acquireWriter(scopeKey, "owner", 1000);
  const ids = [0, 1, 2].map((blockIndex) => buildDocId({ kind: "content", generation, blockIndex, nonce: "text" }));
  const pageId = directoryPageDocId(generation, 1);
  const rootId = directoryRootDocId(generation);
  const entryRefs = {
    controlDocId: "control",
    directoryDocId: rootId,
    runtimeDocId: "runtime",
    contentDocIds: [ids[0]],
  };
  const row: SyncGenerationRecord = {
    scopeKey,
    generation,
    acpSessionId: "ses_batch",
    loadId: "load",
    state: "staging",
    importEndOrdinal: null,
    createdAt: now,
    entryRefs,
  };
  await store.createGeneration({ scopeKey, epoch: lease.epoch, generation: row });
  await store.commitGeneration({
    scopeKey,
    epoch: lease.epoch,
    newGeneration: row,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    entryClosure: entryRefs,
    retired: [],
  });
  const empty = new Uint8Array([0, 0]);
  const docRecord = (
    docId: string,
    snapshot: Uint8Array,
    kind: "content" | "directory",
    blockIndex: number,
  ): SyncDocRecord => ({
    scopeKey,
    generation,
    docId,
    kind,
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  });
  const pageSnapshot = buildDirectoryPageSnapshot([ids[0]], null);
  for (const doc of [
    docRecord(ids[0], empty, "content", 0),
    docRecord(pageId, pageSnapshot, "directory", 1),
    docRecord(rootId, buildDirectoryRootSnapshot(pageId), "directory", 0),
  ])
    await store.createDoc({ scopeKey, epoch: lease.epoch, doc });
  const snapshots: Uint8Array[] = [];
  const updates = ids.map((docId, index) => {
    const doc = new Y.Doc({ guid: docId });
    try {
      Y.applyUpdate(doc, empty);
      const bytes = captureChange(doc, () =>
        records(doc, [
          {
            recordId: `record-${index}`,
            entryId: "entry",
            contentSlot: "text",
            contentType: "text/plain",
            partIndex: 0,
            kind: "text",
            payload: new TextEncoder().encode(["before", "middle", "after"][index]),
          },
        ]),
      )!;
      snapshots.push(Y.encodeStateAsUpdate(doc));
      return { docId, fromSeq: 1, bytes };
    } finally {
      doc.destroy();
    }
  });
  const page = new Y.Doc();
  Y.applyUpdate(page, pageSnapshot);
  const directoryUpdate = captureChange(page, () => {
    appendDirectoryPageContent(page, ids[1]);
    appendDirectoryPageContent(page, ids[2]);
  })!;
  page.destroy();
  updates.push({ docId: pageId, fromSeq: 1, bytes: directoryUpdate });
  const input: CommitContentBatchInput = {
    scopeKey,
    epoch: lease.epoch,
    owner: lease.owner,
    generation,
    batchId: "content_batch",
    digest: sha256Digest(new TextEncoder().encode("beforemiddleafter")),
    expectedPointerRevision: 1,
    expectedFrontiers: updates.map(({ docId }) => ({ docId, lastSeq: 0 })),
    updates,
    newDocs: [docRecord(ids[1], empty, "content", 1), docRecord(ids[2], empty, "content", 2)],
    seals: [0, 1].map((index) => ({
      docId: ids[index],
      finalSeq: 1,
      finalSnapshot: snapshots[index],
      finalHash: sha256Digest(snapshots[index]),
      successorDocId: ids[index + 1],
    })),
  };
  return {
    store,
    admission,
    input,
    ids,
    pageId,
    advance(ms: number) {
      now += ms;
    },
    usage: () => ["transportCache", "hotDocLive", "controlIndex"].map((pool) => admission.used(pool as ServerPoolName)),
  };
}
