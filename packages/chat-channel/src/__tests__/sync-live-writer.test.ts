// 合并、历史幂等、写权生命周期、目录和工具边界的真实存储回归。
import { describe, expect, test } from "bun:test";
import { LIVE_WRITER_LEASE_TTL_MS } from "../sync/live/live-writer";
import {
  DIRECTORY_PAGE_SIZE,
  directoryPageDocId,
  readDirectoryPage,
  readDirectoryRoot,
} from "../sync/protocol/directory";
import {
  committed,
  createRuntime,
  docIdFor,
  docOf,
  GENERATION,
  historyRecord,
  LIVE_TAIL_ID,
  makeStore,
  newWriter,
  type Runtime,
  readEntities,
  readRecords,
  rebuild,
  SCOPE_KEY,
  seed,
  semantic,
  setup,
  setupWithHistory,
  testTime,
  textDelta,
  textOf,
  updatesOf,
  userInput,
} from "./sync-live-writer-fixture";

// 同键同窗口的增量必须合并成一条正文记录，并且在语义事件推进之前完成提交。
test("同键增量合并为一条记录，语义屏障先冲刷再推进", async () => {
  const fix = await setup();
  await fix.writer.accept(textDelta("entry-1", "he"));
  await fix.writer.accept(textDelta("entry-1", "llo"));
  await fix.writer.accept(textDelta("entry-1", "!"));
  expect(updatesOf(fix, fix.contentId)).toHaveLength(0);
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  expect(readRecords(fix, fix.contentId).map(textOf)).toEqual(["hello!"]);
  expect(updatesOf(fix, fix.contentId)).toHaveLength(1);
  expect(updatesOf(fix, fix.runtimeId)).toHaveLength(1);
  await fix.writer.close();
});

// 历史已含该用户消息（旧协议数字槽位 0）时，同轮 attach 补水不得再写一条；屏障确保补水真的走到写者。
test("历史已含用户消息时同轮补水只保留一条", async () => {
  const fix = await setupWithHistory([historyRecord("turn-pending:user", "pending question")]);
  await fix.writer.accept(userInput("turn-pending", "pending question"));
  await fix.writer.accept(semantic("tool", { entityId: "barrier-tool" }));

  const historyTexts = readRecords(fix, fix.contentId).filter((record) => record.entryId === "turn-pending:user");
  const liveTexts = readRecords(fix, LIVE_TAIL_ID).filter((record) => record.entryId === "turn-pending:user");
  expect(historyTexts).toHaveLength(1);
  expect(liveTexts).toHaveLength(0);
  await fix.writer.close();
});

// 相同文本的两次合法提问属于不同轮次：判重按 entryId 而不是正文，两条都必须保留。
test("不同轮次的相同文本各保留一条", async () => {
  const fix = await setup();
  await fix.writer.accept(userInput("turn-a", "same question"));
  await fix.writer.accept(userInput("turn-b", "same question"));
  await fix.writer.accept(semantic("tool", { entityId: "barrier-tool" }));

  const texts = readRecords(fix, fix.contentId)
    .filter((record) => record.kind === "text" && record.entryId.endsWith(":user"))
    .map(textOf);
  expect(texts).toEqual(["same question", "same question"]);
  await fix.writer.close();
});

// claim 只读取当前代次入口闭包：闭包之外的旧块（等价于已退役/不可达）不能把新消息误判成已存在。
test("claim 不读取入口闭包之外的内容块", async () => {
  const fix = await setupWithHistory(
    [historyRecord("turn-committed:user", "committed history")],
    [historyRecord("turn-orphan:user", "orphan text")],
  );
  await fix.writer.accept(userInput("turn-orphan", "orphan text"));
  await fix.writer.accept(semantic("tool", { entityId: "barrier-tool" }));

  const liveTexts = readRecords(fix, LIVE_TAIL_ID)
    .filter((record) => record.entryId === "turn-orphan:user")
    .map(textOf);
  expect(liveTexts).toEqual(["orphan text"]);
  await fix.writer.close();
});

