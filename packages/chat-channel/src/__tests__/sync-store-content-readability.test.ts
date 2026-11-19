import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { captureChange } from "../sync/live/change-capture";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { records } from "../sync/live/writer-support";
import { MAX_DOC_SNAPSHOT_BYTES } from "../sync/protocol/frames";
import type { CommitContentBatchInput } from "../sync/store/types";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";
import { indexedFixture } from "./sync-store-content-shadow-fixture";

for (const prefix of [false, true])
  for (const atomic of [false, true]) {
    // rightOrigin 为空的旧客户端追加也可能排在当前文本前，不能据此把并发增量证明为真实尾插。
    test(`旧客户端无 rightOrigin 的非文本记录仍能 shadow，prefix=${prefix}，原子=${atomic}`, async () => {
      const base = new Y.Doc(),
        current = new Y.Doc(),
        stale = new Y.Doc();
      base.clientID = 100;
      current.clientID = 200;
      stale.clientID = 1;
      records(base, prefix ? [{ recordId: "prefix", kind: "tool_boundary", payload: new Uint8Array([1]) }] : []);
      const snapshot = Y.encodeStateAsUpdate(base),
        vector = Y.encodeStateVector(base);
      Y.applyUpdate(current, snapshot);
      Y.applyUpdate(stale, snapshot);
      records(current, [
        {
          recordId: "record-2",
          kind: "text",
          entryId: "entry",
          contentSlot: "text",
          payload: new TextEncoder().encode("after"),
        },
      ]);
      records(stale, [{ recordId: "record-2", kind: "object_part", payload: new Uint8Array([1]) }]);
      const update = Y.encodeStateAsUpdate(stale, vector);
      expect(Y.decodeUpdate(update).structs.every((item) => item instanceof Y.Item && item.rightOrigin === null)).toBe(
        true,
      );
      const f = await indexedFixture(Y.encodeStateAsUpdate(current));
      try {
        expect((await write(f, atomic, { docId: f.ids[2], fromSeq: 2, updates: [update] })).outcome).toBe("committed");
        const final = await loadCommittedDoc(f.store, f.ids[2]);
        try {
          expect(records<{ kind: string }>(final!.doc)!.get(prefix ? 1 : 0).kind).toBe("object_part");
        } finally {
          final!.doc.destroy();
        }
        expect(
          (
            await f.store.readLiveTextCoverage({
              scopeKey: f.input.scopeKey,
              generation: f.input.generation,
              docIds: [f.ids[0]],
            })
          ).size,
        ).toBe(0);
      } finally {
        base.destroy();
        current.destroy();
        stale.destroy();
        f.store.dispose();
      }
    });
  }

/** 两个写入口使用相同的真实单块批次，目录与 scope 仍由实际 Store 校验。 */
async function write(
  f: Awaited<ReturnType<typeof contentBatchFixture>>,
  atomic: boolean,
  input: {
    docId: string;
    fromSeq: number;
    updates: readonly Uint8Array[];
  },
) {
  const pointer = await f.store.readScopePointer(f.input.scopeKey);
  const batch: CommitContentBatchInput = {
    ...f.input,
    batchId: "mutation",
    digest: "mutation",
    expectedPointerRevision: pointer!.pointerRevision,
    expectedFrontiers: [{ docId: input.docId, lastSeq: input.fromSeq - 1 }],
    updates: input.updates.map((bytes, index) => ({ docId: input.docId, fromSeq: input.fromSeq + index, bytes })),
    newDocs: [],
    seals: [],
    refs: [],
  };
  return atomic ? f.store.commitContentBatch(batch) : f.store.appendUpdates(batch);
}

/** 官方 encoder 省略冗余 map 位，仍由 origin 继承 root.records 的 parentSub。 */
function hiddenReplacement(origin: Y.ID): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  encoder.writeLen(1);
  encoder.writeLen(1);
  encoder.writeClient(9007199254740000);
  encoder.writeLen(0);
  encoder.writeInfo(128 | 8);
  encoder.writeLeftID(origin);
  new Y.ContentAny(["replacement"]).write(encoder, 0);
  encoder.writeLen(0);
  return encoder.toUint8Array();
}

// 原子入口也须以实际 wrapper 身份识别隐藏 map 替换，撤回依赖旧目标的历史证明。
test("原子 flagless wrapper 替换撤回跨块覆盖证明", async () => {
  const f = await indexedFixture(),
    loaded = await loadCommittedDoc(f.store, f.ids[2]);
  try {
    const update = hiddenReplacement(records(loaded!.doc)!._item!.id);
    expect((await write(f, true, { docId: f.ids[2], fromSeq: 2, updates: [update] })).outcome).toBe("committed");
    expect(
      (
        await f.store.readLiveTextCoverage({
          scopeKey: f.input.scopeKey,
          generation: f.input.generation,
          docIds: [f.ids[0]],
        })
      ).size,
    ).toBe(0);
  } finally {
    loaded!.doc.destroy();
    f.store.dispose();
  }
});

