import type * as Y from "yjs";
import type { Reservation } from "../sync/capacity/admission";
import { sha256Digest } from "../sync/clock";
import { readTextClaimDoc } from "../sync/live/text-claim-read";
import { buildDocId, parseDocId, scopeKey } from "../sync/protocol/identity";
import { authorityFixture, text } from "./sync-live-writer-authority-fixture";

/** 真实提交、锁定前沿和额度；只在读出口暂停，删除由正式退休事务执行。 */
export async function sealingClaimFixture(count = 2) {
  const f = await authorityFixture();
  for (let index = 0; index < count; index++) await f.writer.accept(text(`entry-${index}`));
  const key = scopeKey(f.scope),
    generation = parseDocId(f.contentId).generation;
  const pointer = await f.store.readScopePointer(key);
  if (!pointer?.writerOwner) throw new Error("missing writer authority");
  const lease = await f.store.acquireWriter(key, pointer.writerOwner, 30000);
  const successorDocId = buildDocId({ kind: "content", generation, blockIndex: 1, nonce: "sealing-reader" });
  const snapshot = new Uint8Array([0, 0]);
  const result = await f.store.registerSuccessor({
    scopeKey: key,
    epoch: lease.epoch,
    predecessorDocId: f.contentId,
    successorDocId,
    expectedLastSeq: count,
    successorDoc: {
      scopeKey: key,
      generation,
      docId: successorDocId,
      kind: "content",
      state: "active",
      snapshot,
      hash: sha256Digest(snapshot),
      baseSeq: 0,
      finalSeq: null,
      blockIndex: 1,
      ordinalStart: null,
      ordinalEnd: null,
      dependsOn: [],
    },
  });
  if (result.outcome !== "committed") throw new Error(`route registration returned ${result.outcome}`);
  const holds: Reservation[] = [];
  const usage = () => ({ hot: f.admission.used("hotDocLive"), control: f.admission.used("controlIndex") });
  return {
    ...f,
    key,
    generation,
    lease,
    usage,
    usageWithoutReader() {
      return {
        hot:
          f.admission.used("hotDocLive") -
          holds.filter((hold) => hold.pool === "hotDocLive").reduce((sum, hold) => sum + hold.bytes, 0),
        control:
          f.admission.used("controlIndex") -
          holds.filter((hold) => hold.pool === "controlIndex").reduce((sum, hold) => sum + hold.bytes, 0),
      };
    },
    readClaim<T>(consume: (doc: Y.Doc, lastSeq: number) => T, assertCurrent = () => {}) {
      return readTextClaimDoc({
        store: f.store,
        scopeKey: key,
        docId: f.contentId,
        assertCurrent,
        consume,
        admission: {
          reserve(pool, bytes) {
            const hold = f.admission.reserve(pool, bytes);
            holds.push(hold);
            return hold;
          },
        },
      });
    },
  };
}
