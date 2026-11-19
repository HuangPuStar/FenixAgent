import { expect, test } from "bun:test";
import { LIVE_WRITER_LEASE_TTL_MS } from "../sync/live/live-writer";
import { SyncProtocolError } from "../sync/protocol/errors";
import { scopeKey } from "../sync/protocol/identity";
import { contentObjectInput } from "./sync-live-admission-fixture";
import {
  authorityFixture,
  gate,
  rejection,
  replaceGeneration,
  text,
  withinDeadline,
} from "./sync-live-writer-authority-fixture";
import { semantic } from "./sync-live-writer-fixture";

// 规划阶段拒绝额度已证明没有 Store 写入，同一幂等消息在额度恢复后应完整重试。
test("阈值冲刷额度拒绝后可重试同一幂等消息", async () => {
  const f = await authorityFixture();
  const hold = f.admission.reserve("persistSeal", f.admission.available("persistSeal"));
  try {
    const before = f.store.exportCommittedState();
    await expect(f.writer.accept(text())).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    hold.release();
    await f.writer.accept(text());
    await f.writer.seal();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["message"]);
  } finally {
    hold.release();
    await f.close();
  }
});

// 定时器旧任务必须先结清，不能在新租约下重新续租并重复提交已释放的幂等声明。
test("公开续租发现过期后接管等待旧定时冲刷且正文只写一次", async () => {
  const f = await authorityFixture({ maxDelayMs: 1, maxBytes: 1 << 20 });
  const paused = gate();
  let acquiring: Promise<void> | undefined;
  const read = f.store.readScopePointer.bind(f.store);
  let pause = true;
  f.store.readScopePointer = async (key) => {
    if (pause) {
      pause = false;
      paused.enter();
      await paused.released;
    }
    return read(key);
  };
  try {
    await f.writer.accept(text());
    await withinDeadline(paused.entered);
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await expect(f.writer.renew()).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    const acquire = f.store.acquireWriter.bind(f.store);
    let acquisitions = 0;
    f.store.acquireWriter = (...args) => {
      acquisitions++;
      return acquire(...args);
    };
    acquiring = f.writer.acquire();
    void acquiring.catch(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(acquisitions).toBe(0);
    paused.release();
    await acquiring;
    await f.writer.accept(text());
    await f.writer.seal();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["message"]);
  } finally {
    paused.release();
    if (acquiring) await rejection(acquiring);
    await f.close();
  }
});

// 新代次重建尚未装好时拒绝 admission，旧游标不能给新 claim 留下错误的重复占位。
test("新代次重建期间不使用旧游标接纳幂等声明", async () => {
  const f = await authorityFixture();
  const paused = gate();
  let acquiring: Promise<void> | undefined;
  try {
    await f.writer.accept(text());
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await rejection(f.writer.renew());
    const acquire = f.store.acquireWriter.bind(f.store);
    f.store.acquireWriter = async (...args) => {
      const lease = await acquire(...args);
      await replaceGeneration(f, lease);
      return lease;
    };
    const read = f.store.readScopePointer.bind(f.store);
    let pauses = 0;
    f.store.readScopePointer = async (key) => {
      const result = await read(key);
      if (++pauses === 2) {
        paused.enter();
        await paused.released;
      }
      return result;
    };
    acquiring = f.writer.acquire();
    void acquiring.catch(() => {});
    await withinDeadline(paused.entered);
    await expect(f.writer.accept(text())).rejects.toMatchObject({ code: "WRITER_EPOCH_LOST" });
    paused.release();
    await acquiring;
    await f.writer.accept(text());
    const current = f.store.exportCommittedState().updates.filter((update) => update.docId.includes("gen_replacement"));
    expect(current).toHaveLength(1);
  } finally {
    paused.release();
    if (acquiring) await rejection(acquiring);
    await f.close();
  }
});