// 换消息或跨语义屏障的正文属于不同片段：合并它们会把两段内容拼到一起，读者无法再分开。
test("键切换与语义屏障隔离正文，前后不跨屏障合并", async () => {
  const fix = await setup();
  await fix.writer.accept(textDelta("entry-1", "a"));
  await fix.writer.accept(textDelta("entry-2", "b"));
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  await fix.writer.accept(textDelta("entry-1", "c"));
  await fix.writer.accept(semantic("error", { entityId: "err-1" }));
  const records = readRecords(fix, fix.contentId).map((record) => [record.entryId, textOf(record), record.partIndex]);
  expect(records).toEqual([
    ["entry-1", "a", 0],
    ["entry-2", "b", 0],
    ["entry-1", "c", 1],
  ]);
  await fix.writer.close();
});

// 拿不到写权就不能写：租约被他人持有时 acquire 直接拒绝（SCOPE_BUSY），本层不排队等待。
test("租约被占时 acquire 拒绝，未持写权的写入一律失败", async () => {
  const runtime = createRuntime();
  await seed(runtime);
  const held = await runtime.store.acquireWriter(SCOPE_KEY, "other-writer", 60_000);
  expect(held.owner).toBe("other-writer");
  const writer = newWriter(runtime);
  await expect(writer.acquire()).rejects.toMatchObject({ code: "SCOPE_BUSY" });
  await expect(writer.accept(textDelta("entry-1", "a"))).rejects.toMatchObject({ code: "WRITER_EPOCH_LOST" });
  await writer.close();
});

// 租约过期后旧 epoch 的写入被拒：fencing 由存储判定，写者随即停写，后续输入不再落库。
test("租约过期后旧 epoch 写入被拒并停写", async () => {
  const fix = await setup();
  await fix.writer.accept(textDelta("entry-1", "before"));
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  fix.time.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
  const expired = async () => {
    await fix.writer.accept(textDelta("entry-1", "after"));
    await fix.writer.accept(semantic("error", { entityId: "err-1" }));
  };
  await expect(expired()).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
  await expect(fix.writer.accept(textDelta("entry-1", "later"))).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
  expect(readRecords(fix, fix.contentId).map(textOf)).toEqual(["before"]);
  await fix.writer.close();
});

// 轮换产出 (oldDocId, newDocId, requiredBaseSeq)：旧版封口后不再接受写入，未结束实体必须被搬运到新块。
test("rotateRuntime 返回旧新文档与基线序号，旧版停止写入", async () => {
  const fix = await setup();
  await fix.writer.accept(semantic("tool", { entityId: "tool-1", metadata: { title: "read" } }));
  const rotated = await fix.writer.rotateRuntime();
  expect(rotated.oldDocId).toBe(fix.runtimeId);
  expect(rotated.newDocId).not.toBe(fix.runtimeId);
  expect(rotated.requiredBaseSeq).toBe(0);
  expect(docOf(fix, fix.runtimeId)?.state).toBe("sealed");
  expect(docOf(fix, rotated.newDocId)?.state).toBe("active");
  expect(readEntities(fix, rotated.newDocId).map((entity) => entity.entityId)).toEqual(["tool-1"]);
  const sealedUpdates = updatesOf(fix, fix.runtimeId).length;
  await fix.writer.accept(semantic("error", { entityId: "err-1" }));
  expect(updatesOf(fix, fix.runtimeId)).toHaveLength(sealedUpdates);
  expect(readEntities(fix, rotated.newDocId).map((entity) => entity.entityId)).toEqual(["tool-1", "err-1"]);
  await fix.writer.close();
});

