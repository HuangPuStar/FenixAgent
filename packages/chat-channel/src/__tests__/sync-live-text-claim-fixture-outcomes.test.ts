import { expect, test } from "bun:test";
import { scopeKey } from "../sync/protocol/identity";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";

for (const operation of ["createGeneration", "createDoc", "commitGeneration"] as const) {
  for (const outcome of ["conflict", "unknown"] as const) {
    // 测试 setup 必须在每个未确认阶段立即失败，释放临时租约且保持原代次指针。
    test(`换代 fixture 拒绝 ${operation} 的 ${outcome} 回执`, async () => {
      let armed = false;
      const calls: string[] = [];
      const f = await textClaimHandoffFixture(
        (store) =>
          new Proxy(store, {
            get(target, property) {
              if (property === "createGeneration")
                return async (...args: Parameters<typeof store.createGeneration>) => {
                  if (armed) calls.push(property);
                  if (armed && property === operation) return { outcome };
                  return target.createGeneration(...args);
                };
              if (property === "createDoc")
                return async (...args: Parameters<typeof store.createDoc>) => {
                  if (armed) calls.push(property);
                  if (armed && property === operation) return { outcome };
                  return target.createDoc(...args);
                };
              if (property === "commitGeneration")
                return async (...args: Parameters<typeof store.commitGeneration>) => {
                  if (armed) calls.push(property);
                  if (armed && property === operation)
                    return { outcome, currentGeneration: "gen_cursor", pointerRevision: 1 };
                  return target.commitGeneration(...args);
                };
              const value: unknown = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      );
      try {
        armed = true;
        await expect(f.replaceGeneration()).rejects.toThrow(`${operation} returned ${outcome}`);
        expect(calls).toEqual(
          operation === "createGeneration"
            ? ["createGeneration"]
            : operation === "createDoc"
              ? ["createGeneration", "createDoc"]
              : ["createGeneration", "createDoc", "createDoc", "commitGeneration"],
        );
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

// 发布的指针正确也不能覆盖错误回执，setup 不能在 receipt generation 矛盾时重开写者。
test("换代 fixture 拒绝与真实 pointer 不一致的成功 receipt generation", async () => {
  const f = await textClaimHandoffFixture(
    (store) =>
      new Proxy(store, {
        get(target, property) {
          if (property === "commitGeneration")
            return async (...args: Parameters<typeof store.commitGeneration>) => {
              const committed = await target.commitGeneration(...args);
              return { ...committed, currentGeneration: "gen_cursor" };
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  );
  try {
    await expect(f.replaceGeneration()).rejects.toThrow("replacement pointer differs");
    expect(await f.store.readScopePointer(scopeKey(f.scope))).toMatchObject({
      currentGeneration: "new-generation",
      writerOwner: null,
    });
  } finally {
    await f.close();
  }
});
