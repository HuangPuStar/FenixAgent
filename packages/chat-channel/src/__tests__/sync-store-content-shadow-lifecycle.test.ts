import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { captureChange } from "../sync/live/change-capture";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { textClaimLookupId } from "../sync/live/text-claim-identity";
import { records } from "../sync/live/writer-support";
import { EMPTY_RECORD_ID_FILTER } from "../sync/store/memory-record-id-filter";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";
import { indexedFixture } from "./sync-store-content-shadow-fixture";

/** 同名非文本插入改变 first-wins canonical 目标。 */
async function shadow(f: Awaited<ReturnType<typeof indexedFixture>>) {
  const loaded = await loadCommittedDoc(f.store, f.ids[2]);
  try {
    return captureChange(loaded!.doc, () =>
      records(loaded!.doc)!.insert(0, [{ recordId: "record-2", kind: "object_part", payload: new Uint8Array([1]) }]),
    )!;
  } finally {
    loaded!.doc.destroy();
  }
}

/** 每次使用不同收据键，避免把序号检查误变成幂等重试。 */
function append(f: Awaited<ReturnType<typeof indexedFixture>>, seq: number, bytes: Uint8Array) {
  return f.store.appendUpdates({
    ...f.input,
    batchId: `shadow-${seq}`,
    digest: `shadow-${seq}`,
    expectedFrontiers: [{ docId: f.ids[2], lastSeq: seq - 1 }],
    updates: [{ docId: f.ids[2], fromSeq: seq, bytes }],
    refs: [],
  });
}