// 内容块轮换必须同步维护目录：新块追加到最新页，否则客户端永远发现不了轮换后的 live 内容。
test("内容块轮换后把 successor 追加到目录页", async () => {
  const fix = await setup();
  await fix.writer.accept(textDelta("entry-1", "hello"));
  await fix.writer.seal();

  const contentDocs = committed(fix).docs.filter((doc) => doc.kind === "content");
  const successor = contentDocs.find((doc) => doc.state === "active");
  if (successor === undefined) throw new Error("expected an active successor content doc");
  expect(contentDocs).toHaveLength(2);

  const rootDoc = rebuild(fix, docIdFor("directory", 0, "directory"));
  const { latestPageId } = readDirectoryRoot(rootDoc);
  expect(latestPageId).toBe(directoryPageDocId(GENERATION, 1));
  if (latestPageId === null) throw new Error("expected latest directory page");

  const pageDoc = rebuild(fix, latestPageId);
  expect(readDirectoryPage(pageDoc).contentDocIds).toEqual([fix.contentId, successor.docId]);
  await fix.writer.close();
});

// 页满后必须滚动到新页：旧页保持固定条数，新页链接旧页，根目录原子切到新页。
test("目录页满后轮换到新页并保留上一页链接", async () => {
  const fix = await setup();
  // 初始页已有入口块，再追加 DIRECTORY_PAGE_SIZE 个 successor 触发一次轮换。
  for (let index = 0; index < DIRECTORY_PAGE_SIZE; index += 1) {
    await fix.writer.seal();
  }

  const rootDoc = rebuild(fix, docIdFor("directory", 0, "directory"));
  const { latestPageId } = readDirectoryRoot(rootDoc);
  expect(latestPageId).toBe(directoryPageDocId(GENERATION, 2));
  if (latestPageId === null) throw new Error("expected rotated directory page");

  const firstPage = readDirectoryPage(rebuild(fix, directoryPageDocId(GENERATION, 1)));
  expect(firstPage.contentDocIds).toHaveLength(DIRECTORY_PAGE_SIZE);
  expect(firstPage.previousPageId).toBeNull();

  const secondPage = readDirectoryPage(rebuild(fix, latestPageId));
  expect(secondPage.contentDocIds).toHaveLength(1);
  expect(secondPage.previousPageId).toBe(directoryPageDocId(GENERATION, 1));
  await fix.writer.close();
});

// 崩溃后只能依赖已提交边界：新写者从 canonical + 连续 tail 重建，接着旧文档与旧片段序号继续写。
test("recover 从已提交 canonical + 连续 tail 重建", async () => {
  const first = await setup({ seed: "writer-before-crash" });
  await first.writer.accept(textDelta("entry-1", "hello"));
  await first.writer.accept(semantic("tool", { entityId: "tool-1" }));
  await first.writer.close();
  // 快照里只有已提交字节：旧写者的内存游标与未提交输入都不参与恢复。
  const snapshot = first.store.exportCommittedState();
  const time = testTime(1_000);
  const restored = makeStore(time.clock);
  restored.restoreFromCommittedState(snapshot);
  const runtime: Runtime = {
    store: restored,
    time,
    capacity: first.capacity,
    runtimeId: first.runtimeId,
    contentId: first.contentId,
  };
  const second = newWriter(runtime, { seed: "writer-after-crash" });
  await second.acquire();
  await second.recover();
  await second.accept(textDelta("entry-1", " world"));
  await second.accept(semantic("error", { entityId: "err-1" }));
  const records = readRecords(runtime, runtime.contentId);
  expect(records.map((record) => [textOf(record), record.partIndex])).toEqual([
    ["hello", 0],
    [" world", 1],
  ]);
  expect(updatesOf(runtime, runtime.contentId).map((update) => update.updateSeq)).toEqual([1, 2]);
  await second.close();
});

