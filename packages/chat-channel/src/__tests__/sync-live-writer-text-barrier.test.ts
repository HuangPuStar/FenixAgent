import { expect, test } from "bun:test";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { WriterTextBarrier } from "../sync/live/writer-text-barrier";
import { authorityFixture, gate, rejection, text, withinDeadline } from "./sync-live-writer-authority-fixture";
import { semantic } from "./sync-live-writer-fixture";

// 构造只装配依赖，满池错误必须在首条输入的接纳边界可观察且不留下 Store 状态。
test("满索引池不阻止构造且首条文本拒绝保持零发布", async () => {
  const f = await authorityFixture();
  const hold = f.admission.reserve("controlIndex", f.admission.available("controlIndex"));
  const barrier = new WriterTextBarrier(f.admission);
  try {
    const before = f.store.exportCommittedState();
    const usage = f.admission.used("controlIndex");
    await expect(f.writer.accept({ ...text("A"), idempotent: false })).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.admission.used("controlIndex")).toBe(usage);
  } finally {
    barrier.close();
    hold.release();
    await f.close();
  }
});

// 自己保留的拒绝占满索引时，匹配重试应复用占用，不能要求先有额外空闲才允许释放旧占用。
test("匹配重试复用拒绝索引额度避免自身占用造成死锁", async () => {
  const admission = new AdmissionController({
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: { ...DEFAULT_SYNC_CAPACITY.serverPools, controlIndex: 512 },
  });
  const barrier = new WriterTextBarrier(admission);
  const refused = new Error("definite refusal");
  barrier.refuse("key", refused, barrier.reserve());
  try {
    expect(admission.available("controlIndex")).toBe(0);
    await barrier.enqueue({
      key: "key",
      enqueue: (task) => Promise.resolve().then(task),
      write: async () => barrier.confirm("key"),
      isCurrent: () => true,
      onSchedulingRefusal: () => {},
      onFailure: () => {},
    });
    barrier.assertReady();
    expect(admission.used("controlIndex")).toBe(256);
  } finally {
    barrier.close();
  }
  expect(admission.used("controlIndex")).toBe(0);
});

// 同 key 的第一个成功只清拒绝，不得提前归还仍在队列中等待执行的另一个重试的占用。
test("匹配重试成功后后继排队任务仍持有索引额度", async () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const barrier = new WriterTextBarrier(admission);
  barrier.refuse("key", new Error("first"), barrier.reserve());
  barrier.refuse("key", new Error("second"), barrier.reserve());
  const paused = gate();
  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    const pending = queue.then(task);
    queue = pending;
    return pending;
  };
  const common = { key: "key", enqueue, isCurrent: () => true, onSchedulingRefusal: () => {}, onFailure: () => {} };
  const first = barrier.enqueue({ ...common, write: async () => barrier.confirm("key") });
  const second = barrier.enqueue({
    ...common,
    write: async () => {
      paused.enter();
      await paused.released;
      barrier.confirm("key");
    },
  });
  try {
    await first;
    await withinDeadline(paused.entered);
    expect(admission.used("controlIndex")).toBe(512);
    paused.release();
    await second;
    expect(admission.used("controlIndex")).toBe(256);
  } finally {
    paused.release();
    await Promise.allSettled([first, second]);
    barrier.close();
  }
  expect(admission.used("controlIndex")).toBe(0);
});

// 首错前已排队的多个 key 均要独立保留拒绝，重试一个不能替另一个打开语义门禁。
test("多个已排队文本的拒绝必须逐 key 重试确认", async () => {
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
    await expect(f.writer.accept(semantic("tool", { entityId: "tool" }))).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    await f.writer.accept(text("B"));
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["A", "B"]);
  } finally {
    paused.release();
    hold?.release();
    await Promise.all(pending);
    await f.close();
  }
  expect(f.admission.used("controlIndex")).toBe(0);
});

// timer 取走已接纳文本后索引额度耗尽，也必须返回可重试拒绝并保留一次固定大小的应急记录。
test("timer 的拒绝索引额度耗尽后可匹配重试且完整释放", async () => {
  const f = await authorityFixture({ maxDelayMs: 1, maxBytes: 1 << 20 });
  let hold: ReturnType<typeof f.admission.reserve> | undefined;
  try {
    await f.writer.accept({ ...text("A"), idempotent: false });
    hold = f.admission.reserve("controlIndex", f.admission.available("controlIndex"));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await expect(f.writer.accept(semantic("tool", { entityId: "tool" }))).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    hold.release();
    await expect(f.writer.accept({ ...text("B"), idempotent: false })).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    await f.writer.accept({ ...text("A"), idempotent: false });
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["A"]);
  } finally {
    hold?.release();
    await f.close();
  }
  expect(f.admission.used("controlIndex")).toBe(0);
});

// close 已清占用后到达的旧 flush 拒绝不能重新安装拒绝状态或重新占用索引额度。
test("关闭先释放在途 flush 索引且迟到拒绝不再占用", async () => {
  const f = await authorityFixture();
  const paused = gate();
  const commit = f.store.commitContentBatch.bind(f.store);
  f.store.commitContentBatch = async (input) => {
    paused.enter();
    await paused.released;
    return await commit(input);
  };
  const accepted = rejection(f.writer.accept(text("A")));
  try {
    await withinDeadline(paused.entered);
    await f.writer.close();
    const afterClose = f.admission.used("controlIndex");
    paused.release();
    expect(await accepted).toMatchObject({ code: "WRITER_EPOCH_LOST" });
    expect(f.admission.used("controlIndex")).toBe(afterClose);
  } finally {
    paused.release();
    await accepted;
    await f.close();
  }
  expect(f.admission.used("controlIndex")).toBe(0);
});
