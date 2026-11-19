import { expect, test } from "bun:test";
import { SyncProtocolError } from "../sync/protocol/errors";
import { authorityFixture, gate, rejection, text, withinDeadline } from "./sync-live-writer-authority-fixture";
import { semantic } from "./sync-live-writer-fixture";

// 构造只装配依赖，满池错误必须在首条输入的接纳边界可观察且不留下 Store 状态。
test("满索引池不阻止构造且首条文本拒绝保持零发布", async () => {
  const f = await authorityFixture();
  const hold = f.admission.reserve("controlIndex", f.admission.available("controlIndex"));
  const unopened = f.makeWriter();
  try {
    const before = f.store.exportCommittedState();
    const usage = f.admission.used("controlIndex");
    await expect(f.writer.accept({ ...text("A"), idempotent: false })).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.admission.used("controlIndex")).toBe(usage);
  } finally {
    await unopened.close();
    hold.release();
    await f.close();
  }
});

// 已保留的原窗口重试不再申请第二份正文额度，池被其它输入占满也不会形成自有额度死锁。
test("精确窗口重试复用原正文保留额度", async () => {
  const f = await authorityFixture();
  const commit = f.store.commitContentBatch.bind(f.store);
  let first = true;
  f.store.commitContentBatch = async (input) => {
    if (first) {
      first = false;
      throw new SyncProtocolError("ADMISSION_REJECTED", { message: "first refused" });
    }
    return await commit(input);
  };
  let hold: ReturnType<typeof f.admission.reserve> | undefined;
  try {
    await expect(f.writer.accept(text("retained"))).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    expect(f.admission.used("ingressSpool")).toBeGreaterThan(0);
    hold = f.admission.reserve("ingressSpool", f.admission.available("ingressSpool"));
    await f.writer.accept(text("retained"));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["retained"]);
    expect(f.admission.available("ingressSpool")).toBeGreaterThan(0);
  } finally {
    hold?.release();
    await f.close();
  }
  expect(f.admission.used("ingressSpool")).toBe(0);
});

// 前一窗口成功只能释放自己的正文，仍在 Store 等待的后继窗口必须继续持有独立保留额度。
test("前窗口成功后后继在途窗口仍持有正文额度", async () => {
  const f = await authorityFixture();
  const firstGate = gate(),
    secondGate = gate();
  const commit = f.store.commitContentBatch.bind(f.store);
  let calls = 0;
  f.store.commitContentBatch = async (input) => {
    const pause = ++calls === 1 ? firstGate : secondGate;
    pause.enter();
    await pause.released;
    return await commit(input);
  };
  const head = rejection(f.writer.accept({ ...text("ordered"), delta: "head", idempotent: false }));
  let tail: Promise<unknown> | undefined;
  try {
    await withinDeadline(firstGate.entered);
    tail = rejection(f.writer.accept({ ...text("ordered"), delta: "tail", idempotent: false }));
    const both = f.admission.used("ingressSpool");
    firstGate.release();
    expect(await head).toBeUndefined();
    await withinDeadline(secondGate.entered);
    expect(f.admission.used("ingressSpool")).toBeGreaterThan(0);
    expect(f.admission.used("ingressSpool")).toBeLessThan(both);
    secondGate.release();
    expect(await tail).toBeUndefined();
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    firstGate.release();
    secondGate.release();
    await head;
    if (tail) await tail;
    await f.close();
  }
});

// 首错前已接纳的多个 key 都属于保留队列，后继不能越过拒绝；显式屏障按原顺序重试全部输入。
test("多个已排队 key 的拒绝保留原文并依次恢复", async () => {
  const f = await authorityFixture();
  const paused = gate();
  const commit = f.store.commitContentBatch.bind(f.store);
  let first = true;
  f.store.commitContentBatch = async (input) => {
    if (first) {
      first = false;
      paused.enter();
      await paused.released;
    }
    return await commit(input);
  };
  let hold: ReturnType<typeof f.admission.reserve> | undefined;
  const pending: Promise<unknown>[] = [];
  try {
    pending.push(rejection(f.writer.accept(text("A"))));
    await withinDeadline(paused.entered);
    pending.push(rejection(f.writer.accept(text("B"))));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
    paused.release();
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ code: "ADMISSION_REJECTED" });
    expect(await f.readAll()).toEqual([]);
    hold.release();
    await f.writer.accept(text("A"));
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    await f.writer.accept(text("B"));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["A", "B"]);
  } finally {
    paused.release();
    hold?.release();
    await Promise.all(pending);
    await f.close();
  }
  expect(f.admission.used("controlIndex")).toBe(0);
});

// timer 不能因后续索引预算不足丢掉已确认缓冲，恢复预算后用原窗口重试，不要求上游重发非幂等 chunk。
test("timer 确定拒绝后显式屏障恢复保留正文且完整释放", async () => {
  const f = await authorityFixture({ maxDelayMs: 1, maxBytes: 1 << 20 });
  let hold: ReturnType<typeof f.admission.reserve> | undefined;
  try {
    await f.writer.accept({ ...text("A"), idempotent: false });
    hold = f.admission.reserve("controlIndex", f.admission.available("controlIndex"));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await expect(f.writer.accept(semantic("tool", { entityId: "tool" }))).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    await expect(f.writer.accept({ ...text("B"), idempotent: false })).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    hold.release();
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["A"]);
  } finally {
    hold?.release();
    await f.close();
  }
  expect(f.admission.used("controlIndex")).toBe(0);
});

// 关闭不能先释放租约来制造正文失权，实际提交结清后才归还保留预算，迟到回执不能复活已退休队列。
test("关闭等待在途 flush 的成功并完整释放正文额度", async () => {
  const f = await authorityFixture();
  const paused = gate();
  const commit = f.store.commitContentBatch.bind(f.store);
  f.store.commitContentBatch = async (input) => {
    paused.enter();
    await paused.released;
    return await commit(input);
  };
  const accepted = rejection(f.writer.accept(text("A")));
  let closing: Promise<unknown> | undefined;
  try {
    await withinDeadline(paused.entered);
    closing = rejection(f.writer.close());
    expect(f.admission.used("ingressSpool")).toBeGreaterThan(0);
    paused.release();
    expect(await accepted).toBeUndefined();
    expect(await closing).toBeUndefined();
    expect(f.admission.used("ingressSpool")).toBe(0);
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["A"]);
  } finally {
    paused.release();
    await accepted;
    if (closing) await closing;
    await f.close();
  }
  expect(f.admission.used("controlIndex")).toBe(0);
});
