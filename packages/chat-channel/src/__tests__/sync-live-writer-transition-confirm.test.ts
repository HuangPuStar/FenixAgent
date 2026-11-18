import { expect, test } from "bun:test";
import { LIVE_WRITER_LEASE_TTL_MS } from "../sync/live/live-writer";
import { WriterAuthority } from "../sync/live/writer-authority";
import { type SyncScope, scopeKey } from "../sync/protocol/identity";
import type { ProjectionStore, WriterLease } from "../sync/store/types";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";
import {
  authorityFixture,
  gate,
  rejection,
  replaceGeneration,
  text,
  withinDeadline,
} from "./sync-live-writer-authority-fixture";
import { historyRecord, SCOPE_KEY, setupWithHistory, userInput } from "./sync-live-writer-fixture";

/** 读取真实租约令牌，模拟拥有协调权的外部流程进行交接或换代。 */
async function leaseOf(store: ProjectionStore, scope: SyncScope | string): Promise<WriterLease> {
  const pointer = await store.readScopePointer(typeof scope === "string" ? scope : scopeKey(scope));
  if (!pointer?.writerOwner) throw new Error("missing active writer lease");
  return {
    scopeKey: pointer.scopeKey,
    epoch: pointer.writerEpoch,
    owner: pointer.writerOwner,
    expiresAt: pointer.leaseExpiresAt,
  };
}

/** 不推进时钟的真实写权交接，旧 writer 的本地 expiry 仍未到期。 */
async function transferLease(store: ProjectionStore, scope: SyncScope | string): Promise<WriterLease> {
  const previous = await leaseOf(store, scope);
  await store.releaseWriter?.(previous);
  return await store.acquireWriter(previous.scopeKey, "external-owner", 30000);
}

// claim 缓存命中仍须确认 Store 当前代次，不能在外部换代后静默吞掉新代次同键输入。
test("cached text claim 命中在外部换代后拒绝旧投影", async () => {
  const f = await authorityFixture();
  try {
    await f.writer.accept(text());
    await replaceGeneration(f, await leaseOf(f.store, f.scope));
    await expect(f.writer.accept(text())).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
    expect(
      f.store.exportCommittedState().updates.filter((update) => update.docId.includes("gen_replacement")),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

// 新 writer 的活跃记录命中不能绕过真实写权检查，即使自己的本地 lease 尚未到期。
test("active text 命中在外部 epoch 交接后拒绝旧写者", async () => {
  const f = await authorityFixture();
  let lease: WriterLease | undefined;
  const writer = f.makeWriter();
  try {
    await f.writer.accept(text());
    await f.writer.close();
    await writer.acquire();
    lease = await transferLease(f.store, f.scope);
    await expect(writer.accept(text())).rejects.toMatchObject({ code: "WRITER_EPOCH_LOST" });
  } finally {
    if (lease) await f.store.releaseWriter(lease);
    await writer.close();
    await f.close();
  }
});

// 已封口前驱的持久索引命中也必须经过相同的无写入线性化点。
test("live-text 索引命中在外部 epoch 交接后拒绝旧写者", async () => {
  const f = await textClaimHandoffFixture();
  let lease: WriterLease | undefined;
  try {
    await f.append("A");
    await f.append("B");
    await f.reopen();
    lease = await transferLease(f.store, f.scope);
    await expect(f.append("A")).rejects.toMatchObject({ code: "WRITER_EPOCH_LOST" });
  } finally {
    if (lease) await f.store.releaseWriter(lease);
    await f.close();
  }
});

// 历史导入按 entryId 命中的用户消息也不能把已经失权的本地投影视为当前权威。
test("导入历史命中在外部 epoch 交接后拒绝旧写者", async () => {
  const f = await setupWithHistory([historyRecord("history:user", "imported")]);
  let lease: WriterLease | undefined;
  try {
    lease = await transferLease(f.store, SCOPE_KEY);
    await expect(f.writer.accept(userInput("history", "imported"))).rejects.toMatchObject({
      code: "WRITER_EPOCH_LOST",
    });
  } finally {
    if (lease) await f.store.releaseWriter(lease);
    await f.writer.close();
    f.store.dispose();
  }
});

for (const changedGeneration of [false, true]) {
  // Store 已完成确认后再发生重建，不反向改变旧代次已经线性化的重复判定，也不重放到新代次。
  test(`重复命中的确认回执晚于本地重建，换代=${changedGeneration}`, async () => {
    const f = await authorityFixture();
    const paused = gate();
    let accepted: Promise<void> | undefined;
    try {
      await f.writer.accept(text());
      const confirm = f.store.confirmWriter.bind(f.store);
      let pause = true;
      f.store.confirmWriter = async (...args) => {
        await confirm(...args);
        if (pause) {
          pause = false;
          paused.enter();
          await paused.released;
        }
      };
      accepted = f.writer.accept(text());
      void accepted.catch(() => {});
      await withinDeadline(paused.entered);
      if (changedGeneration) {
        const acquire = f.store.acquireWriter.bind(f.store);
        f.store.acquireWriter = async (...args) => {
          const lease = await acquire(...args);
          await replaceGeneration(f, lease);
          return lease;
        };
        await f.writer.acquire();
      } else {
        await f.writer.recover();
      }
      paused.release();
      await accepted;
      if (changedGeneration)
        expect(
          f.store.exportCommittedState().updates.filter((update) => update.docId.includes("gen_replacement")),
        ).toHaveLength(0);
    } finally {
      paused.release();
      if (accepted) await rejection(accepted);
      await f.close();
    }
  });
}

// 无写入确认只核实写权和代次，不改变已接纳小文本的缓冲及持久化边界。
test("重复命中确认不冲刷已缓冲的小文本", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  try {
    await f.writer.accept(text());
    const confirm = f.store.confirmWriter.bind(f.store);
    let confirmations = 0;
    f.store.confirmWriter = async (...args) => {
      confirmations++;
      await confirm(...args);
    };
    await f.writer.accept(text());
    expect(confirmations).toBe(1);
    expect(await f.readAll()).toEqual([]);
    await f.writer.seal();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["message"]);
  } finally {
    await f.close();
  }
});

// Store 已确认的无写入操作在该点成功，后来的 lease expiry 不会把成功回执变成入口错误。
test("重复命中确认成功后的续租过期不反向拒绝回执", async () => {
  const f = await authorityFixture();
  const paused = gate();
  let accepted: Promise<void> | undefined;
  try {
    await f.writer.accept(text());
    const confirm = f.store.confirmWriter.bind(f.store);
    f.store.confirmWriter = async (...args) => {
      await confirm(...args);
      paused.enter();
      await paused.released;
    };
    accepted = f.writer.accept(text());
    void accepted.catch(() => {});
    await withinDeadline(paused.entered);
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await expect(f.writer.renew()).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    paused.release();
    await accepted;
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["message"]);
  } finally {
    paused.release();
    if (accepted) await rejection(accepted);
    await f.close();
  }
});

// 确认成功后关闭只终止后续工作，已线性化的重复判定不再改写任何 writer 状态。
test("重复命中确认成功后的关闭不反向拒绝回执", async () => {
  const f = await authorityFixture();
  const paused = gate();
  let accepted: Promise<void> | undefined;
  try {
    await f.writer.accept(text());
    const confirm = f.store.confirmWriter.bind(f.store);
    f.store.confirmWriter = async (...args) => {
      await confirm(...args);
      paused.enter();
      await paused.released;
    };
    accepted = f.writer.accept(text());
    void accepted.catch(() => {});
    await withinDeadline(paused.entered);
    await f.writer.close();
    paused.release();
    await accepted;
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["message"]);
  } finally {
    paused.release();
    if (accepted) await rejection(accepted);
    await f.close();
  }
});

