import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import type { CommitContentBatchInput } from "../sync/store/types";
import { contentBatchFixture } from "./sync-store-content-batch-fixture";

const cases: { name: string; code: string; change: (input: CommitContentBatchInput) => CommitContentBatchInput }[] = [
  { name: "错误 owner", code: "WRITER_EPOCH_LOST", change: (input) => ({ ...input, owner: "other" }) },
  { name: "错误 epoch", code: "WRITER_EPOCH_LOST", change: (input) => ({ ...input, epoch: input.epoch + 1 }) },
  { name: "错误 generation", code: "GENERATION_MISMATCH", change: (input) => ({ ...input, generation: "other" }) },
  {
    name: "旧 Doc 前沿",
    code: "SEQUENCE_GAP",
    change: (input) => ({
      ...input,
      expectedFrontiers: input.expectedFrontiers.map((item, index) => (index === 0 ? { ...item, lastSeq: 1 } : item)),
    }),
  },
  {
    name: "封口终点超前",
    code: "SEQUENCE_GAP",
    change: (input) => ({
      ...input,
      seals: input.seals.map((item, index) => (index === 0 ? { ...item, finalSeq: 2 } : item)),
    }),
  },
  {
    name: "封口丢失前沿",
    code: "SEQUENCE_GAP",
    change: (input) => ({
      ...input,
      updates: input.updates.slice(1),
      expectedFrontiers: input.expectedFrontiers.slice(1),
      seals: input.seals.map((item, index) =>
        index === 0
          ? {
              ...item,
              finalSeq: 0,
              finalSnapshot: new Uint8Array([0, 0]),
              finalHash: sha256Digest(new Uint8Array([0, 0])),
            }
          : item,
      ),
    }),
  },
  {
    name: "错误封口摘要",
    code: "DIGEST_CONFLICT",
    change: (input) => ({
      ...input,
      seals: input.seals.map((item, index) => (index === 0 ? { ...item, finalHash: "other" } : item)),
    }),
  },
  {
    name: "新块索引失配",
    code: "MALFORMED_FRAME",
    change: (input) => ({
      ...input,
      newDocs: input.newDocs.map((item, index) => (index === 0 ? { ...item, blockIndex: 9 } : item)),
    }),
  },
  {
    name: "重复新块",
    code: "MALFORMED_FRAME",
    change: (input) => ({ ...input, newDocs: [...input.newDocs, input.newDocs[0]] }),
  },
];
for (const item of cases) {
  // 任何计划校验失败都保留完整写前像与额度，禁止先写入合法前缀再报错。
  test(`原子文本批次拒绝${item.name}且零发布`, async () => {
    const f = await contentBatchFixture();
    try {
      const before = f.store.exportCommittedState();
      const usage = f.usage();
      await expect(f.store.commitContentBatch(item.change(f.input))).rejects.toMatchObject({ code: item.code });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(f.usage()).toEqual(usage);
    } finally {
      f.store.dispose();
    }
  });
}

// 首片已无法放入旧尾块时，旧块以原前沿封口，整批仍只有新块和目录的真实更新。
test("原子文本批次允许零更新的旧尾块封口", async () => {
  const f = await contentBatchFixture();
  try {
    f.input.updates = f.input.updates.filter((item) => item.docId !== f.ids[0]);
    f.input.seals[0] = {
      ...f.input.seals[0],
      finalSeq: 0,
      finalSnapshot: new Uint8Array([0, 0]),
      finalHash: sha256Digest(new Uint8Array([0, 0])),
    };
    const result = await f.store.commitContentBatch(f.input);
    expect(result.outcome).toBe("committed");
    expect(result.frontiers).toContainEqual({ docId: f.ids[0], lastSeq: 0 });
    expect(await f.store.readUpdatesAfter(f.ids[0], 0, 4)).toHaveLength(0);
    expect(await f.store.readSuccessor(f.input.scopeKey, f.ids[0])).toMatchObject({
      state: "sealed",
      route: { successorDocId: f.ids[1], expectedLastSeq: 0 },
    });
  } finally {
    f.store.dispose();
  }
});

// 单 Doc 记录预算不能误用于整条链的更新数，否则合法大文本会被新接口错误拒绝。
test("原子文本批次按每块限制记录数而不限制整批更新数", async () => {
  const f = await contentBatchFixture({
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, maxRecordsPerDoc: 2 },
  });
  try {
    expect(f.input.updates.length).toBeGreaterThan(2);
    expect((await f.store.commitContentBatch(f.input)).outcome).toBe("committed");
  } finally {
    f.store.dispose();
  }
});
