import { expect, test } from "bun:test";
import { scopeKey } from "../sync/protocol/identity";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";

for (const operation of ["createGeneration", "createDoc", "commitGeneration"] as const) {
  for (const outcome of ["conflict", "unknown"] as const) {
    // 测试 setup 必须在每个未确认阶段立即失败，释放临时租约且保持原代次指针。
    test(`换代 fixture 拒绝 ${operation} 的 ${outcome} 回执`, async () => {
      let armed = false;
      const f = await textClaimHandoffFixture(
        (store) =>
          new Proxy(store, {
            get(target, property) {
              if (property === operation)
                return async () => {
                  if (armed) return { outcome, currentGeneration: "gen_cursor", pointerRevision: 1 };
                  throw new Error("unexpected fixture initialization write");
                };
              const value: unknown = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      );
      try {
        armed = true;
        await expect(f.replaceGeneration()).rejects.toThrow(`${operation} returned ${outcome}`);
        expect(await f.store.readScopePointer(scopeKey(f.scope))).toMatchObject({
          currentGeneration: "gen_cursor",
          writerOwner: null,
        });
      } finally {
        await f.close();
      }
    });
  }
}

// 即使 adapter 伪报成功，setup 也必须确认真实 pointer 已切换到目标代次后才能重开写者。
test("换代 fixture 要求实际 pointer 与成功回执一致", async () => {
  const f = await textClaimHandoffFixture(
    (store) =>
      new Proxy(store, {
        get(target, property) {
          if (property === "commitGeneration")
            return async () => ({
              outcome: "committed",
              currentGeneration: "new-generation",
              pointerRevision: 2,
            });
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  );
  try {
    await expect(f.replaceGeneration()).rejects.toThrow("replacement pointer differs");
    expect(await f.store.readScopePointer(scopeKey(f.scope))).toMatchObject({ writerOwner: null });
  } finally {
    await f.close();
  }
});
