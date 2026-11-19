import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { captureChange } from "../sync/live/change-capture";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { textClaimLookupId } from "../sync/live/text-claim-identity";
import { records } from "../sync/live/writer-support";
import { appendDirectoryPageContent } from "../sync/protocol/directory";
import { buildDocId } from "../sync/protocol/identity";
import type { SyncDocRecord } from "../sync/store/types";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

/** 三块共享一个文本身份，索引目标位于仍可写的末块。 */
async function fixture() {
  const f = await contentBatchFixture();
  f.input.refs = [
    {
      scopeKey: f.input.scopeKey,
      generation: f.input.generation,
      lookupKind: "live-text",
      lookupId: textClaimLookupId(sha256Digest, {
        scopeKey: f.input.scopeKey,
        generation: f.input.generation,
        entryId: "entry",
        contentSlot: "text",
      }),
      contentSlot: 0,
      partIndex: 0,
      docId: f.ids[2],
      recordId: "record-2",
      orderStart: 0,
      orderEnd: 0,
      byteStart: 0,
      byteEnd: 5,
    },
  ];
  expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
  return { ...f, query: { scopeKey: f.input.scopeKey, generation: f.input.generation, docIds: f.ids } };
}

for (const restore of [false, true]) {
  // 删除索引目标会使其它块依赖的同身份定位失效，不能保留跨块旧证明。
  test(`通用删除索引目标撤回跨块覆盖证明，恢复=${restore}`, async () => {
    const f = await fixture();
    try {
      if (restore) {
        f.store.restoreFromCommittedState(f.store.exportCommittedState());
        const lease = await f.store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
        f.input.epoch = lease.epoch;
      }
      expect((await f.store.readLiveTextCoverage(f.query)).size).toBe(3);
      const loaded = await loadCommittedDoc(f.store, f.ids[2]);
      const bytes = captureChange(loaded!.doc, () => records(loaded!.doc)!.delete(0, 1))!;
      loaded!.doc.destroy();
      await f.store.appendUpdates({
        ...f.input,
        batchId: "delete",
        digest: "delete",
        expectedFrontiers: [{ docId: f.ids[2], lastSeq: 1 }],
        updates: [{ docId: f.ids[2], fromSeq: 2, bytes }],
        refs: [],
      });
      const covered = await f.store.readLiveTextCoverage(f.query);
      expect(covered.has(f.ids[0])).toBe(false);
      expect(covered.has(f.ids[1])).toBe(false);
    } finally {
      f.store.dispose();
    }
  });
}

// 恢复后的覆盖缓存与用量缓存彼此独立，新文本必须在没有用量缓存时也使旧证明失效。
test("恢复已证明块后通用新增无索引文本不沿用旧证明", async () => {
  const f = await fixture();
  try {
    f.store.restoreFromCommittedState(f.store.exportCommittedState());
    const lease = await f.store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
    f.input.epoch = lease.epoch;
    expect((await f.store.readLiveTextCoverage(f.query)).size).toBe(3);
    const loaded = await loadCommittedDoc(f.store, f.ids[2]);
    const bytes = captureChange(loaded!.doc, () =>
      records(loaded!.doc, [
        { recordId: "unindexed", entryId: "new", contentSlot: "text", kind: "text", payload: new Uint8Array([1]) },
      ]),
    )!;
    loaded!.doc.destroy();
    await f.store.appendUpdates({
      ...f.input,
      batchId: "unindexed",
      digest: "unindexed",
      expectedFrontiers: [{ docId: f.ids[2], lastSeq: 1 }],
      updates: [{ docId: f.ids[2], fromSeq: 2, bytes }],
      refs: [],
    });
    expect((await f.store.readLiveTextCoverage(f.query)).has(f.ids[2])).toBe(false);
  } finally {
    f.store.dispose();
  }
});