// 接管最后一次尾读跨过 TTL 时不能报告成功，后续输入必须先重新取得真实写权。
test("重建最后一次尾读后确认捕获的租约仍有效", async () => {
  const f = await authorityFixture();
  try {
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await rejection(f.writer.renew());
    const read = f.store.readUpdatesAfter.bind(f.store);
    let expired = false;
    f.store.readUpdatesAfter = async (...args) => {
      const result = await read(...args);
      if (!expired && args[0] === f.contentId) {
        expired = true;
        f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
      }
      return result;
    };
    await expect(f.writer.acquire()).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    const replacement = await f.store.acquireWriter(scopeKey(f.scope), "after-expired-rebuild", 1000);
    await f.store.releaseWriter(replacement);
  } finally {
    await f.close();
  }
});

// 已取得的真实租约回执晚于 close，释放必须针对迟到的实际令牌而非关闭前本地空值。
test("真实接管回执迟到关闭后释放租约", async () => {
  const f = await authorityFixture();
  await f.writer.close();
  const paused = gate();
  const acquire = f.store.acquireWriter.bind(f.store);
  f.store.acquireWriter = async (...args) => {
    const lease = await acquire(...args);
    paused.enter();
    await paused.released;
    return lease;
  };
  const writer = f.makeWriter();
  const acquiring = rejection(writer.acquire());
  try {
    await withinDeadline(paused.entered);
    await writer.close();
    paused.release();
    expect(await acquiring).toMatchObject({ code: "RESOURCE_RETIRED" });
    f.store.acquireWriter = acquire;
    const replacement = await acquire(scopeKey(f.scope), "after-late-reply", 1000);
    await f.store.releaseWriter(replacement);
  } finally {
    paused.release();
    await writer.close();
    await f.close();
  }
});

// 旧续租回执既不能安装旧 token，也不能在拒绝时清理已经接管成功的新 lease。
test("旧公开续租回执晚于接管时不改变 replacement 写权", async () => {
  const f = await authorityFixture();
  const paused = gate();
  const renew = f.store.renewWriter.bind(f.store);
  let pause = true;
  f.store.renewWriter = async (...args) => {
    const lease = await renew(...args);
    if (pause) {
      pause = false;
      paused.enter();
      await paused.released;
    }
    return lease;
  };
  const renewed = rejection(f.writer.renew());
  try {
    await withinDeadline(paused.entered);
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await f.writer.acquire();
    paused.release();
    expect(await renewed).toMatchObject({ code: "WRITER_EPOCH_LOST" });
    await f.writer.accept(text());
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["message"]);
  } finally {
    paused.release();
    await renewed;
    await f.close();
  }
});

// 已提交正文的迟到成功不因关闭被反向拒绝；只释放自己的离线游标，不重新安装到已关闭的 writer。
test("已提交文本回执迟到关闭后仍成功且不重复写", async () => {
  const f = await authorityFixture();
  const paused = gate();
  const commit = f.store.commitContentBatch.bind(f.store);
  f.store.commitContentBatch = async (input) => {
    const result = await commit(input);
    expect(result.outcome).toBe("committed");
    paused.enter();
    await paused.released;
    return result;
  };
  const accepted = rejection(f.writer.accept(text()));
  let closing: Promise<unknown> | undefined;
  try {
    await withinDeadline(paused.entered);
    closing = rejection(f.writer.close());
    paused.release();
    expect(await accepted).toBeUndefined();
    expect(await closing).toBeUndefined();
    f.store.commitContentBatch = commit;
    const replacement = f.makeWriter();
    try {
      await replacement.acquire();
      await replacement.accept(text());
      expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["message"]);
    } finally {
      await replacement.close();
    }
  } finally {
    paused.release();
    await accepted;
    if (closing) await closing;
    await f.close();
  }
});

