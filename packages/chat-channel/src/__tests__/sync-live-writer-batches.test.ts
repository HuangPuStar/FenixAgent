// 固定批次、结果未知、原子分片和顺序提交的真实存储回归。
import { expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import type { LiveRecordValue } from "../sync/live/live-writer";
import type {
  AppendUpdatesInput,
  AppendUpdatesResult,
  CommitContentBatchInput,
  ProjectionStore,
} from "../sync/store/types";
import {
  cappedCapacity,
  docOf,
  emptyState,
  readRecords,
  semantic,
  setup,
  textDelta,
  textOf,
  updatesOf,
} from "./sync-live-writer-fixture";

const UTF8 = new TextEncoder();

/** 把存储换成"只改回执/计数"的委托代理：除指定方法外一律转交真实实现。 */
function wrapStore(
  target: ProjectionStore,
  handler: (
    input: AppendUpdatesInput,
    commit: (input: AppendUpdatesInput) => Promise<AppendUpdatesResult>,
  ) => Promise<AppendUpdatesResult>,
) {
  return new Proxy(target, {
    get(source, property, receiver) {
      const value: unknown = Reflect.get(source, property, receiver);
      if (property === "appendUpdates")
        return (input: AppendUpdatesInput) => handler(input, (replacement) => target.appendUpdates(replacement));
      if (property === "commitContentBatch")
        return (input: CommitContentBatchInput) =>
          handler(input, (replacement) => target.commitContentBatch({ ...input, ...replacement }));
      return value;
    },
  }) as ProjectionStore;
}

/** 只统计并发度：提交前后各留一次事件循环，未串行的批次会在这里暴露重叠。 */
function countingStore(
  target: ProjectionStore,
  counters: { inFlight: number; maxInFlight: number; calls: number },
  first?: { entered: () => void; released: Promise<void> },
) {
  return wrapStore(target, async (input, commit) => {
    counters.calls += 1;
    counters.inFlight += 1;
    counters.maxInFlight = Math.max(counters.maxInFlight, counters.inFlight);
    if (counters.calls === 1 && first) {
      first.entered();
      await first.released;
    }
    try {
      return await commit(input);
    } finally {
      counters.inFlight -= 1;
    }
  });
}

/** 先真实提交再报「未知」：模拟写入已落库但回执丢失。 */
function unknownAfterWrite(target: ProjectionStore, counters: { calls: number }, docId: string) {
  return wrapStore(target, async (input, commit) => {
    if (input.updates[0].docId !== docId) return await commit(input);
    counters.calls += 1;
    if (counters.calls > 1) return await commit(input);
    await commit(input);
    return { outcome: "unknown", frontiers: [] };
  });
}

/** 第一次提交直接答「未知」且不落库：确定未提交的重放场景。 */
function unknownWithoutWrite(target: ProjectionStore, seen: AppendUpdatesInput[]) {
  let attempts = 0;
  return wrapStore(target, async (input, commit) => {
    attempts += 1;
    seen.push(structuredClone(input));
    if (attempts > 1) return await commit(input);
    return { outcome: "unknown", frontiers: [] };
  });
}

/** 用异摘要真实落库再答「未知」：同幂等键下已存在别人的字节，写者必须停写。 */
function unknownWithOtherDigest(target: ProjectionStore) {
  let attempts = 0;
  return wrapStore(target, async (input, commit) => {
    attempts += 1;
    if (attempts > 1) return await commit(input);
    await commit({ ...input, digest: `${input.digest}:other` });
    return { outcome: "unknown", frontiers: [] };
  });
}

// `commit(pending)` 的 batchId、序号区间、摘要与字节由调用方固定：必须原样落到已提交记录上。
test("commit 按公开字段固定批次并写入存储", async () => {
  const fix = await setup();
  const payload = recordUpdate(fix.contentId, "direct");
  const batchId = "batch-direct";
  const digest = sha256Digest(payload);
  const outcome = await fix.writer.commit({
    batchId,
    docId: fix.contentId,
    ordinalStart: 1,
    ordinalEnd: 1,
    digest,
    payload,
  });
  expect(outcome).toBe("committed");
  const [update] = updatesOf(fix, fix.contentId);
  expect([update.batchId, update.updateSeq, update.digest]).toEqual([batchId, 1, digest]);
  expect(readRecords(fix, fix.contentId).map(textOf)).toEqual(["direct"]);
  await fix.writer.close();
});

// 摘要是幂等键的一半：字节与摘要不符、序号与前沿不连续、区间长度不为 1 都必须在落库前拒绝。
test("commit 拒绝异摘要、不连续序号与多片区间", async () => {
  const fix = await setup();
  const payload = recordUpdate(fix.contentId, "direct");
  const digest = sha256Digest(payload);
  const batchId = "batch-reject";
  const base = { batchId, docId: fix.contentId, ordinalStart: 1, ordinalEnd: 1, payload };
  await expect(fix.writer.commit({ ...base, digest: "not-the-digest" })).rejects.toMatchObject({
    code: "DIGEST_CONFLICT",
  });
  await expect(fix.writer.commit({ ...base, ordinalStart: 2, ordinalEnd: 2, digest })).rejects.toMatchObject({
    code: "SEQUENCE_GAP",
  });
  await expect(fix.writer.commit({ ...base, ordinalEnd: 2, digest })).rejects.toMatchObject({
    code: "MALFORMED_FRAME",
  });
  expect(updatesOf(fix, fix.contentId)).toHaveLength(0);
  await fix.writer.close();
});

// 每 scope 最多一个未决批次：并发接收的写入必须串行提交，任何时刻都不得有两个批次同时在飞。
test("并发写入串行提交，任一时刻只有一个未决批次", async () => {
  const counters = { inFlight: 0, maxInFlight: 0, calls: 0 };
  let enter = () => {},
    release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fix = await setup({ wrap: (runtime) => countingStore(runtime.store, counters, { entered: enter, released }) });
  const pending: Promise<unknown>[] = [];
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await fix.writer.accept(textDelta("entry-1", "a"));
    const writing = fix.writer.accept(textDelta("entry-2", "b"));
    pending.push(writing);
    const failed = writing.then(() => new Promise<never>(() => {}));
    void failed.catch(() => {});
    await Promise.race([
      entered,
      failed,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("first commit did not reach its gate")), 1000);
      }),
    ]);
    pending.push(fix.writer.accept(semantic("tool", { entityId: "tool-1" })));
    await Promise.resolve();
    expect(counters.calls).toBe(1);
    expect(counters.inFlight).toBe(1);
    release();
    await Promise.all(pending);
    expect(counters.maxInFlight).toBe(1);
    expect(counters.calls).toBe(3);
    expect(readRecords(fix, fix.contentId).map((record) => [record.entryId, textOf(record)])).toEqual([
      ["entry-1", "a"],
      ["entry-2", "b"],
    ]);
  } finally {
    clearTimeout(deadline);
    release();
    await Promise.allSettled(pending);
    await fix.writer.close();
  }
});