for (const entry of ["create", "successor", "atomic", "sealed", "restore"] as const) {
  // 外来文档入口不能把调用方的派生标记变成可信证明，导出也不携带这些私有缓存。
  test(`文档入口剥离伪造用量和覆盖标记：${entry}`, async () => {
    const f = await contentBatchFixture();
    try {
      const snapshot = f.input.seals[0].finalSnapshot;
      const marker = {
        encodedStateBound: { bytes: 0, splitBytes: 0, uncertain: false, composite: false },
        contentUsage: { recordCountUpper: 0, maxPayloadBytes: 0, hasLiveText: false },
        textCoverage: true,
        textCoverageRevision: 0,
      };
      const id = buildDocId({ kind: "content", generation: f.input.generation, blockIndex: 99, nonce: "forged" });
      const value: SyncDocRecord = Object.assign(
        { ...f.input.newDocs[0], docId: id, blockIndex: 99, snapshot, hash: sha256Digest(snapshot) },
        marker,
      );
      let checked = id;
      if (entry === "create") await f.store.createDoc({ scopeKey: f.input.scopeKey, epoch: f.input.epoch, doc: value });
      else if (entry === "successor")
        await f.store.registerSuccessor({
          scopeKey: f.input.scopeKey,
          epoch: f.input.epoch,
          predecessorDocId: f.ids[0],
          successorDocId: id,
          expectedLastSeq: 0,
          successorDoc: value,
        });
      else if (entry === "sealed")
        await f.store.putSealedIfAbsent({
          scopeKey: f.input.scopeKey,
          epoch: f.input.epoch,
          doc: { ...value, state: "sealed", finalSeq: 0 },
        });
      else {
        if (entry === "atomic") for (const doc of f.input.newDocs) Object.assign(doc, marker);
        await f.store.commitContentBatch(f.input);
        checked = f.ids[2];
        if (entry === "restore") {
          const state = f.store.exportCommittedState();
          for (const doc of state.docs) Object.assign(doc, marker);
          for (const generation of state.generations) Object.assign(generation, { textCoverageRevision: 999 });
          f.store.restoreFromCommittedState(state);
        }
      }
      expect(
        (
          await f.store.readLiveTextCoverage({
            scopeKey: f.input.scopeKey,
            generation: f.input.generation,
            docIds: [checked],
          })
        ).size,
      ).toBe(0);
      const exported = f.store.exportCommittedState();
      expect(
        exported.docs.every(
          (doc) =>
            !("encodedStateBound" in doc) &&
            !("contentUsage" in doc) &&
            !("textCoverage" in doc) &&
            !("textCoverageRevision" in doc),
        ),
      ).toBe(true);
      expect(exported.generations.every((generation) => !("textCoverageRevision" in generation))).toBe(true);
    } finally {
      f.store.dispose();
    }
  });
}

// 代次入口同样不能让外来计数决定私有证明的有效版本。
test("代次登记和读取剥离外来覆盖版本", async () => {
  const f = await contentBatchFixture();
  try {
    const original = f.store.exportCommittedState().generations[0];
    const generation = Object.assign(
      { ...original, generation: "forged-generation", state: "staging" as const },
      { textCoverageRevision: 999 },
    );
    expect(
      (await f.store.createGeneration({ scopeKey: f.input.scopeKey, epoch: f.input.epoch, generation })).outcome,
    ).toBe("committed");
    expect("textCoverageRevision" in (await f.store.readGeneration(f.input.scopeKey, generation.generation))!).toBe(
      false,
    );
  } finally {
    f.store.dispose();
  }
});

// 原子入口同样不能删除其它块依赖的 canonical 目标后继续复用旧证明。
test("原子删除索引目标撤回依赖块证明", async () => {
  const f = await fixture();
  try {
    const loaded = await loadCommittedDoc(f.store, f.ids[2]);
    const bytes = captureChange(loaded!.doc, () => records(loaded!.doc)!.delete(0, 1))!;
    loaded!.doc.destroy();
    const pointer = await f.store.readScopePointer(f.input.scopeKey);
    await f.store.commitContentBatch({
      ...f.input,
      batchId: "atomic-delete",
      digest: "atomic-delete",
      expectedPointerRevision: pointer!.pointerRevision,
      expectedFrontiers: [{ docId: f.ids[2], lastSeq: 1 }],
      updates: [{ docId: f.ids[2], fromSeq: 2, bytes }],
      newDocs: [],
      seals: [],
      refs: [],
    });
    expect((await f.store.readLiveTextCoverage(f.query)).has(f.ids[0])).toBe(false);
  } finally {
    f.store.dispose();
  }
});