for (const atomic of [false, true]) {
  // 新增非文本记录也能改变首条 recordId 选择，旧文本定位失效后不能继续跳过历史。
  test(`非文本前插同名记录撤回跨块覆盖，原子=${atomic}`, async () => {
    const f = await indexedFixture(),
      loaded = await loadCommittedDoc(f.store, f.ids[2]);
    try {
      const update = captureChange(loaded!.doc, () =>
        records(loaded!.doc)!.insert(0, [{ recordId: "record-2", kind: "object_part", payload: new Uint8Array([1]) }]),
      )!;
      expect((await write(f, atomic, { docId: f.ids[2], fromSeq: 2, updates: [update] })).outcome).toBe("committed");
      const query = { scopeKey: f.input.scopeKey, generation: f.input.generation, docIds: [f.ids[0]] };
      expect((await f.store.readLiveTextCoverage(query)).size).toBe(0);
    } finally {
      loaded!.doc.destroy();
      f.store.dispose();
    }
  });

  // 不同身份的普通追加与前插都保留有效的跨块证明，不用全代次回放防御每个工具事件。
  test(`新增不同 recordId 保留跨块证明，原子=${atomic}`, async () => {
    const f = await indexedFixture(),
      loaded = await loadCommittedDoc(f.store, f.ids[2]);
    try {
      const update = captureChange(loaded!.doc, () =>
        records(loaded!.doc)!.insert(0, [
          { recordId: "distinct-tool", kind: "tool_boundary", payload: new Uint8Array([1]) },
        ]),
      )!;
      expect((await write(f, atomic, { docId: f.ids[2], fromSeq: 2, updates: [update] })).outcome).toBe("committed");
      const apply = spyOn(Y, "applyUpdate");
      try {
        expect(
          (
            await f.store.readLiveTextCoverage({
              scopeKey: f.input.scopeKey,
              generation: f.input.generation,
              docIds: [f.ids[0]],
            })
          ).size,
        ).toBe(1);
        expect(apply.mock.calls.length).toBe(0);
      } finally {
        apply.mockRestore();
      }
    } finally {
      loaded!.doc.destroy();
      f.store.dispose();
    }
  });
}

/** 单片均合法，但整批可出现比最终快照更大的中间态。 */
function largeBatch(oversized: boolean) {
  const doc = new Y.Doc();
  doc.clientID = 12345;
  const updates: Uint8Array[] = [];
  let vector = Y.encodeStateVector(doc),
    count = 0;
  for (const amount of oversized ? [20, 20, 7] : [20, 3]) {
    records(
      doc,
      Array.from({ length: amount }, (_, index) => ({
        recordId: `record-${count + index}`,
        kind: "object_part",
        payload: new Uint8Array(10 * 1024),
      })),
    );
    count += amount;
    updates.push(Y.encodeStateAsUpdate(doc, vector));
    vector = Y.encodeStateVector(doc);
  }
  const peak = Y.encodeStateAsUpdate(doc).byteLength;
  records(doc)!.delete(0, count);
  updates.push(Y.encodeStateAsUpdate(doc, vector));
  const snapshot = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return { updates, peak, snapshot };
}

for (const atomic of [false, true])
  for (const oversized of [false, true]) {
    // 新提交必须能按共享中间态界限回放；合法暂超最终上限的批次仍可提交。
    test(`正文写入检查每步 replay 边界，原子=${atomic}，超限=${oversized}`, async () => {
      const f = await contentBatchFixture(),
        batch = largeBatch(oversized);
      try {
        const before = f.store.exportCommittedState(),
          usage = f.usage();
        expect(batch.snapshot.byteLength).toBeLessThan(MAX_DOC_SNAPSHOT_BYTES);
        expect(batch.updates.every((bytes) => bytes.byteLength <= MAX_DOC_SNAPSHOT_BYTES)).toBe(true);
        if (oversized) {
          expect(batch.peak).toBeGreaterThan(MAX_DOC_SNAPSHOT_BYTES * 2);
          await expect(write(f, atomic, { docId: f.ids[0], fromSeq: 1, updates: batch.updates })).rejects.toMatchObject(
            { code: "CAPACITY_EXCEEDED" },
          );
          expect(f.store.exportCommittedState()).toEqual(before);
          expect(f.usage()).toEqual(usage);
        } else {
          expect(batch.peak).toBeGreaterThan(MAX_DOC_SNAPSHOT_BYTES);
          expect((await write(f, atomic, { docId: f.ids[0], fromSeq: 1, updates: batch.updates })).outcome).toBe(
            "committed",
          );
          expect(
            (
              await f.store.readLiveTextCoverage({
                scopeKey: f.input.scopeKey,
                generation: f.input.generation,
                docIds: [f.ids[0]],
              })
            ).size,
          ).toBe(1);
        }
      } finally {
        f.store.dispose();
      }
    });
  }

// 旧版封口账本可能经历过大中间态，可信 final 快照已受限时覆盖读取不得重放旧账本。
test("旧封口块覆盖证明直接读取受限 final canonical", async () => {
  const f = await contentBatchFixture(),
    batch = largeBatch(true);
  try {
    const state = f.store.exportCommittedState(),
      doc = state.docs.find((value) => value.docId === f.ids[0])!;
    Object.assign(doc, {
      state: "sealed",
      finalSeq: batch.updates.length,
      lastSeq: batch.updates.length,
      snapshot: batch.snapshot,
      hash: sha256Digest(batch.snapshot),
    });
    state.updates = batch.updates.map((bytes, index) => ({
      scopeKey: f.input.scopeKey,
      generation: f.input.generation,
      docId: doc.docId,
      updateSeq: index + 1,
      batchId: "legacy",
      digest: "legacy",
      bytes,
    }));
    f.store.restoreFromCommittedState(state);
    const apply = spyOn(Y, "applyUpdate");
    try {
      expect(
        (
          await f.store.readLiveTextCoverage({
            scopeKey: f.input.scopeKey,
            generation: f.input.generation,
            docIds: [doc.docId],
          })
        ).size,
      ).toBe(1);
      expect(apply.mock.calls.length).toBe(1);
    } finally {
      apply.mockRestore();
    }
  } finally {
    f.store.dispose();
  }
});