// 已确认提交的回执不是未写失败；回执等待期间租约过期不能改变该批次的已提交事实。
test("已提交文本回执等待期间续租过期仍报告成功", async () => {
  const f = await authorityFixture();
  const paused = gate();
  const commit = f.store.commitContentBatch.bind(f.store);
  f.store.commitContentBatch = async (input) => {
    const result = await commit(input);
    expect(result.outcome).toBe("committed");
    paused.enter();
    await paused.released;
    return result;
  };
  const accepted = f.writer.accept(text());
  void accepted.catch(() => {});
  try {
    await withinDeadline(paused.entered);
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await expect(f.writer.renew()).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    paused.release();
    await accepted;
    f.store.commitContentBatch = commit;
    await f.writer.acquire();
    await f.writer.accept(text());
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["message"]);
  } finally {
    paused.release();
    await rejection(accepted);
    await f.close();
  }
});

// 已接纳的小文本即使由 timer 先取走，后继语义仍须观察拒绝并等同一文本重试成功。
test("语义屏障不能越过在途定时冲刷的确定拒绝", async () => {
  const f = await authorityFixture({ maxDelayMs: 1, maxBytes: 1 << 20 });
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
  let accepted: Promise<unknown> | undefined;
  try {
    const before = f.store.exportCommittedState();
    await f.writer.accept(text());
    await withinDeadline(paused.entered);
    accepted = rejection(f.writer.accept(semantic("tool", { entityId: "tool" })));
    hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
    paused.release();
    expect(await accepted).toMatchObject({ code: "ADMISSION_REJECTED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    hold.release();
    await expect(f.writer.accept({ ...text("other"), idempotent: false })).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    await f.writer.accept(text());
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["message"]);
  } finally {
    paused.release();
    hold?.release();
    if (accepted) await accepted;
    await f.close();
  }
});

// 旧 token 的失败回执只能关闭旧门禁，不能清除已安装的 replacement 租约。
test("旧判重确认的过期回执不影响 replacement 写权", async () => {
  const f = await authorityFixture();
  const paused = gate();
  const confirm = f.store.confirmWriter.bind(f.store);
  let first = true;
  f.store.confirmWriter = async (...args) => {
    if (first) {
      first = false;
      paused.enter();
      await paused.released;
    }
    await confirm(...args);
  };
  let accepted: Promise<unknown> | undefined;
  try {
    await f.writer.accept(text());
    accepted = rejection(f.writer.accept(text()));
    await withinDeadline(paused.entered);
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await f.writer.acquire();
    paused.release();
    expect(await accepted).toBeUndefined();
    await f.writer.accept(text("replacement"));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual([
      "message",
      "replacement",
    ]);
  } finally {
    paused.release();
    if (accepted) await accepted;
    await f.close();
  }
});

// 判重确认失权后同步关闭输入门，不能让下一条小 delta 成功进入没有持久化能力的 merge。
test("判重确认租约过期保留原错并关闭小文本输入", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  try {
    await f.writer.accept(text());
    await f.writer.seal();
    const expired = new SyncProtocolError("LEASE_EXPIRED", { message: "duplicate confirmation lost lease" });
    f.store.confirmWriter = () => Promise.reject(expired);
    expect(await rejection(f.writer.accept(text()))).toBe(expired);
    await expect(f.writer.accept(text("later"))).rejects.toMatchObject({ code: "WRITER_EPOCH_LOST" });
  } finally {
    await f.close();
  }
});

// 关闭后的 unknown 仍可能已有正文，确认失败必须保留 unknown 及原始读错而非变成退休错误。
test("对象已提交但关闭后确认失败保留 unknown 的原因", async () => {
  const f = await authorityFixture();
  const paused = gate();
  const append = f.store.appendUpdates.bind(f.store);
  const unavailable = new Error("object confirmation unavailable");
  f.store.appendUpdates = async (input) => {
    const result = await append(input);
    expect(result.outcome).toBe("committed");
    paused.enter();
    await paused.released;
    return { outcome: "unknown", frontiers: [] };
  };
  const accepted = rejection(f.writer.accept(contentObjectInput("object")));
  try {
    await withinDeadline(paused.entered);
    await f.writer.close();
    f.store.readUpdatesAfter = () => Promise.reject(unavailable);
    paused.release();
    expect(await accepted).toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN", cause: unavailable });
  } finally {
    paused.release();
    await accepted;
    await f.close();
  }
});