// 在最后一次本地检查后排入公开接管，真实队列必须已拥有此次 merge admission，不能丢在额外 await 间隙。
test("claim 接纳与 merge admission 之间没有可被公开接管截断的 receipt 间隙", async () => {
  const f = await authorityFixture();
  const installed = WriterAuthority.prototype.isInstalled;
  let acquiring: Promise<void> | undefined;
  let schedule = true;
  WriterAuthority.prototype.isInstalled = function (token) {
    const current = installed.call(this, token);
    if (current && schedule) {
      schedule = false;
      queueMicrotask(() => {
        acquiring = f.writer.acquire();
        void acquiring.catch(() => {});
      });
    }
    return current;
  };
  try {
    await f.writer.accept(text("first"));
    if (acquiring) await acquiring;
    await f.writer.accept(text("second"));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["first", "second"]);
  } finally {
    WriterAuthority.prototype.isInstalled = installed;
    if (acquiring) await rejection(acquiring);
    await f.close();
  }
});

// 入站对象属于调用方，异步判重后的 merge 必须沿用进入边界时捕获的完整消息身份。
test("异步 claim 期间调用方修改原输入不改变已声明的消息身份", async () => {
  const f = await authorityFixture();
  const paused = gate();
  let accepted: Promise<void> | undefined;
  try {
    const locate = f.store.locateRefs.bind(f.store);
    f.store.locateRefs = async (...args) => {
      const result = await locate(...args);
      paused.enter();
      await paused.released;
      return result;
    };
    const input = { ...text("A") };
    accepted = f.writer.accept(input);
    void accepted.catch(() => {});
    await withinDeadline(paused.entered);
    input.entryId = "B";
    input.turnId = "other-turn";
    input.contentSlot = "thought";
    input.contentType = "text/other";
    paused.release();
    await accepted;
    await f.writer.accept(text("A"));
    expect((await f.readAll()).map((record) => [record.entryId, record.contentSlot, record.contentType])).toEqual([
      ["A", "text", "text/plain"],
    ]);
  } finally {
    paused.release();
    if (accepted) await rejection(accepted);
    await f.close();
  }
});

// gate 必须同步停旧 timer；同 owner 有效租约不会换 Store epoch，迟到提交仍可能落地。
test("接管开始后旧合并 timer 不再长出遗漏 drain 的提交", async () => {
  const f = await authorityFixture({ maxDelayMs: 5, maxBytes: 1024 });
  const paused = gate();
  const acquire = f.store.acquireWriter.bind(f.store);
  const commit = f.store.commitContentBatch.bind(f.store);
  let acquiring: Promise<void> | undefined;
  let commits = 0;
  f.store.acquireWriter = async (...args) => {
    paused.enter();
    await paused.released;
    return acquire(...args);
  };
  f.store.commitContentBatch = async (input) => {
    commits++;
    return commit(input);
  };
  try {
    await f.writer.accept(text("first"));
    acquiring = f.writer.acquire();
    void acquiring.catch(() => {});
    await withinDeadline(paused.entered);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(commits).toBe(0);
    paused.release();
    await acquiring;
    await f.writer.accept(text("second"));
    await f.writer.seal();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["second"]);
  } finally {
    paused.release();
    if (acquiring) await rejection(acquiring);
    await f.close();
  }
});
