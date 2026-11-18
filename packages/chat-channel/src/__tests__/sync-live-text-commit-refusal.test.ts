import { expect, test } from "bun:test";
import type { Reservation } from "../sync/capacity/admission";
import { isTextBatchNotWritten } from "../sync/live/text-batch-commit";
import { SyncProtocolError } from "../sync/protocol/errors";
import { scopeKey } from "../sync/protocol/identity";
import type { CommitContentBatchInput } from "../sync/store/live-content-batch-types";
import { indexBytes } from "../sync/store/memory-accounting";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";

// 已经出现 unknown 时，重用旧额度异常的后续确定拒绝不能覆盖第一次提交的不确定性。
test("未知提交后复用旧拒绝对象仍保留未知结果停写", async () => {
  const refused = new SyncProtocolError("ADMISSION_REJECTED", { message: "controlled refusal" });
  let planRefused = false;
  let commits = 0;
  const f = await textClaimHandoffFixture(
    (store) =>
      new Proxy(store, {
        get(target, property) {
          if (property === "readScopePointer")
            return async (...args: Parameters<typeof store.readScopePointer>) => {
              if (planRefused) throw refused;
              return target.readScopePointer(...args);
            };
          if (property === "commitContentBatch")
            return async () => {
              if (commits++ === 0) return { outcome: "unknown" as const, frontiers: [] };
              throw refused;
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  );
  try {
    planRefused = true;
    await expect(f.append("A")).rejects.toBe(refused);
    expect(isTextBatchNotWritten(refused)).toBe(true);
    expect(f.store.exportCommittedState().refs).toEqual([]);
    planRefused = false;
    const outcome = await f.append("A").catch((error: unknown) => error);
    expect(outcome).toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN", cause: refused });
    expect(isTextBatchNotWritten(outcome)).toBe(false);
    expect(isTextBatchNotWritten(refused)).toBe(false);
    expect(f.store.exportCommittedState().refs).toEqual([]);
    expect(await f.readAll()).toEqual([]);
    await expect(f.append("A")).rejects.toBe(outcome);
    await expect(f.writer.acquire()).rejects.toBe(outcome);
  } finally {
    await f.close();
  }
});

for (const unknownFirst of [false, true]) {
  // 最后一份 scope 元数据额度来自真实 Memory Store；确定拒绝可恢复，先前 unknown 不可被它抹掉。
  test(`真实 Store 末阶段拒绝${unknownFirst ? "保留先前未知结果" : "归还额度后接管并完整重试"}`, async () => {
    let inStore = false;
    let commits = 0;
    const f = await textClaimHandoffFixture(
      (store) =>
        new Proxy(store, {
          get(target, property) {
            if (property === "commitContentBatch")
              return async (input: CommitContentBatchInput) => {
                if (unknownFirst && commits++ === 0) return { outcome: "unknown" as const, frontiers: [] };
                inStore = true;
                try {
                  return await target.commitContentBatch(input);
                } finally {
                  inStore = false;
                }
              };
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    );
    const reserve = f.admission.reserve.bind(f.admission);
    let hold: Reservation | undefined;
    try {
      const pointer = await f.store.readScopePointer(scopeKey(f.scope));
      if (!pointer) throw new Error("Missing scope");
      const scopeCharge = scopeKey(f.scope).length * 2 + indexBytes(pointer);
      let armed = true;
      f.admission.reserve = (pool, count) => {
        if (inStore && armed && pool === "controlIndex" && count === scopeCharge) {
          armed = false;
          hold = reserve(pool, f.admission.available(pool));
        }
        return reserve(pool, count);
      };
      const before = f.store.exportCommittedState();
      const refused = await f.append("A").catch((error: unknown) => error);
      expect(hold).toBeDefined();
      expect(refused).toMatchObject({ code: unknownFirst ? "COMMIT_OUTCOME_UNKNOWN" : "ADMISSION_REJECTED" });
      expect(isTextBatchNotWritten(refused)).toBe(!unknownFirst);
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(await f.readAll()).toEqual([]);
      hold?.release();
      f.admission.reserve = reserve;
      if (unknownFirst) {
        await expect(f.writer.acquire()).rejects.toBe(refused);
        await expect(f.append("A")).rejects.toBe(refused);
      } else {
        await f.writer.acquire();
        await f.append("A");
        await f.append("A");
        expect((await f.readAll()).map((record) => record.entryId)).toEqual(["A"]);
        expect(f.store.exportCommittedState().refs).toHaveLength(1);
      }
    } finally {
      hold?.release();
      f.admission.reserve = reserve;
      await f.close();
    }
  });
}

// unknown 未提交分支不能留下定位索引，失权后仍保持未知结果而非放行整条重试。
test("未知文本提交与失权不会持久化声明引用", async () => {
  let unknown = true;
  const f = await textClaimHandoffFixture(
    (store) =>
      new Proxy(store, {
        get(target, property) {
          if (property === "commitContentBatch") return async () => ({ outcome: "unknown" as const, frontiers: [] });
          if (property === "renewWriter")
            return async (...args: Parameters<typeof store.renewWriter>) => {
              if (!unknown) throw new SyncProtocolError("LEASE_EXPIRED");
              unknown = false;
              return target.renewWriter(...args);
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  );
  try {
    await expect(f.append("A")).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
    expect(f.store.exportCommittedState().refs).toEqual([]);
    expect(await f.readAll()).toEqual([]);
  } finally {
    await f.close();
  }
});
