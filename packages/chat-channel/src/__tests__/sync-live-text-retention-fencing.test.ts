import { expect, test } from "bun:test";
import { LIVE_WRITER_LEASE_TTL_MS } from "../sync/live/live-writer";
import { isTextBatchNotWritten } from "../sync/live/text-batch-commit";
import { SyncProtocolError } from "../sync/protocol/errors";
import { scopeKey } from "../sync/protocol/identity";
import { authorityFixture, rejection, text } from "./sync-live-writer-authority-fixture";

/** 在真实 Store 中制造过期或新 epoch，失权错误仍由实际原子提交判定。 */
async function fence(f: Awaited<ReturnType<typeof authorityFixture>>, code: "LEASE_EXPIRED" | "WRITER_EPOCH_LOST") {
  if (code === "LEASE_EXPIRED") {
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    return;
  }
  const pointer = await f.store.readScopePointer(scopeKey(f.scope));
  if (!pointer?.writerOwner) throw new Error("missing original lease");
  await f.store.releaseWriter({
    scopeKey: pointer.scopeKey,
    epoch: pointer.writerEpoch,
    owner: pointer.writerOwner,
    expiresAt: pointer.leaseExpiresAt,
  });
  const replacement = await f.store.acquireWriter(pointer.scopeKey, "external-fencer", 1000);
  await f.store.releaseWriter(replacement);
}

for (const code of ["LEASE_EXPIRED", "WRITER_EPOCH_LOST"] as const) {
  // 首次原子 Store 明确拒绝才生成未写证明；同代恢复以新 epoch 提交保留原文，幂等重发不追加。
  test(`首次 Store ${code} 未写可在同代新 token 重放原窗口`, async () => {
    const f = await authorityFixture();
    const commit = f.store.commitContentBatch.bind(f.store);
    const before = await f.store.readScopePointer(scopeKey(f.scope));
    let commits = 0;
    f.store.commitContentBatch = async (input) => {
      if (++commits === 1) await fence(f, code);
      return await commit(input);
    };
    try {
      const original = await rejection(f.writer.accept(text("retained")));
      expect(original).toHaveProperty("code", code);
      expect(isTextBatchNotWritten(original)).toBe(true);
      if (!(original instanceof Error)) throw new Error("missing wrapped Store failure");
      expect(original.cause).toHaveProperty("code", code);
      expect(await f.readAll()).toEqual([]);
      await f.writer.acquire();
      const after = await f.store.readScopePointer(scopeKey(f.scope));
      expect(after!.writerEpoch).toBeGreaterThan(before!.writerEpoch);
      await f.writer.accept(text("retained"));
      expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["retained"]);
      expect(commits).toBe(2);
      expect(f.admission.used("ingressSpool")).toBe(0);
    } finally {
      await f.close();
    }
  });

  // 相同 Store 错误发生在 unknown 后不再证明整条尝试未写，恢复和 close 必须保留原 unknown 且不重放。
  test(`先前 unknown 后 Store ${code} 仍未知且不跨 token 重放`, async () => {
    const f = await authorityFixture();
    const commit = f.store.commitContentBatch.bind(f.store);
    let commits = 0;
    f.store.commitContentBatch = async (input) => {
      if (++commits === 1) return { outcome: "unknown", frontiers: [] };
      await fence(f, code);
      return await commit(input);
    };
    try {
      const original = await rejection(f.writer.accept(text("uncertain")));
      expect(original).toHaveProperty("code", "COMMIT_OUTCOME_UNKNOWN");
      expect(isTextBatchNotWritten(original)).toBe(false);
      if (!(original instanceof Error) || !(original.cause instanceof SyncProtocolError))
        throw new Error("missing attempted Store refusal");
      expect(original.cause.code).toBe(code);
      expect(original.cause.cause).toHaveProperty("code", code);
      expect(commits).toBe(2);
      expect(await rejection(f.writer.acquire())).toBe(original);
      expect(await rejection(f.writer.close())).toBe(original);
      expect(commits).toBe(2);
      expect(f.admission.used("ingressSpool")).toBe(0);
      expect(await f.readAll()).toEqual([]);
    } finally {
      await f.close();
    }
  });
}