// 合法同身份的替换由同批新定位重新证明，仍可复用全部跨块覆盖版本。
test("原子替换正文并重新定位同身份时保持跨块证明", async () => {
  const f = await fixture();
  try {
    const loaded = await loadCommittedDoc(f.store, f.ids[2]);
    const bytes = captureChange(loaded!.doc, () => {
      records(loaded!.doc)!.delete(0, 1);
      records(loaded!.doc, [
        {
          recordId: "replacement",
          entryId: "entry",
          contentSlot: "text",
          kind: "text",
          payload: new TextEncoder().encode("after"),
        },
      ]);
    })!;
    loaded!.doc.destroy();
    const pointer = await f.store.readScopePointer(f.input.scopeKey);
    const replaced = await f.store.commitContentBatch({
      ...f.input,
      batchId: "atomic-replace",
      digest: "atomic-replace",
      expectedPointerRevision: pointer!.pointerRevision,
      expectedFrontiers: [{ docId: f.ids[2], lastSeq: 1 }],
      updates: [{ docId: f.ids[2], fromSeq: 2, bytes }],
      newDocs: [],
      seals: [],
      refs: [{ ...f.input.refs![0], recordId: "replacement" }],
    });
    expect(replaced.outcome).toBe("committed");
    expect(
      (
        await f.store.locateRefs({
          generation: f.input.generation,
          lookupKind: "live-text",
          lookupId: f.input.refs![0].lookupId,
          limit: 1,
        })
      )[0],
    ).toMatchObject({ recordId: "replacement", docId: f.ids[2] });
    const apply = spyOn(Y, "applyUpdate");
    try {
      expect((await f.store.readLiveTextCoverage(f.query)).size).toBe(3);
      expect(apply.mock.calls.length).toBe(0);
    } finally {
      apply.mockRestore();
    }
  } finally {
    f.store.dispose();
  }
});

// 覆盖版本的额度拒绝与正文一起回滚，失败不能使有效历史证明半失效。
test("覆盖版本与破坏性通用变更共用额度事务", async () => {
  const f = await fixture();
  try {
    const loaded = await loadCommittedDoc(f.store, f.ids[2]);
    const bytes = captureChange(loaded!.doc, () => records(loaded!.doc)!.delete(0, 1))!;
    loaded!.doc.destroy();
    const input = {
      ...f.input,
      batchId: "refused-delete",
      digest: "refused-delete",
      expectedFrontiers: [{ docId: f.ids[2], lastSeq: 1 }],
      updates: [{ docId: f.ids[2], fromSeq: 2, bytes }],
      refs: [],
    };
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    f.admission.remaining = 1;
    await expect(f.store.appendUpdates(input)).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    f.admission.remaining = null;
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
    const apply = spyOn(Y, "applyUpdate");
    try {
      expect((await f.store.readLiveTextCoverage(f.query)).size).toBe(3);
      expect(apply.mock.calls.length).toBe(0);
    } finally {
      apply.mockRestore();
    }
  } finally {
    f.store.dispose();
  }
});

// 其它正文的版本变化不会改变已观察的目标指针，证明填充仍必须重校代次前像。
test("覆盖重建重入改变同代版本时拒绝旧证明", async () => {
  const f = await fixture();
  let nested: ReturnType<typeof f.store.appendUpdates> | undefined;
  const apply = spyOn(Y, "applyUpdate");
  try {
    f.store.restoreFromCommittedState(f.store.exportCommittedState());
    const lease = await f.store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
    f.input.epoch = lease.epoch;
    const id = buildDocId({ kind: "content", generation: f.input.generation, blockIndex: 99, nonce: "other" });
    await f.store.createDoc({
      scopeKey: f.input.scopeKey,
      epoch: f.input.epoch,
      doc: { ...f.input.newDocs[0], docId: id, blockIndex: 99 },
    });
    const doc = new Y.Doc();
    const bytes = captureChange(doc, () =>
      records(doc, [
        { recordId: "other", entryId: "other", contentSlot: "text", kind: "text", payload: new Uint8Array([1]) },
      ]),
    )!;
    doc.destroy();
    apply.mockClear();
    f.admission.beforeReserve = (pool) => {
      if (pool !== "controlIndex" || apply.mock.calls.length === 0) return;
      f.admission.beforeReserve = null;
      nested = f.store.appendUpdates({
        ...f.input,
        batchId: "nested-version",
        digest: "nested-version",
        expectedFrontiers: [{ docId: id, lastSeq: 0 }],
        updates: [{ docId: id, fromSeq: 1, bytes }],
        refs: [],
      });
    };
    await expect(f.store.readLiveTextCoverage({ ...f.query, docIds: [f.ids[0]] })).rejects.toMatchObject({
      code: "SEQUENCE_GAP",
    });
    expect((await nested)?.outcome).toBe("committed");
    expect(await f.store.readUpdatesAfter(id, 0, 10)).toHaveLength(1);
  } finally {
    apply.mockRestore();
    f.store.dispose();
  }
});

