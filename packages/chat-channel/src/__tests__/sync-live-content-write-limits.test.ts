import { expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { createRuntimeDoc, RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { records } from "../sync/live/writer-support";
import { contentObjectInput } from "./sync-live-admission-fixture";
import { writerFailureFixture } from "./sync-live-writer-failure-fixture";
import { semantic, textDelta } from "./sync-live-writer-fixture";

// 对象追加不能把正文写过记录硬限，到达预算后必须在旧块完整封口再写 successor。
test("实时对象与文本共用正文记录硬限并可持续轮换", async () => {
  const f = await writerFailureFixture({
    capacity: { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRecordsPerDoc: 1 } },
  });
  try {
    for (const value of ["first", "second", "third"]) await f.writer.accept(contentObjectInput(value));
    const docs = f.store.exportCommittedState().docs.filter((doc) => doc.kind === "content");
    expect(docs.length).toBe(3);
    for (const row of docs) {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, row.baseSnapshot);
        for (const update of await f.store.readUpdatesAfter(row.docId, row.baseSeq, 32))
          Y.applyUpdate(doc, update.bytes);
        expect(records(doc)?.length).toBe(1);
      } finally {
        doc.destroy();
      }
    }
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual([
      '{"value":"first"}',
      '{"value":"second"}',
      '{"value":"third"}',
    ]);
  } finally {
    await f.close();
  }
});

// 文本与对象走不同路径，混合追加也必须在每块一条记录的边界轮换且保持回放顺序。
test("对象文本对象在共享记录硬限处均轮换", async () => {
  const f = await writerFailureFixture({
    capacity: { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRecordsPerDoc: 1 } },
  });
  try {
    await f.writer.accept(contentObjectInput("first"));
    await f.writer.accept(textDelta("text", "middle"));
    await f.writer.accept(contentObjectInput("last"));
    const docs = f.store.exportCommittedState().docs.filter((doc) => doc.kind === "content");
    expect(docs).toHaveLength(3);
    for (const row of docs) {
      const committed = await loadCommittedDoc(f.store, row.docId);
      if (!committed) throw new Error("missing content block");
      try {
        expect(records(committed.doc)?.length).toBe(1);
      } finally {
        committed.doc.destroy();
      }
    }
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual([
      '{"value":"first"}',
      "middle",
      '{"value":"last"}',
    ]);
  } finally {
    await f.close();
  }
});

// final 描述符可容纳在新块时应先轮换，描述符和 runtime 移除仍由同一 append 提交。
test("满内容块的 final 描述符轮换后与实体移除原子提交", async () => {
  const f = await writerFailureFixture({
    capacity: { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRecordsPerDoc: 1 } },
  });
  const append = f.store.appendUpdates.bind(f.store);
  let finalBatch: Parameters<typeof append>[0] | undefined;
  f.store.appendUpdates = async (input) => {
    if (input.updates.some((update) => update.docId === f.runtimeId) && input.updates.length > 1) finalBatch = input;
    return await append(input);
  };
  try {
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    await f.writer.accept(textDelta("message", "text"));
    await f.writer.accept(
      semantic("final", {
        entityId: "tool",
        finalDescriptor: { kind: "tool", contentRef: "existing", digest: "digest", byteLength: 0, completedAt: 1000 },
      }),
    );
    const contentDocs = f.store.exportCommittedState().docs.filter((doc) => doc.kind === "content");
    expect(contentDocs).toHaveLength(2);
    expect((await f.readAll()).map((record) => record.kind)).toEqual(["text", "final"]);
    const successor = contentDocs.find((doc) => doc.blockIndex === 1);
    expect(successor).toBeDefined();
    expect(finalBatch?.updates.map((update) => update.docId).sort()).toEqual([successor!.docId, f.runtimeId].sort());
    const runtime = await loadCommittedDoc(f.store, f.runtimeId);
    if (!runtime) throw new Error("missing runtime");
    try {
      expect(createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, runtime.doc).exportForRotation()).toEqual([]);
    } finally {
      runtime.doc.destroy();
    }
  } finally {
    await f.close();
  }
});

// 同一终态交接的两条记录不能分开提交，容量不足时应完整拒绝而不丢失旧 runtime 状态。
test("终态交接超过记录硬限时正文与运行态均零发布", async () => {
  const f = await writerFailureFixture({
    maxTransactions: 1,
    capacity: { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRecordsPerDoc: 1 } },
  });
  try {
    await f.writer.accept({
      kind: "semantic",
      turnId: "turn",
      entryId: "assistant",
      contentSlot: "tool",
      contentType: "tool",
      semantic: { kind: "tool", payload: { entityId: "tool", metadata: { name: "example" } } },
    });
    const before = f.store.exportCommittedState();
    await expect(
      f.writer.accept({
        kind: "semantic",
        turnId: "turn",
        entryId: "assistant",
        contentSlot: "tool",
        contentType: "tool",
        semantic: { kind: "tool", payload: { entityId: "tool", terminal: true } },
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(f.store.exportCommittedState()).toEqual(before);
  } finally {
    await f.close();
  }
});
