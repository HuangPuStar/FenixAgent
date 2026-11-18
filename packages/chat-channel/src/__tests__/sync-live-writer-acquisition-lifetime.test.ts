import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createLiveWriter } from "../sync/live/live-writer";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { scopeKey } from "../sync/protocol/identity";
import { fixture } from "./sync-live-admission-fixture";

/** 让关闭发生在指定的异步存储边界。 */
function gate() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, release, entered, released };
}

for (const boundary of ["acquireWriter", "readScopePointer"] as const) {
  // 关闭先于存储回执或重建完成时，迟到的接管不能报告成功或继续占用写权。
  test(`关闭期间等待 ${boundary} 的接管会释放租约并拒绝`, async () => {
    const f = await fixture();
    await f.writer.close();
    const paused = gate();
    const store = new Proxy(f.store, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property === boundary)
          return async (...args: unknown[]) => {
            paused.enter();
            await paused.released;
            if (typeof value !== "function") throw new Error("missing store method");
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const clock = { now: () => 1000 };
    const writer = createLiveWriter({
      scope: f.scope,
      store,
      clock,
      digest: sha256Digest,
      random: deterministicRandomSource("late-acquire"),
      capacity: DEFAULT_SYNC_CAPACITY,
      admission: f.admission,
      merge: { maxDelayMs: 600000, maxBytes: 16384 },
      limits: RUNTIME_DOC_LIMITS,
      rotation: {
        clock,
        random: deterministicRandomSource("late-rotation"),
        limits: RUNTIME_DOC_LIMITS,
        maxResidentMs: 600000,
        maxTransactions: 1000,
      },
    });
    const acquired = writer.acquire().then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        paused.entered,
        acquired.then((error) => {
          throw error ?? new Error("acquire did not reach pause");
        }),
      ]);
      await writer.close();
      paused.release();
      expect(await acquired).toMatchObject({ code: "RESOURCE_RETIRED" });
      const replacement = await f.store.acquireWriter(scopeKey(f.scope), "replacement-after-close", 1000);
      await f.store.releaseWriter(replacement);
    } finally {
      paused.release();
      await acquired;
      await writer.close();
      await f.close();
    }
  });
}
