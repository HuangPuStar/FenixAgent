import { expect, test } from "bun:test";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import { authorityFixture, rejection, text } from "./sync-live-writer-authority-fixture";

for (const blocked of [false, true]) {
  // 同代离线恢复可带来很长的真实前驱链；预留窗口必须按读到的局部元数据扩容，而非永久固定在旧缓存大小。
  test(`重建清空缓存后的三千前驱可增长重判信用并恰好写一次：global blocked=${blocked}`, async () => {
    const f = await authorityFixture({ maxBytes: 1 << 20 });
    let hold: ReturnType<typeof f.admission.reserve> | undefined;
    const readGeneration = f.store.readGeneration.bind(f.store);
    try {
      await f.writer.accept(text("retained-lineage"));
      const snapshot = f.store.exportCommittedState();
      const original = snapshot.docs.find((doc) => doc.docId === f.contentId)!;
      const generation = original.generation;
      const ids = [f.contentId];
      for (let index = 1; index <= 3000; index++) {
        const prefix = `sync/content/${generation}/${index}/`;
        ids.push(
          buildDocId({ kind: "content", generation, blockIndex: index, nonce: "x".repeat(256 - prefix.length) }),
        );
      }
      snapshot.docs = snapshot.docs.filter((doc) => doc.docId !== f.contentId);
      for (const [index, docId] of ids.entries()) {
        snapshot.docs.push({
          ...original,
          docId,
          blockIndex: index,
          state: index === 3000 ? "active" : "sealed",
          finalSeq: index === 3000 ? null : 0,
          sealedAt: index === 3000 ? null : 1000,
        });
        if (index < 3000)
          snapshot.successors.push({
            predecessorDocId: docId,
            route: { successorDocId: ids[index + 1]!, expectedLastSeq: 0 },
          });
      }
      f.store.restoreFromCommittedState(snapshot);
      let reads = 0;
      f.store.readGeneration = async (...args) => {
        const row = await readGeneration(...args);
        if (blocked && ++reads === 2) hold = f.admission.reserve("controlIndex", f.admission.available("controlIndex"));
        return row;
      };
      if (blocked) {
        await expect(f.writer.acquire()).rejects.toHaveProperty("code", "ADMISSION_REJECTED");
        expect(hold).toBeDefined();
        expect(f.admission.available("controlIndex")).toBe(0);
        expect(
          f.store.exportCommittedState().updates.filter((update) => update.docId.startsWith("sync/content/")),
        ).toHaveLength(0);
        expect(f.admission.used("ingressSpool")).toBeGreaterThan(0);
        const refused = await rejection(f.writer.accept(text("retained-lineage")));
        expect(refused).toHaveProperty("code", "ADMISSION_REJECTED");
        expect(
          f.store.exportCommittedState().updates.filter((update) => update.docId.startsWith("sync/content/")),
        ).toHaveLength(0);
        hold!.release();
        await f.writer.accept(text("retained-lineage"));
      } else await f.writer.acquire();
      await f.writer.close();
      expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual([
        "retained-lineage",
      ]);
      expect(f.store.exportCommittedState().refs.filter((ref) => ref.lookupKind === "live-text")).toHaveLength(1);
      expect((await f.store.readScopePointer(scopeKey(f.scope)))!.writerOwner).toBeNull();
      expect(f.admission.used("ingressSpool")).toBe(0);
    } finally {
      hold?.release();
      f.store.readGeneration = readGeneration;
      await f.close();
    }
    expect(f.admission.used("controlIndex")).toBe(0);
  });
}
