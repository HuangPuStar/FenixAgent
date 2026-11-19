import { expect, test } from "bun:test";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";
import { gate, rejection, withinDeadline } from "./sync-live-writer-authority-fixture";

// 相同输入的首个读取失败时，等待中的重发不能仅因占位和有效租约就提前成功。
test("同键并发 admission 等待首个读取并共享失败后可重试", async () => {
  const paused = gate();
  const failure = new Error("claim lookup unavailable");
  let armed = true;
  let lookups = 0;
  const f = await textClaimHandoffFixture(
    (store) =>
      new Proxy(store, {
        get(target, property) {
          if (property === "locateRefs")
            return async (...args: Parameters<typeof store.locateRefs>) => {
              lookups++;
              if (armed) {
                paused.enter();
                await paused.released;
                throw failure;
              }
              return target.locateRefs(...args);
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  );
  const first = rejection(f.append("same"));
  let second: Promise<unknown> | undefined;
  try {
    await withinDeadline(paused.entered);
    let settled = false;
    second = rejection(f.append("same")).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    paused.release();
    expect(await first).toBe(failure);
    expect(await second).toBe(failure);
    expect(lookups).toBe(1);
    armed = false;
    await f.append("same");
    expect((await f.readAll()).map((record) => record.entryId)).toEqual(["same"]);
  } finally {
    paused.release();
    await first;
    await second;
    await f.close();
  }
});

// 首次入 merge 后仍在冲刷的同键输入，必须共享实际写入拒绝而非确认租约后成功。
test("同键并发 admission 共享首次入 merge 的冲刷失败", async () => {
  const paused = gate();
  const failure = new Error("controlled flush failure");
  const f = await textClaimHandoffFixture(
    (store) =>
      new Proxy(store, {
        get(target, property) {
          if (property === "commitContentBatch")
            return async () => {
              paused.enter();
              await paused.released;
              throw failure;
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  );
  const first = rejection(f.append("same"));
  let second: Promise<unknown> | undefined;
  try {
    await withinDeadline(paused.entered);
    let settled = false;
    second = rejection(f.append("same")).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    paused.release();
    expect(await first).toBe(failure);
    expect(await second).toBe(failure);
    expect(await f.readAll()).toEqual([]);
  } finally {
    paused.release();
    await first;
    await second;
    await f.close();
  }
});

// 旧读取在同代次重建后恢复时，也必须加入新投影的整次接纳任务，不能只等待 claim 判定。
test("旧 admission 重建后与新同键冲刷共享失败且不提前确认成功", async () => {
  const lookup = gate(),
    flush = gate();
  const failure = new Error("replacement flush unavailable");
  let pauseLookup = true,
    failCommit = false;
  const f = await textClaimHandoffFixture(
    (store) =>
      new Proxy(store, {
        get(target, property) {
          if (property === "locateRefs")
            return async (...args: Parameters<typeof store.locateRefs>) => {
              const refs = await target.locateRefs(...args);
              if (pauseLookup) {
                pauseLookup = false;
                lookup.enter();
                await lookup.released;
              }
              return refs;
            };
          if (property === "commitContentBatch")
            return async (...args: Parameters<typeof store.commitContentBatch>) => {
              if (failCommit) {
                flush.enter();
                await flush.released;
                throw failure;
              }
              return target.commitContentBatch(...args);
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  );
  let firstSettled = false;
  const first = rejection(f.append("same")).then((value) => {
    firstSettled = true;
    return value;
  });
  let second: Promise<unknown> | undefined;
  try {
    await withinDeadline(lookup.entered);
    await f.writer.recover();
    failCommit = true;
    second = rejection(f.append("same"));
    await withinDeadline(flush.entered);
    lookup.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstSettled).toBe(false);
    flush.release();
    expect(await first).toBe(failure);
    expect(await second).toBe(failure);
    expect(await f.readAll()).toEqual([]);
  } finally {
    lookup.release();
    flush.release();
    await first;
    await second;
    await f.close();
  }
});