// 冷恢复后续写和轮转无法立即证明旧身份时应保持未知，随后完整校验可重新建立正缓存。
test("冷恢复续写再轮转后完整索引覆盖可重新建立", async () => {
  const f = await fixture();
  const doc = new Y.Doc(),
    page = new Y.Doc(),
    next = new Y.Doc();
  try {
    f.store.restoreFromCommittedState(f.store.exportCommittedState());
    const lease = await f.store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
    f.input.epoch = lease.epoch;
    const active = await loadCommittedDoc(f.store, f.ids[2]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(active!.doc));
    active!.doc.destroy();
    const ref = (entryId: string, recordId: string, docId = f.ids[2]) => ({
      ...f.input.refs![0],
      lookupId: textClaimLookupId(sha256Digest, {
        scopeKey: f.input.scopeKey,
        generation: f.input.generation,
        entryId,
        contentSlot: "text",
      }),
      docId,
      recordId,
    });
    const record = (recordId: string, entryId: string) => ({
      recordId,
      entryId,
      contentSlot: "text",
      kind: "text",
      payload: new TextEncoder().encode("after"),
    });
    const update = captureChange(doc, () => records(doc, [record("cold-new", "cold-entry")]))!;
    let pointer = await f.store.readScopePointer(f.input.scopeKey);
    await f.store.commitContentBatch({
      ...f.input,
      batchId: "cold-append",
      digest: "cold-append",
      expectedPointerRevision: pointer!.pointerRevision,
      expectedFrontiers: [{ docId: f.ids[2], lastSeq: 1 }],
      updates: [{ docId: f.ids[2], fromSeq: 2, bytes: update }],
      newDocs: [],
      seals: [],
      refs: [ref("cold-entry", "cold-new")],
    });
    const id = buildDocId({ kind: "content", generation: f.input.generation, blockIndex: 3, nonce: "rotation" });
    const nextUpdate = captureChange(next, () => records(next, [record("next-record", "next-entry")]))!;
    const loadedPage = await loadCommittedDoc(f.store, f.pageId);
    Y.applyUpdate(page, Y.encodeStateAsUpdate(loadedPage!.doc));
    loadedPage!.doc.destroy();
    const pageUpdate = captureChange(page, () => appendDirectoryPageContent(page, id))!;
    const finalSnapshot = Y.encodeStateAsUpdate(doc);
    pointer = await f.store.readScopePointer(f.input.scopeKey);
    await f.store.commitContentBatch({
      ...f.input,
      batchId: "cold-rotate",
      digest: "cold-rotate",
      expectedPointerRevision: pointer!.pointerRevision,
      expectedFrontiers: [
        { docId: f.ids[2], lastSeq: 2 },
        { docId: id, lastSeq: 0 },
        { docId: f.pageId, lastSeq: 1 },
      ],
      updates: [
        { docId: id, fromSeq: 1, bytes: nextUpdate },
        { docId: f.pageId, fromSeq: 2, bytes: pageUpdate },
      ],
      newDocs: [{ ...f.input.newDocs[0], docId: id, blockIndex: 3 }],
      seals: [
        { docId: f.ids[2], finalSeq: 2, finalSnapshot, finalHash: sha256Digest(finalSnapshot), successorDocId: id },
      ],
      refs: [ref("next-entry", "next-record", id)],
    });
    const query = { ...f.query, docIds: [...f.ids, id] },
      apply = spyOn(Y, "applyUpdate");
    try {
      expect((await f.store.readLiveTextCoverage(query)).size).toBe(4);
      expect(apply.mock.calls.length).toBeGreaterThan(0);
      apply.mockClear();
      expect((await f.store.readLiveTextCoverage(query)).size).toBe(4);
      expect(apply.mock.calls.length).toBe(0);
    } finally {
      apply.mockRestore();
    }
  } finally {
    doc.destroy();
    page.destroy();
    next.destroy();
    f.store.dispose();
  }
});
