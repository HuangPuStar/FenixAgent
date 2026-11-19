import { expect, test } from "bun:test";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";
import { gate, rejection, withinDeadline } from "./sync-live-writer-authority-fixture";

for (const captureBeforeCommit of [false, true]) {
  // 同投影正常轮转不替换 authority；索引与局部尾块错位必须重读新尾块后再决定是否入 merge。
  test(`claim 捕获旧尾块且索引${captureBeforeCommit ? "错过" : "看见"} successor 提交时重判`, async () => {
    const paused = gate();
    let armed = false;
    const f = await textClaimHandoffFixture(
      (store) =>
        new Proxy(store, {
          get(target, property) {
            if (property === "locateRefs")
              return async (...args: Parameters<typeof store.locateRefs>) => {
                if (armed) {
                  armed = false;
                  const captured = captureBeforeCommit ? await target.locateRefs(...args) : undefined;
                  paused.enter();
                  await paused.released;
                  return captured ?? target.locateRefs(...args);
                }
                return target.locateRefs(...args);
              };
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    );
    let pending: Promise<unknown> | undefined;
    try {
      await f.append("seed");
      armed = true;
      pending = rejection(f.append("moving"));
      await withinDeadline(paused.entered);
      await f.writer.accept({
        kind: "text-delta",
        turnId: "moving",
        entryId: "moving",
        contentSlot: "text",
        contentType: "text/plain",
        delta: "same text",
      });
      paused.release();
      expect(await pending).toBeUndefined();
      expect((await f.readAll()).map((record) => record.entryId)).toEqual(["seed", "moving"]);
    } finally {
      paused.release();
      await pending;
      await f.close();
    }
  });
}
