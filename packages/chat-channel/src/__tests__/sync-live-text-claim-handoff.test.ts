import { expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { createTextClaim } from "../sync/live/text-claim";
import { records } from "../sync/live/writer-support";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import type { SyncRefRecord } from "../sync/store/types";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";
import { historyRecord, newWriter, readRecords, setupWithHistory, userInput } from "./sync-live-writer-fixture";

// 声明只检查当前尾块时，接管后重发已封口前驱里的消息会产生第二份正文。
test("接管后重发 sealed live 前驱中的消息只保留一次", async () => {
  const f = await textClaimHandoffFixture();
  try {
    await f.append("A");
    await f.append("B");
    await f.reopen();
    await f.append("A");
    expect((await f.readAll()).map((record) => record.entryId)).toEqual(["A", "B"]);
  } finally {
    await f.close();
  }
});

// 历史导入块与首 live 块没有路由关系，旧文本判重必须从确定性的 live-tail 身份进入。
test("有导入历史的旧 live 链在重开后仍可判重", async () => {
  const f = await setupWithHistory([historyRecord("history:user", "imported")]);
  let writer = f.writer;
  try {
    await writer.accept(userInput("A", "same"));
    await writer.seal();
    await writer.accept(userInput("B", "same"));
    await writer.seal();
    await writer.close();
    const snapshot = f.store.exportCommittedState();
    snapshot.refs = [];
    f.store.restoreFromCommittedState(snapshot);
    writer = newWriter(f, { seed: "import-history-reopen" });
    await writer.acquire();
    await writer.accept(userInput("A", "same"));
    await writer.seal();
    const entries = f.store
      .exportCommittedState()
      .docs.filter((doc) => doc.kind === "content")
      .flatMap((doc) => readRecords(f, doc.docId))
      .map((record) => record.entryId)
      .sort();
    expect(entries).toEqual(["A:user", "B:user", "history:user"]);
  } finally {
    await writer.close();
    f.store.dispose();
  }
});

// 声明索引只在原代次内有效，同一用户输入在新投影中仍可独立接纳。
test("换代后旧 live 声明不会抑制新代次同 entry 和 slot", async () => {
  const f = await textClaimHandoffFixture();
  try {
    await f.append("A");
    await f.append("B");
    await f.replaceGeneration();
    await f.append("A");
    const current = f.store.exportCommittedState();
    const newDoc = current.docs.find((doc) => doc.generation === "new-generation" && doc.kind === "content");
    expect(newDoc).toBeDefined();
    expect(current.refs.filter((ref) => ref.generation === "new-generation")).toHaveLength(1);
    expect((await f.readAll()).map((record) => record.entryId).filter((entryId) => entryId === "A")).toHaveLength(2);
  } finally {
    await f.close();
  }
});

// 活跃块的 canonical 基线为空时，索引必须核对已提交 tail，而非只看初始快照。
test("live 文本索引通过 canonical 加连续 tail 核对真实记录", async () => {
  const f = await textClaimHandoffFixture();
  const local = new Y.Doc({ guid: f.contentId });
  try {
    await f.append("A");
    const claims = createTextClaim({
      store: f.store,
      scopeKey: scopeKey(f.scope),
      digest: sha256Digest,
      admission: f.admission,
    });
    expect(
      await claims.claim({
        generation: "gen_cursor",
        entryId: "A",
        contentSlot: "text",
        activeDoc: local,
        historyDocIds: [],
      }),
    ).toBe(false);
    expect((await f.readAll()).map((record) => record.entryId)).toEqual(["A"]);
    claims.reset();
  } finally {
    local.destroy();
    await f.close();
  }
});

// 索引上线前的数据仅沿权威 successor 链补读一次，不把同代次孤块当成已提交声明。
test("旧无索引前驱在重开后判重且不会扫描 orphan", async () => {
  const reads: string[] = [];
  const f = await textClaimHandoffFixture(
    (store) =>
      new Proxy(store, {
        get(target, property) {
          if (property === "readDocStateAt")
            return async (...args: Parameters<typeof store.readDocStateAt>) => {
              reads.push(args[0]);
              return target.readDocStateAt(...args);
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  );
  try {
    await f.append("A");
    await f.append("B");
    const orphanId = buildDocId({ kind: "content", generation: "gen_cursor", blockIndex: 9, nonce: "orphan" });
    await f.reopen(() => {
      const snapshot = f.store.exportCommittedState();
      snapshot.refs = [];
      const template = snapshot.docs.find((doc) => doc.docId === f.contentId);
      if (!template) throw new Error("Missing predecessor");
      const orphan = new Y.Doc({ guid: orphanId });
      records(orphan, [
        {
          recordId: "orphan-record",
          kind: "text",
          entryId: "orphan-only",
          contentSlot: "text",
          payload: new Uint8Array([120]),
        },
      ]);
      const canonical = Y.encodeStateAsUpdate(orphan);
      orphan.destroy();
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
      f.store.restoreFromCommittedState(snapshot);
    });
    const orphan = await loadCommittedDoc(f.store, orphanId);
    if (!orphan) throw new Error("Missing readable orphan baseline");
    try {
      expect(
        records<{ entryId: string }>(orphan.doc)
          ?.toArray()
          .map((record) => record.entryId),
      ).toEqual(["orphan-only"]);
    } finally {
      orphan.doc.destroy();
    }
    reads.length = 0;
    await f.append("A");
    expect(reads.filter((docId) => docId === f.contentId)).toHaveLength(1);
    const checked = reads.length;
    await f.append("fresh");
    await f.append("orphan-only");
    expect(reads).not.toContain(orphanId);
    expect(reads.slice(checked)).not.toContain(f.contentId);
    expect(
      (await f.readAll()).filter((record) => record.recordId !== "orphan-record").map((record) => record.entryId),
    ).toEqual(["A", "B", "fresh", "orphan-only"]);
  } finally {
    await f.close();
  }
});

// 派生引用被破坏时必须暴露错误，不能假称重复成功，也不能提前写入第二份文本。
test("损坏 live 文本引用拒绝后修复引用可重新判定", async () => {
  const f = await textClaimHandoffFixture();
  let original: SyncRefRecord | undefined;
  try {
    await f.append("A");
    await f.append("B");
    await f.reopen(() => {
      const snapshot = f.store.exportCommittedState();
      original = snapshot.refs.find((ref) => ref.docId === f.contentId);
      if (!original) throw new Error("Missing A reference");
      snapshot.refs = snapshot.refs.map((ref) => (ref === original ? { ...ref, recordId: "missing-record" } : ref));
      f.store.restoreFromCommittedState(snapshot);
    });
    const before = f.store.exportCommittedState();
    await expect(f.append("A")).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    expect(f.store.exportCommittedState()).toEqual(before);
    await f.reopen(() => {
      const snapshot = f.store.exportCommittedState();
      snapshot.refs = snapshot.refs.map((ref) => (ref.docId === f.contentId && original ? original : ref));
      f.store.restoreFromCommittedState(snapshot);
    });
    await f.append("A");
    expect((await f.readAll()).map((record) => record.entryId)).toEqual(["A", "B"]);
  } finally {
    await f.close();
  }
});

// 定位引用按条目和槽位隔离，不能以相同正文错误吞掉新的用户内容。
test("不同 entry 或 slot 的相同正文仍可提交", async () => {
  const f = await textClaimHandoffFixture();
  try {
    await f.append("A");
    await f.append("B");
    await f.reopen();
    await f.append("A", "reasoning");
    await f.append("C");
    expect((await f.readAll()).map((record) => [record.entryId, record.contentSlot])).toEqual([
      ["A", "text"],
      ["B", "text"],
      ["A", "reasoning"],
      ["C", "text"],
    ]);
  } finally {
    await f.close();
  }
});

// 一次跨块冲刷只发布一个定位引用，引用必须指向实际提交的最后一条文本记录。
test("跨块文本冲刷原子发布一个末片定位引用", async () => {
  const f = await textClaimHandoffFixture();
  try {
    await f.append("A", "text", "x".repeat(150));
    const committed = f.store.exportCommittedState();
    expect(committed.refs).toHaveLength(1);
    const values = await f.readAll();
    expect(values).toHaveLength(3);
    expect(committed.refs[0]).toMatchObject({
      lookupKind: "live-text",
      recordId: values[2]?.recordId,
      contentSlot: 0,
      partIndex: 0,
      byteStart: 0,
      byteEnd: 22,
    });
    await f.reopen();
    await f.append("A", "text", "x".repeat(150));
    expect(await f.readAll()).toEqual(values);
    expect(f.store.exportCommittedState().refs).toEqual(committed.refs);
  } finally {
    await f.close();
  }
});
