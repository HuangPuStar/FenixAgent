import { expect, test } from "bun:test";
import { LIVE_WRITER_LEASE_TTL_MS } from "../sync/live/live-writer";
import { SyncProtocolError } from "../sync/protocol/errors";
import { scopeKey } from "../sync/protocol/identity";
import {
  authorityFixture,
  gate,
  rejection,
  replaceGeneration,
  text,
  withinDeadline,
} from "./sync-live-writer-authority-fixture";

// 已接纳但未冲刷的用户消息被另一 owner 提交后，同代接管必须核对 canonical 并退休原窗口。
test("同代接管判重其他 owner 已提交的保留幂等输入", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const replacement = f.makeWriter();
  try {
    const before = await f.store.readScopePointer(scopeKey(f.scope));
    await f.writer.accept(text("same-user-message"));
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await replacement.acquire();
    await replacement.accept(text("same-user-message"));
    await replacement.close();
    const committed = f.store.exportCommittedState();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual([
      "same-user-message",
    ]);
    await f.writer.acquire();
    expect((await f.store.readScopePointer(scopeKey(f.scope)))?.currentGeneration).toBe(before?.currentGeneration);
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual([
      "same-user-message",
    ]);
    expect(f.store.exportCommittedState().updates).toEqual(committed.updates);
    expect(f.store.exportCommittedState().refs).toEqual(committed.refs);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    await replacement.close();
    await f.close();
  }
});

// 另一 owner 只取得写权而未提交消息，不足以退休旧 owner 已接纳的正文。
test("同代接管仍重放其他 owner 没有提交的保留幂等输入", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const replacement = f.makeWriter();
  try {
    await f.writer.accept(text("not-committed"));
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await replacement.acquire();
    await replacement.close();
    expect(await f.readAll()).toEqual([]);
    await f.writer.acquire();
    await f.writer.accept(text("not-committed"));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["not-committed"]);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    await replacement.close();
    await f.close();
  }
});

// 模式不是文本身份，混用同一个 MergeKey 也不能把合法非幂等后继随用户消息一起判重丢弃。
test("同 key 的幂等窗口和非幂等后继在恢复时分别结清", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const replacement = f.makeWriter();
  const commit = f.store.commitContentBatch.bind(f.store);
  let refused = false;
  f.store.commitContentBatch = async (input) => {
    if (!refused) {
      refused = true;
      throw new SyncProtocolError("ADMISSION_REJECTED", { message: "old owner first flush refused" });
    }
    return await commit(input);
  };
  try {
    await f.writer.accept(text("message"));
    const switched = await rejection(f.writer.accept({ ...text("message"), delta: "tail", idempotent: false }));
    expect(switched).toHaveProperty("code", "ADMISSION_REJECTED");
    expect(refused).toBe(true);
    f.store.commitContentBatch = commit;
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await replacement.acquire();
    await replacement.accept(text("message"));
    await replacement.close();
    await f.writer.acquire();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["message", "tail"]);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    f.store.commitContentBatch = commit;
    await replacement.close();
    await f.close();
  }
});

// 已封口消息须重新读取 canonical；读取未结清或失败时旧正文仍归原窗口所有，不能靠空读猜作已提交。
test("恢复 canonical 读取失败不释放保留正文并允许下一次明确接管重试", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const replacement = f.makeWriter();
  const read = f.store.readDocStateAt.bind(f.store);
  const unavailable = new Error("canonical temporarily unavailable");
  const paused = gate();
  let acquiring: Promise<unknown> | undefined;
  try {
    await f.writer.accept(text("sealed-user-message"));
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await replacement.acquire();
    await replacement.accept(text("sealed-user-message"));
    await replacement.seal();
    await replacement.close();
    const committed = f.store.exportCommittedState();
    const originalDoc = committed.refs[0]!.docId;
    f.store.readDocStateAt = async (...args) => {
      if (args[0] === originalDoc) {
        paused.enter();
        await paused.released;
        throw unavailable;
      }
      return await read(...args);
    };
    acquiring = rejection(f.writer.acquire());
    await withinDeadline(paused.entered);
    const retainedBytes = f.admission.used("ingressSpool");
    expect(retainedBytes).toBeGreaterThan(0);
    paused.release();
    expect(await acquiring).toBe(unavailable);
    expect(f.admission.used("ingressSpool")).toBe(retainedBytes);
    expect(f.store.exportCommittedState().updates).toEqual(committed.updates);
    f.store.readDocStateAt = read;
    await f.writer.acquire();
    expect(f.store.exportCommittedState().updates).toEqual(committed.updates);
    expect(f.store.exportCommittedState().refs).toEqual(committed.refs);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    paused.release();
    if (acquiring) await acquiring;
    f.store.readDocStateAt = read;
    await replacement.close();
    await f.close();
  }
});

