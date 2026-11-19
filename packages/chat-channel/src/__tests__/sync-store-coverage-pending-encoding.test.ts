import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { records } from "../sync/live/writer-support";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

for (const oversized of [false, true]) {
  // pending 校准仍未知；同状态的多次检查复用测量，但更严 final MAX 仍必须拒绝超限状态。
  test(`pending 覆盖重放每个 Doc 状态只精确编码一次，最终超限=${oversized}`, async () => {
    const f = await contentBatchFixture(),
      source = new Y.Doc(),
      base = new Y.Doc();
    source.clientID = 12345;
    base.clientID = 67890;
    try {
      records(base, []);
      source.getText("pending").insert(0, "prefix");
      let vector = Y.encodeStateVector(source);
      source.getText("pending").insert(6, "a");
      Y.applyUpdate(base, Y.encodeStateAsUpdate(source, vector));
      expect(base.store.pendingStructs).not.toBeNull();
      const updates: Uint8Array[] = [];
      for (const text of oversized ? ["b".repeat(200 * 1024), "c".repeat(32 * 1024)] : ["b", "c"]) {
        vector = Y.encodeStateVector(source);
        source.getText("pending").insert(source.getText("pending").length, text);
        updates.push(Y.encodeStateAsUpdate(source, vector));
      }
      const snapshot = f.store.exportCommittedState(),
        doc = snapshot.docs.find((value) => value.docId === f.ids[0])!;
      const bytes = Y.encodeStateAsUpdate(base),
        hash = sha256Digest(bytes);
      Object.assign(doc, { snapshot: bytes, hash, baseSnapshot: bytes, baseHash: hash, lastSeq: 2 });
      snapshot.updates = updates.map((update, index) => ({
        scopeKey: f.input.scopeKey,
        generation: f.input.generation,
        docId: doc.docId,
        updateSeq: index + 1,
        batchId: `pending-${index}`,
        digest: `pending-${index}`,
        bytes: update,
      }));
      f.store.restoreFromCommittedState(snapshot);
      const apply = spyOn(Y, "applyUpdate"),
        encodeState = Y.encodeStateAsUpdate,
        versions: number[] = [];
      const encode = spyOn(Y, "encodeStateAsUpdate").mockImplementation((value) => {
        expect(value.store.pendingStructs).not.toBeNull();
        versions.push(apply.mock.calls.length);
        return encodeState(value);
      });
      const usage = f.usage();
      try {
        const query = f.store.readLiveTextCoverage({
          scopeKey: f.input.scopeKey,
          generation: f.input.generation,
          docIds: [doc.docId],
        });
        if (oversized) {
          await expect(query).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
          expect(f.usage()).toEqual(usage);
        } else expect((await query).size).toBe(1);
        expect(versions).toEqual([1, 2, 3]);
        expect(f.usage().slice(0, 2)).toEqual(usage.slice(0, 2));
      } finally {
        encode.mockRestore();
        apply.mockRestore();
      }
    } finally {
      source.destroy();
      base.destroy();
      f.store.dispose();
    }
  });
}