describe("有序工具边界标记", () => {
  // 终态首帧（started 自带 completed）也必须在文本 cursor 处写边界；重放只保留一条。
  test("终态首帧写边界且重放不重复", async () => {
    const fixture = await setup();
    const terminal = {
      ...semantic("tool", {
        entityId: "t1",
        toolCallId: "t1",
        boundary: true,
        terminal: true,
        metadata: { status: "completed" },
      }),
      entryId: "turn-1:assistant",
    };
    await fixture.writer.accept(terminal);
    await fixture.writer.accept(terminal);
    const records = readRecords(fixture, fixture.contentId);
    expect(records.filter((record) => record.kind === "tool_boundary")).toHaveLength(1);
    expect(records.map((record) => record.kind).slice(0, 3)).toEqual(["tool_boundary", "final", "final"]);
    await fixture.writer.close();
  });

  // 去重身份是 (entryId, toolCallId)：不同 entry 复用同名工具各写一条边界。
  test("不同 entry 的同名 toolCallId 各写一条边界", async () => {
    const fixture = await setup();
    const start = semantic("tool", {
      entityId: "t1",
      toolCallId: "t1",
      boundary: true,
      metadata: { title: "Read" },
    });
    await fixture.writer.accept({ ...start, entryId: "entry-1" });
    await fixture.writer.accept({ ...start, entryId: "entry-2" });
    const boundaries = readRecords(fixture, fixture.contentId).filter((record) => record.kind === "tool_boundary");
    expect(boundaries.map((record) => record.entryId)).toEqual(["entry-1", "entry-2"]);
    expect(boundaries.map((record) => JSON.parse(textOf(record)).ordinal)).toEqual([0, 0]);
    await fixture.writer.close();
  });

  // 工具开始时在文本 cursor 位置写边界记录；同一 toolCallId 的重放不得产生第二条。
  test("工具开始写入边界记录，重复重放不重复", async () => {
    const fixture = await setup();
    const toolStart = {
      ...semantic("tool", { entityId: "t1", toolCallId: "t1", boundary: true, metadata: { title: "Read" } }),
      entryId: "turn-1:assistant",
    };
    await fixture.writer.accept(textDelta("turn-1:assistant", "A"));
    await fixture.writer.accept(toolStart);
    await fixture.writer.accept(textDelta("turn-1:assistant", "B"));
    await fixture.writer.accept(toolStart);
    const records = readRecords(fixture, fixture.contentId);
    expect(records.map((record) => record.kind)).toEqual(["text", "tool_boundary", "text"]);
    const boundary = records.find((record) => record.kind === "tool_boundary");
    expect(JSON.parse(textOf(boundary!))).toEqual({ toolCallId: "t1", ordinal: 0 });
    await fixture.writer.close();
  });
});

// 权威对象提交完成的回执必须覆盖全部分片，跨 live 封口轮换也保留身份及修订。
test("完整工具对象跨 live 块提交后才能确认成功", async () => {
  const fix = await setup();
  const value = { result: "天气😀".repeat(40000) };
  await fix.writer.accept({
    kind: "content-object",
    turnId: "source",
    entryId: "callback_tool",
    contentSlot: "object",
    contentType: "application/json",
    object: {
      value,
      meta: { kind: "tool_object", entryId: "callback_tool", role: "assistant", entryOrder: 3, sourceRevision: 7 },
    },
  });
  const contentDocs = committed(fix)
    .docs.filter(
      (doc) => doc.kind === "content" && readRecords(fix, doc.docId).some((record) => record.kind === "tool_object"),
    )
    .sort((left, right) => (left.blockIndex ?? 0) - (right.blockIndex ?? 0));
  expect(contentDocs.length).toBeGreaterThan(1);
  const records = contentDocs
    .flatMap((doc) => readRecords(fix, doc.docId))
    .filter((record) => record.kind === "tool_object");
  expect(records.length).toBeGreaterThan(1);
  expect(
    records.every(
      (record) => record.entryId === "callback_tool" && record.sourceRevision === 7 && record.entryOrder === 3,
    ),
  ).toBe(true);
  const parts = records.map((record) => JSON.parse(textOf(record)));
  expect(parts.map((part) => part.partIndex)).toEqual(Array.from({ length: parts.length }, (_, index) => index));
  expect(JSON.parse(Buffer.concat(parts.map((part) => Buffer.from(part.data, "base64"))).toString("utf8"))).toEqual(
    value,
  );
  await fix.writer.close();
});