// 结果未知时先查询：同批同摘要已在存储里 = 成功，不得再执行一次输入（重放副作用无法回滚）。
test("unknown 且同批同摘要已存在：确认成功且不重放输入", async () => {
  const counters = { calls: 0 };
  const fix = await setup({ wrap: (runtime) => unknownAfterWrite(runtime.store, counters, runtime.contentId) });
  await fix.writer.accept(textDelta("entry-1", "hello"));
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  expect(counters.calls).toBe(1);
  expect(readRecords(fix, fix.contentId).map(textOf)).toEqual(["hello"]);
  expect(updatesOf(fix, fix.contentId)).toHaveLength(1);
  await fix.writer.close();
});

// 确定未提交且写权仍在时重放原字节：幂等键、摘要与字节必须逐字相同，重放后内容只出现一次。
test("unknown 且确定未提交：重放同一份字节直到提交", async () => {
  const seen: AppendUpdatesInput[] = [];
  const fix = await setup({ wrap: (runtime) => unknownWithoutWrite(runtime.store, seen) });
  await fix.writer.accept(textDelta("entry-1", "hello"));
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  const content = seen.filter((input) => input.updates[0].docId === fix.contentId);
  expect(content).toHaveLength(2);
  expect(content[1].batchId).toBe(content[0].batchId);
  expect(content[1].digest).toBe(content[0].digest);
  expect(content[0]).toHaveProperty("newDocs");
  expect(content[1]).toEqual(content[0]);
  expect(readRecords(fix, fix.contentId).map(textOf)).toEqual(["hello"]);
  await fix.writer.close();
});

