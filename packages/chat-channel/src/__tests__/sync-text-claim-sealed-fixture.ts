import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import type { LiveRecordValue } from "../sync/live/live-writer-types";
import { createTextClaim } from "../sync/live/text-claim";
import { textClaimRef } from "../sync/live/text-claim-identity";
import { concatParts, records } from "../sync/live/writer-support";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import { fixture } from "./sync-live-admission-fixture";

/** 旧版本可提交的整批历史：每条 update 合法，最终只留一条文本，中间态超过两份快照上限。 */
function legacyBatch() {
  const doc = new Y.Doc();
  doc.clientID = 12345;
  const updates: Uint8Array[] = [];
  let vector = Y.encodeStateVector(doc);
  try {
    for (const [entryId, count, bytes] of [
      ["first", 20, 10240],
      ["second", 20, 10240],
      ["third", 8, 8192],
    ] as const) {
      records(
        doc,
        Array.from({ length: count }, (_, partIndex) => ({
          recordId: `${entryId}-${partIndex}`,
          entryId,
          contentSlot: "text",
          contentType: "text/plain",
          partIndex,
          kind: "text",
          payload: new Uint8Array(bytes),
        })),
      );
      updates.push(Y.encodeStateAsUpdate(doc, vector));
      vector = Y.encodeStateVector(doc);
    }
    const intermediateBytes = Y.encodeStateAsUpdate(doc).byteLength;
    const record: LiveRecordValue = {
      recordId: "retained-text",
      entryId: "existing",
      contentSlot: "text",
      contentType: "text/plain",
      partIndex: 0,
      kind: "text",
      payload: new TextEncoder().encode("canonical"),
    };
    doc.transact(() => {
      records(doc)!.delete(0, 48);
      records(doc, [record]);
    });
    updates.push(Y.encodeStateAsUpdate(doc, vector));
    return { updates, intermediateBytes, snapshot: Y.encodeStateAsUpdate(doc), record };
  } finally {
    doc.destroy();
  }
}

/** 经可移植恢复边界加载旧提交，不绕过新写入路径对中间态的拒绝。 */
export async function sealedClaimFixture(indexed = false) {
  const f = await fixture();
  await f.writer.close();
  const key = scopeKey(f.scope),
    snapshot = f.store.exportCommittedState();
  const old = snapshot.docs.find((doc) => doc.docId === f.contentId)!;
  const generation = old.generation;
  const activeId = buildDocId({ kind: "content", generation, blockIndex: 1, nonce: "sealed-successor" });
  const batch = legacyBatch(),
    digest = sha256Digest(concatParts(batch.updates));
  Object.assign(old, {
    state: "sealed",
    finalSeq: 4,
    lastSeq: 4,
    snapshot: batch.snapshot,
    hash: sha256Digest(batch.snapshot),
    sealedAt: 1000,
  });
  snapshot.docs.push({
    ...old,
    docId: activeId,
    state: "active",
    blockIndex: 1,
    finalSeq: null,
    lastSeq: 0,
    snapshot: old.baseSnapshot,
    hash: old.baseHash,
    sealedAt: null,
  });
  snapshot.updates.push(
    ...batch.updates.map((bytes, index) => ({
      scopeKey: key,
      generation,
      docId: old.docId,
      updateSeq: index + 1,
      bytes,
      batchId: "legacy-batch",
      digest,
    })),
  );
  snapshot.batches.push({
    scopeKey: key,
    batchId: "legacy-batch",
    digest,
    frontiers: [{ docId: old.docId, lastSeq: 4 }],
  });
  snapshot.successors.push({ predecessorDocId: old.docId, route: { successorDocId: activeId, expectedLastSeq: 4 } });
  const identity = { scopeKey: key, generation, entryId: batch.record.entryId, contentSlot: batch.record.contentSlot };
  if (indexed) snapshot.refs.push(textClaimRef(sha256Digest, identity, old.docId, batch.record));
  f.store.restoreFromCommittedState(snapshot);
  const active = new Y.Doc({ guid: activeId });
  const claims = createTextClaim({ store: f.store, admission: f.admission, scopeKey: key, digest: sha256Digest });
  return {
    ...f,
    key,
    generation,
    batch,
    active,
    claims,
    input: { generation, entryId: "existing", contentSlot: "text", activeDoc: active, historyDocIds: [] },
    async close() {
      claims.reset();
      active.destroy();
      await f.close();
    },
  };
}
