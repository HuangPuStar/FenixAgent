import { expect, test } from "bun:test";
import type { LiveRecordValue } from "../sync/live/live-writer-types";
import { records } from "../sync/live/writer-support";
import { SyncProtocolError } from "../sync/protocol/errors";
import { gate, rejection, replaceGeneration, withinDeadline } from "./sync-live-writer-authority-fixture";
import { sealingClaimFixture } from "./sync-text-claim-sealing-fixture";

// 真实换代及宽限期清理可让tail空页，已锁定final2时不得消费只到seq1的正文。
test("sealing 尾读期间真实退休删除不能把截断正文交给消费回调", async () => {
  const f = await sealingClaimFixture(),
    paused = gate();
  const read = f.store.readUpdatesAfter.bind(f.store);
  f.store.readUpdatesAfter = async (...args) => {
    if (args[0] === f.contentId && args[1] === 1) {
      paused.enter();
      await paused.released;
    }
    return read(...args);
  };
  let consumed = false;
  const pending = rejection(
    f.readClaim(() => {
      consumed = true;
    }),
  );
  try {
    await withinDeadline(paused.entered);
    await replaceGeneration(f, f.lease);
    f.advance(101);
    const collected = await f.store.retireAndCollect(f.key, { kind: "generation", generation: f.generation });
    expect(collected.outcome).toBe("committed");
    expect(collected.deletedDocIds).toContain(f.contentId);
    const expected = f.usageWithoutReader();
    paused.release();
    expect(await pending).toMatchObject({ code: "SEQUENCE_GAP" });
    expect(consumed).toBe(false);
    expect(f.usage()).toEqual(expected);
  } finally {
    paused.release();
    await pending;
    await f.close();
  }
});

for (const count of [0, 2]) {
  // seq0也是合法固定终点，完整连续tail则只在确实到达锁定前沿后消费一次。
  test(`sealing 固定 finalSeq=${count} 完整到达时可消费并归还临时额度`, async () => {
    const f = await sealingClaimFixture(count),
      before = f.usage();
    try {
      expect(
        await f.readClaim((doc, seq) => ({
          seq,
          entries:
            records<LiveRecordValue>(doc)
              ?.toArray()
              .map((value) => value.entryId) ?? [],
        })),
      ).toEqual({ seq: count, entries: Array.from({ length: count }, (_, index) => `entry-${index}`) });
      expect(f.usage()).toEqual(before);
    } finally {
      await f.close();
    }
  });
}

// 没有固定终点的旧适配仍沿用连续tail规则，不把null解释成seq0。
test("sealing 没有固定 finalSeq 时保留原连续读取语义", async () => {
  const f = await sealingClaimFixture(),
    metadata = f.store.readSuccessor.bind(f.store),
    before = f.usage();
  f.store.readSuccessor = async (...args) => {
    const state = await metadata(...args);
    return state && { ...state, finalSeq: null };
  };
  try {
    expect(await f.readClaim((_doc, seq) => seq)).toBe(2);
    expect(f.usage()).toEqual(before);
  } finally {
    await f.close();
  }
});

for (const fault of ["tail", "reset"] as const) {
  // 尾页依赖异常与reset均先于最终消费判定，不能被缺尾错误替换且必须归还临时正文。
  test(`sealing ${fault} 失败保留原始错误并完整归还额度`, async () => {
    const f = await sealingClaimFixture(),
      paused = gate(),
      read = f.store.readUpdatesAfter.bind(f.store);
    const failure =
      fault === "tail"
        ? new Error("sealing tail unavailable")
        : new SyncProtocolError("GENERATION_MISMATCH", { message: "claim reset" });
    const before = f.usage();
    let current = true,
      consumed = false;
    f.store.readUpdatesAfter = async (...args) => {
      if (args[1] === 1) {
        paused.enter();
        await paused.released;
        if (fault === "tail") throw failure;
      }
      return read(...args);
    };
    const pending = rejection(
      f.readClaim(
        () => {
          consumed = true;
        },
        () => {
          if (!current) throw failure;
        },
      ),
    );
    try {
      await withinDeadline(paused.entered);
      if (fault === "reset") current = false;
      paused.release();
      expect(await pending).toBe(failure);
      expect(consumed).toBe(false);
      expect(f.usage()).toEqual(before);
    } finally {
      paused.release();
      await pending;
      await f.close();
    }
  });
}