// pending 中的同名记录稍后可被无 recordId 的依赖激活，不能在检查点丢掉其不确定性。
test("待集成 shadow 由普通前缀激活后撤回跨块证明", async () => {
  const f = await indexedFixture(),
    loaded = await loadCommittedDoc(f.store, f.ids[2]);
  try {
    const value = loaded!.doc;
    value.clientID = 456;
    const baseVector = Y.encodeStateVector(value);
    value.getArray("outside").push([0]);
    const prefix = Y.encodeStateAsUpdate(value, baseVector),
      vector = Y.encodeStateVector(value);
    records(value)!.insert(0, [{ recordId: "record-2", kind: "object_part", payload: new Uint8Array([1]) }]);
    const pending = Y.encodeStateAsUpdate(value, vector);
    expect((await append(f, 2, pending)).outcome).toBe("committed");
    const partial = await loadCommittedDoc(f.store, f.ids[2]);
    try {
      expect(partial!.doc.store.pendingStructs).not.toBeNull();
    } finally {
      partial!.doc.destroy();
    }
    expect((await append(f, 3, prefix)).outcome).toBe("committed");
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

for (const mode of ["separate", "batch", "delta"] as const) {
  // pending 非文本与文本的同批、同 delta 和分批组合都必须识别 ID 冲突。
  test(`待集成非文本先于索引文本到达仍能撤回后建证明，模式=${mode}`, async () => {
    const f = await contentBatchFixture(),
      base = new Y.Doc(),
      pendingSource = new Y.Doc(),
      textSource = new Y.Doc();
    base.clientID = 100;
    pendingSource.clientID = 1;
    textSource.clientID = 200;
    try {
      records(base, [{ recordId: "prefix", kind: "tool_boundary", payload: new Uint8Array([1]) }]);
      const initial = Y.encodeStateAsUpdate(base),
        baseVector = Y.encodeStateVector(base);
      Y.applyUpdate(pendingSource, initial);
      Y.applyUpdate(textSource, initial);
      pendingSource.getArray("outside").push([0]);
      const dependency = Y.encodeStateAsUpdate(pendingSource, baseVector),
        pendingVector = Y.encodeStateVector(pendingSource);
      records(pendingSource, [{ recordId: "record-2", kind: "object_part", payload: new Uint8Array([1]) }]);
      const pending = Y.encodeStateAsUpdate(pendingSource, pendingVector);
      records(textSource, [
        {
          recordId: "record-2",
          kind: "text",
          entryId: "entry",
          contentSlot: "text",
          payload: new TextEncoder().encode("after"),
        },
      ]);
      const text = Y.encodeStateAsUpdate(textSource, baseVector);
      f.input.updates = f.input.updates.map((update) =>
        update.docId === f.ids[2] ? { ...update, bytes: initial } : update,
      );
      f.input.refs = [];
      expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
      const commit = (seq: number, bytes: readonly Uint8Array[], refs: typeof f.input.refs = []) =>
        f.store.appendUpdates({
          ...f.input,
          batchId: `before-${seq}`,
          digest: `before-${seq}`,
          expectedFrontiers: [{ docId: f.ids[2], lastSeq: seq - 1 }],
          updates: bytes.map((update, index) => ({ docId: f.ids[2], fromSeq: seq + index, bytes: update })),
          refs,
        });
      const ref = {
        scopeKey: f.input.scopeKey,
        generation: f.input.generation,
        lookupKind: "live-text" as const,
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
        byteStart: 0,
        byteEnd: 5,
        orderStart: 0,
        orderEnd: 0,
      };
      if (mode === "separate") {
        expect((await commit(2, [pending])).outcome).toBe("committed");
        expect((await commit(3, [text], [ref])).outcome).toBe("committed");
      } else
        expect(
          (await commit(2, mode === "batch" ? [pending, text] : [Y.mergeUpdates([pending, text])], [ref])).outcome,
        ).toBe("committed");
      const query = { scopeKey: f.input.scopeKey, generation: f.input.generation, docIds: [f.ids[0]] };
      expect((await f.store.readLiveTextCoverage(query)).size).toBe(1);
      expect((await commit(mode === "delta" ? 3 : 4, [dependency])).outcome).toBe("committed");
      const loaded = await loadCommittedDoc(f.store, f.ids[2]);
      try {
        expect(records<{ kind: string }>(loaded!.doc)!.get(1).kind).toBe("object_part");
      } finally {
        loaded!.doc.destroy();
      }
      expect((await f.store.readLiveTextCoverage(query)).size).toBe(0);
    } finally {
      base.destroy();
      pendingSource.destroy();
      textSource.destroy();
      f.store.dispose();
    }
  });
}

// 恢复边界不能信任调用方提供的空 filter，首次通用变更必须从真实 Doc 重建身份上界。
test("伪造 recordId filter 的恢复快照不能隐藏同名替换", async () => {
  const f = await indexedFixture();
  try {
    const snapshot = f.store.exportCommittedState();
    for (const doc of snapshot.docs)
      Object.assign(doc, {
        contentUsage: {
          recordCountUpper: 0,
          maxPayloadBytes: 0,
          hasLiveText: false,
          recordIdFilter: EMPTY_RECORD_ID_FILTER,
        },
      });
    f.store.restoreFromCommittedState(snapshot);
    const lease = await f.store.acquireWriter(f.input.scopeKey, f.input.owner, 1000);
    f.input.epoch = lease.epoch;
    const query = { scopeKey: f.input.scopeKey, generation: f.input.generation, docIds: [f.ids[0]] };
    expect((await f.store.readLiveTextCoverage(query)).size).toBe(1);
    expect((await append(f, 2, await shadow(f))).outcome).toBe("committed");
    expect((await f.store.readLiveTextCoverage(query)).size).toBe(0);
    expect(f.store.exportCommittedState().docs.every((doc) => !("contentUsage" in doc))).toBe(true);
  } finally {
    f.store.dispose();
  }
});

// 新 filter 与版本必须同事务取得额度，元数据拒绝不能改变旧身份排除证明或预算。
test("shadow 的新 filter 元数据拒绝完整回滚且可重试", async () => {
  const f = await indexedFixture();
  try {
    const update = await shadow(f),
      before = f.store.exportCommittedState(),
      usage = f.usage();
    f.admission.remaining = 1;
    await expect(append(f, 2, update)).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    f.admission.remaining = null;
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
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
    expect((await append(f, 2, update)).outcome).toBe("committed");
  } finally {
    f.store.dispose();
  }
});

// 最后额度申请重入写入同一 Doc 时，仅内层提交可见，外层的 filter 和 coverage 版本都须撤销。
test("shadow 准备重入后完整保留内层提交并拒绝旧前像", async () => {
  const f = await indexedFixture(),
    loaded = await loadCommittedDoc(f.store, f.ids[2]);
  let nested: ReturnType<typeof f.store.appendUpdates> | undefined;
  let expected: ReturnType<typeof f.store.exportCommittedState> | undefined, usage: number[] | undefined;
  try {
    const update = await shadow(f),
      inner = captureChange(loaded!.doc, () =>
        records(loaded!.doc, [{ recordId: "independent-inner", kind: "tool_boundary", payload: new Uint8Array([2]) }]),
      )!;
    f.admission.beforeReserve = (pool) => {
      if (pool !== "controlIndex") return;
      f.admission.beforeReserve = null;
      nested = f.store.appendUpdates({
        ...f.input,
        batchId: "inner",
        digest: "inner",
        refs: [],
        expectedFrontiers: [{ docId: f.ids[2], lastSeq: 1 }],
        updates: [{ docId: f.ids[2], fromSeq: 2, bytes: inner }],
      });
      expected = f.store.exportCommittedState();
      usage = f.usage();
    };
    await expect(append(f, 2, update)).rejects.toMatchObject({ code: "SEQUENCE_GAP" });
    expect((await nested)?.outcome).toBe("committed");
    expect(expected).toBeDefined();
    if (!expected || !usage) throw new Error("nested commit checkpoint missing");
    expect(f.store.exportCommittedState()).toEqual(expected);
    expect(f.usage()).toEqual(usage);
  } finally {
    loaded!.doc.destroy();
    f.store.dispose();
  }
});
