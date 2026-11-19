import { expect, test } from "bun:test";
import { authorityFixture, rejection, text } from "./sync-live-writer-authority-fixture";

// 空增量不占用户消息身份；随后相同身份的真实正文仍须恰好提交一次。
test("空幂等增量不抢占随后非空消息的身份", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  try {
    const before = f.store.exportCommittedState();
    await f.writer.accept({ ...text("empty-first"), delta: "" });
    await f.writer.accept({ ...text("empty-first"), delta: "" });
    expect(f.store.exportCommittedState()).toEqual(before);
    await f.writer.accept(text("empty-first"));
    await f.writer.close();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["empty-first"]);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    await f.close();
  }
});

// 同代重建已保留确定未写窗口，额度恢复后的首次重发就应重试原窗口，不能先返回旧拒绝。
test("同代 recover 容量拒绝后首次幂等重发直接重试保留窗口", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  let hold: ReturnType<typeof f.admission.reserve> | undefined;
  try {
    await f.writer.accept(text("retained"));
    hold = f.admission.reserve("persistSeal", f.admission.available("persistSeal"));
    await expect(f.writer.recover()).rejects.toHaveProperty("code", "ADMISSION_REJECTED");
    expect(await f.readAll()).toEqual([]);
    hold.release();
    expect(await rejection(f.writer.accept(text("retained")))).toBeUndefined();
    await f.writer.close();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["retained"]);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    hold?.release();
    await f.close();
  }
});

// 注入的只读 Store 可冻结自己的方法；重判转发仍须保留原 receiver 且不违反 Proxy 不变量。
test("冻结 Store 的保留文本重判使用原方法 receiver", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  await f.writer.close();
  let generations = 0;
  let coverage = 0;
  const frozen = Object.create(f.store) as typeof f.store;
  Object.defineProperties(frozen, {
    readGeneration: {
      value: function (...args: Parameters<typeof f.store.readGeneration>) {
        expect(this).toBe(frozen);
        generations++;
        return f.store.readGeneration(...args);
      },
    },
    readLiveTextCoverage: {
      value: function (...args: Parameters<typeof f.store.readLiveTextCoverage>) {
        expect(this).toBe(frozen);
        coverage++;
        return f.store.readLiveTextCoverage(...args);
      },
    },
  });
  Object.freeze(frozen);
  const writer = f.makeWriter(frozen);
  try {
    await writer.acquire();
    await writer.seal();
    await writer.accept(text("frozen"));
    generations = 0;
    coverage = 0;
    const replay = await rejection(writer.recover());
    const closed = await rejection(writer.close());
    expect(replay).toBeUndefined();
    expect(closed).toBeUndefined();
    expect(generations).toBeGreaterThan(0);
    expect(coverage).toBeGreaterThan(0);
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["frozen"]);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    await writer.close();
    await f.close();
  }
});
