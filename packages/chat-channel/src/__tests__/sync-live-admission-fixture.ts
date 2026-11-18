import * as Y from "yjs";
import { AdmissionController, type Reservation } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { createLiveWriter, type LiveInput, type LiveRecordValue } from "../sync/live/live-writer";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { records } from "../sync/live/writer-support";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { AppendUpdatesInput, SyncDocRecord } from "../sync/store/types";

/** 完整 Store、真实额度和真实 Yjs，只在存储边界注入读失败或回执丢失。 */
export async function fixture() {
  const scope = { organizationId: "org_cursor", rcsSessionId: "rcs_cursor" };
  const key = scopeKey(scope);
  const generation = "gen_cursor";
  const clock = { now: () => 1000 };
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
    memoryBudget: admission,
  });
  const id = (kind: "control" | "directory" | "runtime" | "content") =>
    buildDocId({ kind, generation, blockIndex: 0, nonce: kind });
  const entryRefs = {
    controlDocId: id("control"),
    directoryDocId: id("directory"),
    runtimeDocId: id("runtime"),
    contentDocIds: [id("content")],
  };
  const lease = await store.acquireWriter(key, "bootstrap", 1000);
  const row = {
    scopeKey: key,
    generation,
    acpSessionId: "ses_cursor",
    loadId: "load",
    state: "staging" as const,
    importEndOrdinal: null,
    createdAt: 1000,
    entryRefs,
  };
  await store.createGeneration({ scopeKey: key, epoch: lease.epoch, generation: row });
  await store.commitGeneration({
    scopeKey: key,
    epoch: lease.epoch,
    newGeneration: row,
    entryClosure: entryRefs,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    retired: [],
  });
  for (const kind of ["runtime", "content"] as const) {
    const doc = new Y.Doc();
    const snapshot = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const record: SyncDocRecord = {
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
    };
    await store.createDoc({ scopeKey: key, epoch: lease.epoch, doc: record });
  }
  await store.releaseWriter(lease);
  const faults = {
    failReads: false,
    throwAfterWrite: false,
    appendCalls: 0,
    writeError: null as unknown,
    rejectOnAppend: 0,
    hold: null as Reservation | null,
  };
  const readError = new Error("reload unavailable");
  const replyError = new Error("commit reply lost");
  const wrapped = new Proxy(store, {
    get(target, property) {
      if (property === "readDocStateAt")
        return (...args: Parameters<MemoryProjectionStore["readDocStateAt"]>) =>
          faults.failReads ? Promise.reject(readError) : target.readDocStateAt(...args);
      if (property === "appendUpdates")
        return async (input: AppendUpdatesInput) => {
          faults.appendCalls++;
          if (faults.appendCalls === faults.rejectOnAppend)
            faults.hold = admission.reserve("hotDocLive", admission.available("hotDocLive"));
          try {
            const result = await target.appendUpdates(input);
            if (faults.throwAfterWrite) {
              faults.throwAfterWrite = false;
              throw replyError;
            }
            return result;
          } catch (error) {
            faults.writeError = error;
            throw error;
          }
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let writerSeed = 0;
  const makeWriter = () =>
    createLiveWriter({
      scope,
      store: wrapped,
      clock,
      digest: sha256Digest,
      random: deterministicRandomSource(`cursor-${writerSeed++}`),
      capacity: DEFAULT_SYNC_CAPACITY,
      admission,
      merge: { maxDelayMs: 600000, maxBytes: 1 << 20 },
      limits: RUNTIME_DOC_LIMITS,
      rotation: {
        clock,
        random: deterministicRandomSource(`rotate-${writerSeed}`),
        limits: RUNTIME_DOC_LIMITS,
        maxResidentMs: 600000,
        maxTransactions: 1000,
      },
    });
  let writer = makeWriter();
  await writer.acquire();
  const read = async () => {
    const committed = await loadCommittedDoc(store, id("content"));
    if (!committed) throw new Error("Missing committed content");
    try {
      return records<LiveRecordValue>(committed.doc)?.toArray() ?? [];
    } finally {
      committed.doc.destroy();
    }
  };
  return {
    store,
    get writer() {
      return writer;
    },
    admission,
    faults,
    replyError,
    read,
    contentId: id("content"),
    runtimeId: id("runtime"),
    async reopen() {
      await writer.close();
      writer = makeWriter();
      await writer.acquire();
    },
    async readAll() {
      const values: LiveRecordValue[] = [];
      const docs = store
        .exportCommittedState()
        .docs.filter((doc) => doc.kind === "content")
        .sort((a, b) => a.blockIndex - b.blockIndex);
      for (const doc of docs) {
        const committed = await loadCommittedDoc(store, doc.docId);
        if (!committed) throw new Error("Missing committed content");
        try {
          values.push(...(records<LiveRecordValue>(committed.doc)?.toArray() ?? []));
        } finally {
          committed.doc.destroy();
        }
      }
      return values;
    },
    async close() {
      faults.hold?.release();
      await writer.close();
      store.dispose();
    },
  };
}

/** 小对象直接落内容块，能够观察拒绝后的 Yjs 依赖是否被污染。 */
export function contentObjectInput(value: string): LiveInput {
  return {
    kind: "content-object",
    turnId: "turn",
    entryId: value,
    contentSlot: "object",
    contentType: "application/json",
    object: { value: { value }, meta: { kind: "history_object", entryId: value } },
  };
}
