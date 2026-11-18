import { expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { records } from "../sync/live/writer-support";
import { contentObjectInput } from "./sync-live-admission-fixture";
import { writerFailureFixture } from "./sync-live-writer-failure-fixture";

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

// 同一终态交接的两条记录不能分开提交，容量不足时应完整拒绝而不丢失旧 runtime 状态。
test("终态交接超过记录硬限时正文与运行态均零发布", async () => {
  const f = await writerFailureFixture({
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
