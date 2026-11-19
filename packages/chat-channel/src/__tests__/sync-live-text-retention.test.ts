import { expect, test } from "bun:test";
import { SyncProtocolError } from "../sync/protocol/errors";
import { authorityFixture, gate, rejection, text, withinDeadline } from "./sync-live-writer-authority-fixture";
import { semantic } from "./sync-live-writer-fixture";

// 首个输入已经确认接纳后，重发仍须等待其 timer 冲刷的真实结果，不能只以租约有效背书。
test("已接纳消息的同键重发等待 timer 冲刷并传播同一次拒绝", async () => {
  const f = await authorityFixture({ maxDelayMs: 1, maxBytes: 1 << 20 });
  const paused = gate();
  const commit = f.store.commitContentBatch.bind(f.store);
  const failure = new SyncProtocolError("ADMISSION_REJECTED", { message: "timer quota refused" });
  let armed = true;
  f.store.commitContentBatch = async (input) => {
    if (armed) {
      paused.enter();
      await paused.released;
      throw failure;
    }
    return await commit(input);
  };
  let duplicate: Promise<unknown> | undefined;
  try {
    await f.writer.accept(text("message"));
    await withinDeadline(paused.entered);
    let settled = false;
    duplicate = rejection(f.writer.accept(text("message"))).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    paused.release();
    expect(await duplicate).toMatchObject({ code: "ADMISSION_REJECTED", cause: failure });
    expect(await f.readAll()).toEqual([]);
    armed = false;
    await f.writer.accept(text("message"));
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["message"]);
  } finally {
    armed = false;
    paused.release();
    if (duplicate) await duplicate;
    await f.close();
  }
});

// 新 key 的接纳额度失败不能销毁已经确认的旧 key 缓冲；下一次显式屏障负责把保留正文恰好写一次。
test("key 切换时索引额度拒绝仍保留已确认旧正文", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  let hold: ReturnType<typeof f.admission.reserve> | undefined;
  try {
    await f.writer.accept({ ...text("A"), idempotent: false });
    const before = f.store.exportCommittedState();
    hold = f.admission.reserve("controlIndex", f.admission.available("controlIndex"));
    await expect(f.writer.accept({ ...text("B"), idempotent: false })).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    expect(f.store.exportCommittedState()).toEqual(before);
    hold.release();
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["A"]);
    await f.writer.accept({ ...text("B"), idempotent: false });
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["A", "B"]);
  } finally {
    hold?.release();
    await f.close();
  }
});

for (const chunks of [
  ["prefix", "later"],
  ["same", "same"],
]) {
  // 同 merge key 的非幂等 chunk 是独立输入；前批拒绝时后批不能清拒绝，也不能错误去重相同正文。
  test(`后继 chunk 不能越过拒绝的精确 flush：${chunks.join("/")}`, async () => {
    const f = await authorityFixture();
    const paused = gate();
    const commit = f.store.commitContentBatch.bind(f.store);
    const failure = new SyncProtocolError("ADMISSION_REJECTED", { message: "first attempt refused" });
    let first = true;
    f.store.commitContentBatch = async (input) => {
      if (first) {
        first = false;
        paused.enter();
        await paused.released;
        throw failure;
      }
      return await commit(input);
    };
    const delta = (value: string) => ({ ...text("shared"), delta: value, idempotent: false });
    const before = f.store.exportCommittedState();
    const initial = rejection(f.writer.accept(delta(chunks[0]!)));
    let later: Promise<unknown> | undefined;
    try {
      await withinDeadline(paused.entered);
      later = rejection(f.writer.accept(delta(chunks[1]!)));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      paused.release();
      expect(await initial).toMatchObject({ code: "ADMISSION_REJECTED", cause: failure });
      expect(await later).toMatchObject({ code: "ADMISSION_REJECTED" });
      expect(f.store.exportCommittedState()).toEqual(before);
      await f.writer.accept(semantic("tool", { entityId: "tool" }));
      expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(chunks);
      await f.writer.accept(semantic("tool", { entityId: "tool" }));
      expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(chunks);
    } finally {
      paused.release();
      await initial;
      if (later) await later;
      await f.close();
    }
  });
}

// Store 明确 epoch 失权后必须同步关本地输入门，不能继续确认新小文本已被接纳。
test("重复确认返回 WRITER_EPOCH_LOST 后关闭对应 token 的输入门", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  try {
    await f.writer.accept(text("committed"));
    await f.writer.seal();
    const lost = new SyncProtocolError("WRITER_EPOCH_LOST", { message: "confirmation fenced" });
    f.store.confirmWriter = () => Promise.reject(lost);
    expect(await rejection(f.writer.accept(text("committed")))).toBe(lost);
    const before = f.store.exportCommittedState();
    await expect(f.writer.accept({ ...text("new"), idempotent: false })).rejects.toMatchObject({
      code: "WRITER_EPOCH_LOST",
    });
    expect(f.store.exportCommittedState()).toEqual(before);
  } finally {
    await f.close();
  }
});
