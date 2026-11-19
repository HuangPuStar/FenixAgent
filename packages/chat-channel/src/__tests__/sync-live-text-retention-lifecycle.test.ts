import { expect, test } from "bun:test";
import { SyncProtocolError } from "../sync/protocol/errors";
import {
  authorityFixture,
  gate,
  rejection,
  replaceGeneration,
  text,
  withinDeadline,
} from "./sync-live-writer-authority-fixture";
import { semantic } from "./sync-live-writer-fixture";

// 同代重建不能把首个 accept 已经确认的缓冲当作可丢弃内容，重建后应完整提交一次。
test("同代 recover 保留已确认的缓冲且幂等重发只写一次", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  try {
    await f.writer.accept(text("buffered"));
    expect(f.admission.used("ingressSpool")).toBeGreaterThan(0);
    await f.writer.recover();
    await f.writer.accept(text("buffered"));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["buffered"]);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    await f.close();
  }
});

// 明确未写的拒绝可在新 token 下重放原窗口，重放不是新输入，不能追加第二份相同文本。
test("同代 acquire 在确定未写拒绝后以新 token 重放原窗口", async () => {
  const f = await authorityFixture();
  const commit = f.store.commitContentBatch.bind(f.store);
  const refusal = new SyncProtocolError("ADMISSION_REJECTED", { message: "original attempt refused" });
  let first = true;
  f.store.commitContentBatch = async (input) => {
    if (first) {
      first = false;
      throw refusal;
    }
    return await commit(input);
  };
  try {
    expect(await rejection(f.writer.accept(text("retained")))).toMatchObject({
      code: "ADMISSION_REJECTED",
      cause: refusal,
    });
    const before = await f.store.readScopePointer(`${f.scope.organizationId}/${f.scope.rcsSessionId}`);
    await f.writer.acquire();
    await f.writer.accept(text("retained"));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["retained"]);
    expect((await f.store.readScopePointer(before!.scopeKey))?.writerOwner).toBe(before?.writerOwner);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    await f.close();
  }
});

// 外部已正式换代时旧缓冲属于退休投影，不得带着旧 generation 的正文进入新代次。
test("真正换代只退休旧缓冲并释放预算而不跨代重放", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const acquire = f.store.acquireWriter.bind(f.store);
  f.store.acquireWriter = async (...args) => {
    const lease = await acquire(...args);
    await replaceGeneration(f, lease);
    return lease;
  };
  try {
    await f.writer.accept(text("old-generation"));
    await f.writer.acquire();
    expect(await f.readAll()).toEqual([]);
    expect(f.admission.used("ingressSpool")).toBe(0);
    await f.writer.accept(text("new-generation"));
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["new-generation"]);
  } finally {
    await f.close();
  }
});

// 关闭本身也是显式屏障；首个 accept 返回过的缓冲必须在释放写权前持久化。
test("close 在释放写权前结清已确认缓冲", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  try {
    await f.writer.accept(text("before-close"));
    await f.writer.close();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["before-close"]);
    expect(f.admission.used("ingressSpool")).toBe(0);
    await expect(f.writer.accept(text("late"))).rejects.toMatchObject({ code: "RESOURCE_RETIRED" });
  } finally {
    await f.close();
  }
});

// 关闭等待同一个实际冲刷回执，拒绝后必须把原错传给 close 和 accept，并完整释放自己保留的预算。
test("close 等待在途正文并传播同一拒绝且同步拒绝新输入", async () => {
  const f = await authorityFixture();
  const paused = gate();
  const refusal = new SyncProtocolError("ADMISSION_REJECTED", { message: "close flush refused" });
  f.store.commitContentBatch = async () => {
    paused.enter();
    await paused.released;
    throw refusal;
  };
  const accepted = rejection(f.writer.accept(text("pending")));
  let closing: Promise<unknown> | undefined;
  try {
    await withinDeadline(paused.entered);
    let settled = false;
    closing = rejection(f.writer.close()).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    await expect(f.writer.accept(semantic("tool", { entityId: "late" }))).rejects.toMatchObject({
      code: "RESOURCE_RETIRED",
    });
    paused.release();
    const original = await accepted;
    expect(original).toMatchObject({ code: "ADMISSION_REJECTED", cause: refusal });
    expect(await closing).toBe(original);
    expect(await f.readAll()).toEqual([]);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    paused.release();
    await accepted;
    if (closing) await closing;
    await f.close();
  }
});

// 结果未知的窗口没有未写证明，close 与 acquire 都只能保留原错误，不能把正文再提交一次。
test("unknown 窗口在 close 和 acquire 时不擅自重放", async () => {
  const f = await authorityFixture();
  const commit = f.store.commitContentBatch.bind(f.store);
  const read = f.store.readUpdatesAfter.bind(f.store);
  const unavailable = new Error("confirmation unavailable");
  let probing = false,
    commits = 0;
  f.store.commitContentBatch = async (input) => {
    commits++;
    const result = await commit(input);
    expect(result.outcome).toBe("committed");
    probing = true;
    return { outcome: "unknown", frontiers: [] };
  };
  f.store.readUpdatesAfter = (...args) => (probing ? Promise.reject(unavailable) : read(...args));
  let original: unknown;
  try {
    original = await rejection(f.writer.accept(text("uncertain")));
    expect(original).toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN", cause: unavailable });
    expect(await rejection(f.writer.acquire())).toBe(original);
    expect(await rejection(f.writer.close())).toBe(original);
    expect(commits).toBe(1);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    probing = false;
    await f.close();
  }
});

// flush 失败后 release 的第二个异常只能补充诊断，不能把尚未持久化正文的原始失败掩盖掉。
test("close 同时遇到冲刷拒绝与释放异常时保留原拒绝及诊断", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const refusal = new SyncProtocolError("ADMISSION_REJECTED", { message: "flush refused" });
  const releaseError = new Error("lease release receipt unavailable");
  const release = f.store.releaseWriter.bind(f.store);
  f.store.commitContentBatch = () => Promise.reject(refusal);
  f.store.releaseWriter = async (lease) => {
    await release(lease);
    throw releaseError;
  };
  try {
    await f.writer.accept(text("retained"));
    const error = await rejection(f.writer.close());
    expect(error).toHaveProperty("code", "ADMISSION_REJECTED");
    if (!(error instanceof Error) || !(error.cause instanceof AggregateError))
      throw new Error("missing close diagnostics");
    expect(error.cause.errors).toContain(refusal);
    expect(error.cause.errors).toContain(releaseError);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    f.store.releaseWriter = release;
    await f.close();
  }
});
