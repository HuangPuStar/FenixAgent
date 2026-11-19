import { expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { textClaimRef } from "../sync/live/text-claim-identity";
import { records } from "../sync/live/writer-support";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";

// 正文存在但不在权威 live 链上的同代次孤块，不能通过损坏引用冒充已经提交的用户输入。
test("完全匹配的 orphan 文本索引明确拒绝且不吞掉未提交消息", async () => {
  const f = await textClaimHandoffFixture();
  try {
    await f.append("A");
    await f.append("B");
    const orphanId = buildDocId({ kind: "content", generation: "gen_cursor", blockIndex: 9, nonce: "orphan" });
    await f.reopen(() => {
      const snapshot = f.store.exportCommittedState();
      const template = snapshot.docs.find((doc) => doc.docId === f.contentId);
      if (!template) throw new Error("Missing content predecessor");
      const record = {
        recordId: "orphan-record",
        kind: "text" as const,
        entryId: "orphan-only",
        contentSlot: "text",
        contentType: "text/plain",
        partIndex: 0,
        payload: new TextEncoder().encode("orphan payload"),
      };
      const doc = new Y.Doc({ guid: orphanId });
      records(doc, [record]);
      const canonical = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      snapshot.docs.push({
        ...template,
        docId: orphanId,
        blockIndex: 9,
        snapshot: canonical,
        baseSnapshot: canonical,
        hash: sha256Digest(canonical),
        baseHash: sha256Digest(canonical),
        baseSeq: 0,
        lastSeq: 0,
        finalSeq: 0,
      });
      snapshot.refs.push(
        textClaimRef(
          sha256Digest,
          {
            scopeKey: scopeKey(f.scope),
            generation: "gen_cursor",
            entryId: "orphan-only",
            contentSlot: "text",
          },
          orphanId,
          record,
        ),
      );
      f.store.restoreFromCommittedState(snapshot);
    });
    const before = f.store.exportCommittedState();
    await expect(f.append("orphan-only")).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    expect(f.store.exportCommittedState()).toEqual(before);
    await f.reopen(() => {
      const snapshot = f.store.exportCommittedState();
      snapshot.refs = snapshot.refs.filter((ref) => ref.docId !== orphanId);
      f.store.restoreFromCommittedState(snapshot);
    });
    await f.append("orphan-only");
    expect(
      (await f.readAll()).filter((record) => record.recordId !== "orphan-record").map((record) => record.entryId),
    ).toEqual(["A", "B", "orphan-only"]);
  } finally {
    await f.close();
  }
});

// 谱系归属缓存复用同链，每次 canonical 读取仍确认目标生命周期；轮换只检查新扩展。
test("文本索引归属缓存复用同链并随 live 尾块增量延伸", async () => {
  const inspected: string[] = [];
  const f = await textClaimHandoffFixture(
    (store) =>
      new Proxy(store, {
        get(target, property) {
          if (property === "readSuccessor")
            return async (...args: Parameters<typeof store.readSuccessor>) => {
              inspected.push(args[1]);
              return target.readSuccessor(...args);
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  );
  try {
    await f.append("A");
    await f.append("B");
    await f.append("C");
    await f.reopen();
    const chain = f.store
      .exportCommittedState()
      .docs.filter((doc) => doc.kind === "content")
      .sort((left, right) => left.blockIndex! - right.blockIndex!)
      .map((doc) => doc.docId);
    inspected.length = 0;
    await f.append("A");
    expect(inspected).toEqual([...chain, chain[0]!]);
    const firstInspection = [...inspected];
    await f.append("B");
    expect(inspected).toEqual([...firstInspection, chain[1]!]);
    for (const entryId of ["E", "F"])
      await f.writer.accept({
        kind: "text-delta",
        turnId: entryId,
        entryId,
        contentSlot: "text",
        contentType: "text/plain",
        delta: "same text",
      });
    inspected.length = 0;
    await f.append("E");
    const extension = f.store
      .exportCommittedState()
      .docs.filter((doc) => doc.kind === "content" && doc.blockIndex! >= 2)
      .sort((left, right) => left.blockIndex! - right.blockIndex!)
      .map((doc) => doc.docId);
    expect(inspected).toEqual([...extension, extension[1]!]);
    expect(inspected).not.toContain(f.contentId);
    expect((await f.readAll()).map((record) => record.entryId)).toEqual(["A", "B", "C", "E", "F"]);
  } finally {
    await f.close();
  }
});