// 新幂等输入额度拒绝不能被同身份的非幂等缓冲冒充接纳，也不能留下会误确认重发的 claim。
test("非幂等缓冲后的幂等输入拒绝只释放本次声明", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  let hold: ReturnType<typeof f.admission.reserve> | undefined;
  try {
    await f.writer.accept({ ...text("shared"), delta: "stream", idempotent: false });
    const retainedBytes = f.admission.used("ingressSpool");
    hold = f.admission.reserve("ingressSpool", f.admission.available("ingressSpool"));
    await expect(f.writer.accept(text("shared"))).rejects.toHaveProperty("code", "ADMISSION_REJECTED");
    hold.release();
    expect(f.admission.used("ingressSpool")).toBe(retainedBytes);
    await f.writer.accept(text("shared"));
    await f.writer.close();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["stream", "shared"]);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    hold?.release();
    await f.close();
  }
});

// 相同正文的非幂等窗口属于独立输入，另一 owner 已提交同身份不能成为跳过它们的依据。
test("同代重获写权仍逐条写入非幂等相同正文", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const replacement = f.makeWriter();
  try {
    await f.writer.accept({ ...text("same"), idempotent: false });
    await f.writer.accept({ ...text("same"), idempotent: false });
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await replacement.acquire();
    await replacement.accept(text("same"));
    await replacement.close();
    await f.writer.acquire();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["same", "samesame"]);
  } finally {
    await replacement.close();
    await f.close();
  }
});

// 新 owner 正式换代后，旧窗口属于退休投影，不能参与新代次的声明读取或重放。
test("其他 owner 换代后旧幂等窗口退休且不跨代重放", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const replacement = f.makeWriter();
  const acquire = f.store.acquireWriter.bind(f.store);
  let replace = true;
  try {
    await f.writer.accept(text("old-generation"));
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    f.store.acquireWriter = async (...args) => {
      const lease = await acquire(...args);
      if (replace) {
        replace = false;
        await replaceGeneration(f, lease);
      }
      return lease;
    };
    await replacement.acquire();
    await replacement.accept(text("new-generation"));
    await replacement.close();
    await f.writer.acquire();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["new-generation"]);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    f.store.acquireWriter = acquire;
    await replacement.close();
    await f.close();
  }
});

// canonical 命中仍需当前写权确认；确认失败不得先释放已接纳正文，重获写权后再安全退休。
test("恢复判重在 confirm 失权时保留窗口及原错直到下一次接管", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const replacement = f.makeWriter();
  const confirm = f.store.confirmWriter.bind(f.store);
  const paused = gate();
  let acquiring: Promise<unknown> | undefined;
  try {
    await f.writer.accept(text("same-user-message"));
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await replacement.acquire();
    await replacement.accept(text("same-user-message"));
    await replacement.close();
    const committed = f.store.exportCommittedState();
    let confirms = 0;
    f.store.confirmWriter = async (...args) => {
      if (++confirms === 2) {
        paused.enter();
        await paused.released;
      }
      return await confirm(...args);
    };
    acquiring = rejection(f.writer.acquire());
    await withinDeadline(paused.entered);
    expect(f.admission.used("ingressSpool")).toBeGreaterThan(0);
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    paused.release();
    const failure = await acquiring;
    expect(failure).toHaveProperty("code", "LEASE_EXPIRED");
    expect(f.admission.used("ingressSpool")).toBeGreaterThan(0);
    expect(f.store.exportCommittedState().updates).toEqual(committed.updates);
    f.store.confirmWriter = confirm;
    await f.writer.acquire();
    expect(f.store.exportCommittedState().updates).toEqual(committed.updates);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    paused.release();
    if (acquiring) await acquiring;
    f.store.confirmWriter = confirm;
    await replacement.close();
    await f.close();
  }
});
