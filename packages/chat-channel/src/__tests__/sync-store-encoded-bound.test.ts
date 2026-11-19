import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { TEXT_CLAIM_READ_METADATA_BYTES, TEXT_CLAIM_REPLAY_MAX_BYTES } from "../sync/capacity/text-claim-reservations";
import { sha256Digest } from "../sync/clock";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { textClaimLookupId } from "../sync/live/text-claim-identity";
import { readTextClaimDoc } from "../sync/live/text-claim-read";
import { records } from "../sync/live/writer-support";
import { SyncProtocolError } from "../sync/protocol/errors";
import { MAX_DOC_SNAPSHOT_BYTES } from "../sync/protocol/frames";
import { buildDocId } from "../sync/protocol/identity";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

// 删除 packed Item 的中段会新增多个编码头，raw 字节和不能放行超过实际硬限的正文。
test("删除 packed 记录的编码增长必须在提交前精确拒绝", async () => {
  const source = new Y.Doc();
  source.clientID = 12345;
  source.getArray("packed").push(Array(1000).fill(0));
  const initial = Y.encodeStateAsUpdate(source),
    vector = Y.encodeStateVector(source);
  source.transact(() => {
    for (let i = 999; i > 0; i -= 10) source.getArray("packed").delete(i, 1);
  });
  const deleted = Y.encodeStateAsUpdate(source, vector),
    actual = Y.encodeStateAsUpdate(source).byteLength;
  const raw = 2 + initial.byteLength + deleted.byteLength;
  expect(actual).toBeGreaterThan(raw);
  const f = await contentBatchFixture({
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, activeHardEncodedBytes: raw },
  });
  try {
    const input = {
      ...f.input,
      refs: [],
      expectedFrontiers: [{ docId: f.ids[0], lastSeq: 0 }],
      updates: [{ docId: f.ids[0], fromSeq: 1, bytes: initial }],
      batchId: "packed",
      digest: "packed",
    };
    expect((await f.store.appendUpdates(input)).outcome).toBe("committed");
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    await expect(
      f.store.appendUpdates({
        ...input,
        batchId: "delete",
        digest: "delete",
        expectedFrontiers: [{ docId: f.ids[0], lastSeq: 1 }],
        updates: [{ docId: f.ids[0], fromSeq: 2, bytes: deleted }],
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
  } finally {
    source.destroy();
    f.store.dispose();
  }
});

// 合法重复账本的累计 raw 字节不是重建驻留体积，恢复覆盖不能因此永远拒绝。
test("256 条重叠 8KiB 更新恢复后仍可证明小型 canonical", async () => {
  const f = await contentBatchFixture(),
    source = new Y.Doc();
  try {
    records(source, [{ recordId: "object", kind: "object_part", payload: new Uint8Array(8192) }]);
    const bytes = Y.encodeStateAsUpdate(source);
    for (let i = 0; i < 256; i++)
      expect(
        (
          await f.store.appendUpdates({
            ...f.input,
            batchId: `repeat-${i}`,
            digest: `repeat-${i}`,
            refs: [],
            expectedFrontiers: [{ docId: f.ids[0], lastSeq: i }],
            updates: [{ docId: f.ids[0], fromSeq: i + 1, bytes }],
          })
        ).outcome,
      ).toBe("committed");
    f.store.restoreFromCommittedState(f.store.exportCommittedState());
    expect(
      (
        await f.store.readLiveTextCoverage({
          scopeKey: f.input.scopeKey,
          generation: f.input.generation,
          docIds: [f.ids[0]],
        })
      ).has(f.ids[0]),
    ).toBe(true);
  } finally {
    source.destroy();
    f.store.dispose();
  }
});

// 同一候选中的多个索引身份应共用一次 canonical Map，不能每身份重扫整块。
test("千个身份覆盖重建只扫描候选 canonical 一次", async () => {
  const f = await contentBatchFixture(),
    source = new Y.Doc();
  try {
    const values = Array.from({ length: 1000 }, (_, i) => ({
      recordId: `r-${i}`,
      kind: "text",
      entryId: `e-${i}`,
      contentSlot: "text",
      payload: new Uint8Array([1]),
    }));
    records(source, values);
    const bytes = Y.encodeStateAsUpdate(source);
    const refs = values.map((value) => ({
      scopeKey: f.input.scopeKey,
      generation: f.input.generation,
      lookupKind: "live-text" as const,
      lookupId: textClaimLookupId(sha256Digest, {
        scopeKey: f.input.scopeKey,
        generation: f.input.generation,
        entryId: value.entryId,
        contentSlot: "text",
      }),
      contentSlot: 0,
      partIndex: 0,
      docId: f.ids[0],
      recordId: value.recordId,
      byteStart: 0,
      byteEnd: 1,
      orderStart: 0,
      orderEnd: 0,
    }));
    expect(
      (
        await f.store.appendUpdates({
          ...f.input,
          batchId: "identities",
          digest: "identities",
          expectedFrontiers: [{ docId: f.ids[0], lastSeq: 0 }],
          updates: [{ docId: f.ids[0], fromSeq: 1, bytes }],
          refs,
        })
      ).outcome,
    ).toBe("committed");
    f.store.restoreFromCommittedState(f.store.exportCommittedState());
    const scan = spyOn(Y.Array.prototype, "toArray");
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
      expect(scan.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      scan.mockRestore();
    }
  } finally {
    source.destroy();
    f.store.dispose();
  }
});

// 隐藏 parentSub 不带显式删除集，精确重建仍须撤回其它块依赖的旧文本定位证明。
test("隐藏 wrapper 替换按实际 records 对象撤回覆盖证明", async () => {
  const f = await contentBatchFixture();
  try {
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
    const loaded = await loadCommittedDoc(f.store, f.ids[2]),
      array = loaded!.doc.getMap("root").get("records");
    if (!(array instanceof Y.Array)) throw new Error("missing canonical records");
    const encoder = new Y.UpdateEncoderV1();
    encoder.writeLen(1);
    encoder.writeLen(1);
    encoder.writeClient(9007199254740000);
    encoder.writeLen(0);
    encoder.writeInfo(128 | 8);
    encoder.writeLeftID(array._item!.id);
    new Y.ContentAny(["replacement"]).write(encoder, 0);
    encoder.writeLen(0);
    const bytes = encoder.toUint8Array();
    loaded!.doc.destroy();
    expect(
      (
        await f.store.appendUpdates({
          ...f.input,
          batchId: "hidden-map",
          digest: "hidden-map",
          refs: [],
          expectedFrontiers: [{ docId: f.ids[2], lastSeq: 1 }],
          updates: [{ docId: f.ids[2], fromSeq: 2, bytes }],
        })
      ).outcome,
    ).toBe("committed");
    const covered = await f.store.readLiveTextCoverage({
      scopeKey: f.input.scopeKey,
      generation: f.input.generation,
      docIds: f.ids,
    });
    expect(covered.has(f.ids[0])).toBe(false);
    expect(covered.has(f.ids[1])).toBe(false);
  } finally {
    f.store.dispose();
  }
});

for (const kind of ["runtime", "directory"] as const) {
  // 传输硬限适用于所有 Doc，非正文也不能用 raw 总和放行实际编码膨胀。
  test(`${kind} 通用删除同样检查实际传输编码上限`, async () => {
    const f = await contentBatchFixture(),
      source = new Y.Doc();
    source.clientID = 12345;
    try {
      const id = buildDocId({ kind, generation: f.input.generation, blockIndex: 0, nonce: "transport" });
      await f.store.createDoc({
        scopeKey: f.input.scopeKey,
        epoch: f.input.epoch,
        doc: { ...f.input.newDocs[0], docId: id, kind, blockIndex: kind === "runtime" ? null : 0 },
      });
      source.getArray("packed").push(Array(90000).fill(0));
      const initial = Y.encodeStateAsUpdate(source),
        vector = Y.encodeStateVector(source);
      source.transact(() => {
        for (let i = 89999; i > 0; i -= 10) source.getArray("packed").delete(i, 1);
      });
      const deleted = Y.encodeStateAsUpdate(source, vector);
      expect(2 + initial.length + deleted.length).toBeLessThanOrEqual(MAX_DOC_SNAPSHOT_BYTES);
      expect(Y.encodeStateAsUpdate(source).length).toBeGreaterThan(MAX_DOC_SNAPSHOT_BYTES);
      const input = {
        ...f.input,
        batchId: `${kind}-base`,
        digest: `${kind}-base`,
        refs: [],
        expectedFrontiers: [{ docId: id, lastSeq: 0 }],
        updates: [{ docId: id, fromSeq: 1, bytes: initial }],
      };
      expect((await f.store.appendUpdates(input)).outcome).toBe("committed");
      const before = f.store.exportCommittedState(),
        usage = f.usage();
      await expect(
        f.store.appendUpdates({
          ...input,
          batchId: `${kind}-delete`,
          digest: `${kind}-delete`,
          expectedFrontiers: [{ docId: id, lastSeq: 1 }],
          updates: [{ docId: id, fromSeq: 2, bytes: deleted }],
        }),
      ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(f.usage()).toEqual(usage);
    } finally {
      source.destroy();
      f.store.dispose();
    }
  });
}

// 可选证明放不下时必须归还已申请额度，让单 Doc 动态 fallback 仍可读取合法小正文。
test("覆盖证明预算不足不会阻断有界正文 fallback", async () => {
  const f = await contentBatchFixture(),
    source = new Y.Doc();
  try {
    records(source, [{ recordId: "object", kind: "object_part", payload: new Uint8Array(8192) }]);
    const bytes = Y.encodeStateAsUpdate(source);
    await f.store.appendUpdates({
      ...f.input,
      batchId: "fallback-base",
      digest: "fallback-base",
      refs: [],
      expectedFrontiers: [{ docId: f.ids[0], lastSeq: 0 }],
      updates: [{ docId: f.ids[0], fromSeq: 1, bytes }],
    });
    f.store.restoreFromCommittedState(f.store.exportCommittedState());
    const blocker = f.admission.reserve("hotDocLive", 32 * 1024 * 1024),
      usage = f.usage();
    try {
      expect(
        (
          await f.store.readLiveTextCoverage({
            scopeKey: f.input.scopeKey,
            generation: f.input.generation,
            docIds: [f.ids[0]],
          })
        ).size,
      ).toBe(0);
      expect(
        await readTextClaimDoc({
          scopeKey: f.input.scopeKey,
          store: f.store,
          admission: f.admission,
          docId: f.ids[0],
          assertCurrent: () => {},
          consume: (doc) => records(doc)?.length,
        }),
      ).toBe(1);
      expect(f.usage()).toEqual(usage);
    } finally {
      blocker.release();
    }
  } finally {
    source.destroy();
    f.store.dispose();
  }
});

// 最后发布缓存也属于可选证明；临时身份已放下而缓存元数据不足时仍允许有界回放。
test("覆盖缓存发布预算不足仍可读取合法正文", async () => {
  const f = await contentBatchFixture(),
    source = new Y.Doc();
  let blocker: ReturnType<typeof f.admission.reserve> | undefined;
  try {
    records(source, [{ recordId: "tool", kind: "tool_boundary", payload: new Uint8Array([1]) }]);
    await f.store.appendUpdates({
      ...f.input,
      batchId: "optional-cache",
      digest: "optional-cache",
      refs: [],
      expectedFrontiers: [{ docId: f.ids[0], lastSeq: 0 }],
      updates: [{ docId: f.ids[0], fromSeq: 1, bytes: Y.encodeStateAsUpdate(source) }],
    });
    f.store.restoreFromCommittedState(f.store.exportCommittedState());
    const queryBytes = (256 + f.ids[0].length * 2) * 2,
      loadedMetadata = TEXT_CLAIM_READ_METADATA_BYTES + TEXT_CLAIM_REPLAY_MAX_BYTES * 16;
    blocker = f.admission.reserve(
      "controlIndex",
      DEFAULT_SYNC_CAPACITY.serverPools.controlIndex -
        f.admission.used("controlIndex") -
        queryBytes -
        loadedMetadata -
        100,
    );
    const usage = f.usage(),
      before = f.store.exportCommittedState();
    expect(
      (
        await f.store.readLiveTextCoverage({
          scopeKey: f.input.scopeKey,
          generation: f.input.generation,
          docIds: [f.ids[0]],
        })
      ).size,
    ).toBe(0);
    expect(
      await readTextClaimDoc({
        scopeKey: f.input.scopeKey,
        store: f.store,
        admission: f.admission,
        docId: f.ids[0],
        assertCurrent: () => {},
        consume: (doc) => records(doc)?.length,
      }),
    ).toBe(1);
    expect(f.usage()).toEqual(usage);
    expect(f.store.exportCommittedState()).toEqual(before);
  } finally {
    blocker?.release();
    source.destroy();
    f.store.dispose();
  }
});

// 只有本次可选 reserve 的接纳失败可以降级，业务依赖抛出的同码原错必须透传。
test("覆盖验证依赖的原始错误不被当成可选预算拒绝", async () => {
  const failure = new SyncProtocolError("ADMISSION_REJECTED", { message: "digest dependency failed" });
  let armed = false;
  const f = await contentBatchFixture(DEFAULT_SYNC_CAPACITY, {
    digest: (bytes) => {
      if (armed) throw failure;
      return sha256Digest(bytes);
    },
  });
  try {
    await f.store.commitContentBatch(f.input);
    f.store.restoreFromCommittedState(f.store.exportCommittedState());
    const before = f.store.exportCommittedState(),
      usage = f.usage();
    armed = true;
    await expect(
      f.store.readLiveTextCoverage({ scopeKey: f.input.scopeKey, generation: f.input.generation, docIds: [f.ids[0]] }),
    ).rejects.toBe(failure);
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.usage()).toEqual(usage);
  } finally {
    f.store.dispose();
  }
});
