import { expect } from "bun:test";
import { sha256Digest } from "../sync/clock";
import { textClaimLookupId } from "../sync/live/text-claim-identity";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

/** 三块共享同一文本身份，当前末片真实 canonical 是跨块覆盖证明的目标。 */
export async function indexedFixture(tailUpdate?: Uint8Array) {
  const f = await contentBatchFixture();
  if (tailUpdate)
    f.input.updates = f.input.updates.map((update) =>
      update.docId === f.ids[2] ? { ...update, bytes: tailUpdate } : update,
    );
  f.input.refs = [
    {
      scopeKey: f.input.scopeKey,
      generation: f.input.generation,
      lookupKind: "live-text",
      contentSlot: 0,
      partIndex: 0,
      lookupId: textClaimLookupId(sha256Digest, {
        scopeKey: f.input.scopeKey,
        generation: f.input.generation,
        entryId: "entry",
        contentSlot: "text",
      }),
      docId: f.ids[2],
      recordId: "record-2",
      orderStart: 0,
      orderEnd: 0,
      byteStart: 0,
      byteEnd: 5,
    },
  ];
  expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
  return f;
}