// 异摘要意味着同幂等键下已有别人的字节：无从判定更不能覆盖，写者必须停写且不再接受任何输入。
test("unknown 且查询到异摘要：写者停写", async () => {
  const fix = await setup({ wrap: (runtime) => unknownWithOtherDigest(runtime.store) });
  const first = async () => {
    await fix.writer.accept(textDelta("entry-1", "hello"));
    await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  };
  await expect(first()).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
  await expect(fix.writer.accept(textDelta("entry-1", "later"))).rejects.toMatchObject({
    code: "COMMIT_OUTCOME_UNKNOWN",
  });
  expect(updatesOf(fix, fix.runtimeId)).toHaveLength(0);
  expect(readRecords(fix, fix.contentId).map(textOf)).toEqual(["hello"]);
  await fix.writer.close();
});

// 记录超限只拆记录；Doc 仍有空间时不得无谓封口或生成空前驱块。
test("正文按记录预算拆分且复用仍有空间的块", async () => {
  const capacity = cappedCapacity({ activeHardEncodedBytes: 4_096, payloadChunkMaxBytes: 64 });
  const counters = { inFlight: 0, maxInFlight: 0, calls: 0 };
  const fix = await setup({ capacity, wrap: (runtime) => countingStore(runtime.store, counters) });
  const text = "x".repeat(200);
  await fix.writer.accept(textDelta("entry-1", text));
  await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  expect(updatesOf(fix, fix.contentId).map((update) => update.updateSeq)).toEqual([1, 2, 3, 4]);
  expect(new Set(updatesOf(fix, fix.contentId).map((update) => update.batchId)).size).toBe(1);
  expect(docOf(fix, fix.contentId)?.state).toBe("active");
  const pieces = readRecords(fix, fix.contentId);
  expect(pieces).toHaveLength(4);
  expect(pieces.map((piece) => piece.partIndex)).toEqual([0, 1, 2, 3]);
  expect(pieces.map(textOf).join("")).toBe(text);
  for (const piece of pieces) expect(piece.payload.byteLength).toBeLessThanOrEqual(64);
  expect(counters.calls).toBe(2);
  await fix.writer.close();
});

// 重拆一次后仍超硬上限：报容量错误并停在该处，既不无限重拆，也不把超限字节留在已提交边界上。
test("重拆仍超硬上限时报容量错误且不发布", async () => {
  const capacity = cappedCapacity({ activeHardEncodedBytes: 24, payloadChunkMaxBytes: 64 });
  const fix = await setup({ capacity });
  const overflow = async () => {
    await fix.writer.accept(textDelta("entry-1", "x".repeat(32)));
    await fix.writer.accept(semantic("tool", { entityId: "tool-1" }));
  };
  await expect(overflow()).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  expect(updatesOf(fix, fix.contentId)).toHaveLength(0);
  await fix.writer.close();
});

/** 造一份与写者同构的内容块更新：一条正文记录，用于驱动 `commit(pending)` 的公开路径。 */
function recordUpdate(docId: string, text: string): Uint8Array {
  const doc = new Y.Doc({ guid: docId });
  Y.applyUpdate(doc, emptyState());
  const before = Y.encodeStateVector(doc);
  const records = new Y.Array<LiveRecordValue>();
  doc.getMap<unknown>("root").set("records", records);
  records.push([
    {
      recordId: `rec_${text}`,
      entryId: "entry-1",
      contentSlot: "text",
      contentType: "text/plain",
      partIndex: 0,
      kind: "text",
      payload: UTF8.encode(text),
    },
  ]);
  const bytes = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return bytes;
}
