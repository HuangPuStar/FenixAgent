import { afterEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createRedisProvider, persistYjsClearedSnapshotWithCas } from "../persist/redis";
import { nextMicrotask, RedisDouble, sleep, snapshotConfig } from "./helpers/redis-provider-double";

describe("createRedisProvider 快照持久化", () => {
  const docs: Y.Doc[] = [];

  afterEach(() => {
    for (const doc of docs.splice(0)) doc.destroy();
  });

  // 清空 CAS 必须删除清空者本地快照未见的 Redis 并发内容，而非使用通用合并 CAS。
  test("clears concurrent Redis session content with a dedicated CAS snapshot", async () => {
    const baseline = new Y.Doc();
    const current = new Y.Doc();
    const localBaseline = new Y.Doc();
    const restored = new Y.Doc();
    docs.push(baseline, current, localBaseline, restored);

    baseline.getArray("messages").push(["old message"]);
    baseline.getArray("structuredMessages").push([{ id: "old" }]);
    baseline.getMap("streaming").set("old", true);
    baseline.getMap("tools").set("old", { status: "running" });
    baseline.getArray("artifacts").push([{ id: "old" }]);
    baseline.getMap("meta").set("status", "streaming");
    baseline.getMap("meta").set("loading", "old request");

    const baselineSnapshot = Y.encodeStateAsUpdate(baseline);
    Y.applyUpdate(current, baselineSnapshot);
    current.getArray("messages").push(["concurrent message"]);
    current.getArray("structuredMessages").push([{ id: "concurrent" }]);
    current.getMap("streaming").set("concurrent", true);
    current.getMap("tools").set("concurrent", { status: "running" });
    current.getArray("artifacts").push([{ id: "concurrent" }]);
    Y.applyUpdate(localBaseline, baselineSnapshot);

    const redis = new RedisDouble(Buffer.from(Y.encodeStateAsUpdate(current)));
    const persisted = await persistYjsClearedSnapshotWithCas(
      redis as never,
      "yjs:session:clear-concurrent",
      Y.encodeStateAsUpdate(localBaseline),
      (ydoc) => {
        ydoc.transact(() => {
          for (const name of ["messages", "structuredMessages", "artifacts"]) {
            const collection = ydoc.getArray(name);
            collection.delete(0, collection.length);
          }
          ydoc.getMap("streaming").clear();
          ydoc.getMap("tools").clear();
          const meta = ydoc.getMap("meta");
          meta.set("status", "idle");
          meta.set("loading", null);
        });
      },
      604800,
    );

    expect(persisted).toBe(true);
    expect(redis.sets).toHaveLength(1);
    // SP-C1：快照写入附带调用方给出的 TTL（F1 起不再有包内默认值）。
    expect(redis.sets[0]?.ttlSeconds).toBe(604800);
    Y.applyUpdate(restored, redis.sets[0]?.value ?? Buffer.alloc(0));
    expect(restored.getArray("messages").toArray()).toEqual([]);
    expect(restored.getArray("structuredMessages").toArray()).toEqual([]);
    expect(restored.getMap("streaming").toJSON()).toEqual({});
    expect(restored.getMap("tools").toJSON()).toEqual({});
    expect(restored.getArray("artifacts").toArray()).toEqual([]);
    expect(restored.getMap("meta").toJSON()).toMatchObject({ status: "idle", loading: null });
  });

  // SP-A1：destroy（closeChat/closeSession 收口）必须强制 flush 未落盘的待写快照，
  // 关闭节流窗口的崩溃丢失语义；destroy 后远端消息也不再影响文档。
  test("forces a pending snapshot flush on destroy and ignores later messages", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    const source = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:destroyed", ydoc, { snapshot: snapshotConfig() });
    await nextMicrotask();

    ydoc.getMap("state").set("value", "pending");
    await provider.destroy();
    await nextMicrotask();

    expect(redis.sets).toHaveLength(1);
    expect(redis.published).toHaveLength(1);
    const restored = new Y.Doc();
    docs.push(restored);
    Y.applyUpdate(restored, redis.sets[0]?.value ?? Buffer.alloc(0));
    expect(restored.getMap("state").toJSON()).toEqual({ value: "pending" });

    const setCountBeforeRemoteMessage = redis.sets.length;
    const publishCountBeforeRemoteMessage = redis.published.length;

    source.getMap("state").set("remote", "ignored");
    redis.emitMessage("yjs:channel:session:destroyed", Buffer.from(Y.encodeStateAsUpdate(source)));

    expect(ydoc.getMap("state").toJSON()).toEqual({ value: "pending" });
    expect(redis.sets).toHaveLength(setCountBeforeRemoteMessage);
    expect(redis.published).toHaveLength(publishCountBeforeRemoteMessage);

    source.destroy();
  });

  // SP-A1：节流窗口内的多次 update 只触发 1 次快照 CAS，静默期结束后补一次 trailing flush。
  test("throttles snapshot CAS within the window and flushes once after the idle gap", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:throttle", ydoc, {
      snapshot: snapshotConfig({ intervalMs: 5000, idleMs: 60 }),
    });
    await nextMicrotask();

    const state = ydoc.getMap<string>("state");
    state.set("first", "one"); // 尚无成功写入，首次调度立即持久化
    await nextMicrotask();
    expect(redis.sets).toHaveLength(1);

    state.set("second", "two");
    state.set("third", "three");
    await nextMicrotask();
    await sleep(25);
    expect(redis.sets).toHaveLength(1); // 窗口内合并，不产生新 CAS

    await sleep(150); // 距最后一条 update 已超过 60ms 静默期
    expect(redis.sets).toHaveLength(2);
    const restored = new Y.Doc();
    docs.push(restored);
    Y.applyUpdate(restored, redis.sets[1]?.value ?? Buffer.alloc(0));
    expect(restored.getMap("state").toJSON()).toEqual({ first: "one", second: "two", third: "three" });
    expect(redis.sets[1]?.ttlSeconds).toBeGreaterThan(0);

    await provider.destroy();
    expect(redis.sets).toHaveLength(2); // 无待写快照时 destroy 不重复 flush
  });

  // SP-A1：持续 update（静默期不触发）下 CAS 频率由 interval 窗口决定，与 update 次数解耦。
  test("bounds snapshot CAS rate to the interval under continuous updates", async () => {
    const casTimes: number[] = [];
    class TimedRedisDouble extends RedisDouble {
      override writeStored(key: string, value: Buffer, ttlSeconds?: number): void {
        casTimes.push(performance.now());
        super.writeStored(key, value, ttlSeconds);
      }
    }
    const redis = new TimedRedisDouble();
    const intervalMs = 120;
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:interval-rate", ydoc, {
      snapshot: snapshotConfig({ intervalMs, idleMs: 60000 }),
    });
    await nextMicrotask();

    const state = ydoc.getMap<string>("state");
    state.set("first", "one");
    await nextMicrotask();
    expect(redis.sets).toHaveLength(1);

    for (let index = 0; index < 12; index += 1) {
      state.set(`key${index}`, `value${index}`);
      await sleep(10);
    }
    await sleep(30);

    // 事件循环繁忙可拉长整个输入周期；真实 CAS 间距才反映节流契约，2ms 仅覆盖时钟取整误差。
    expect(casTimes.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < casTimes.length; index += 1) {
      expect(casTimes[index]! - casTimes[index - 1]!).toBeGreaterThanOrEqual(intervalMs - 2);
    }

    await provider.destroy();
    // destroy 强制 flush 收口：最终快照包含全部内容。
    const restored = new Y.Doc();
    docs.push(restored);
    Y.applyUpdate(restored, redis.sets[redis.sets.length - 1]?.value ?? Buffer.alloc(0));
    const restoredState = restored.getMap("state").toJSON() as Record<string, string>;
    expect(restoredState.first).toBe("one");
    for (let index = 0; index < 12; index += 1) {
      expect(restoredState[`key${index}`]).toBe(`value${index}`);
    }
  });

  // SP-A1：destroy 强制 flush 节流窗口内尚未到期的待写快照。
  test("forces a throttled pending snapshot flush on destroy", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:destroy-flush", ydoc, {
      snapshot: snapshotConfig({ intervalMs: 60000, idleMs: 60000 }),
    });
    await nextMicrotask();

    ydoc.getMap("state").set("value", "pending");
    await provider.destroy();
    await nextMicrotask();

    expect(redis.sets).toHaveLength(1);
    const restored = new Y.Doc();
    docs.push(restored);
    Y.applyUpdate(restored, redis.sets[0]?.value ?? Buffer.alloc(0));
    expect(restored.getMap("state").toJSON()).toEqual({ value: "pending" });
  });

  // SP-A6：自身发布的 update（带发布者头）回灌到本进程 subscriber 不触发 apply；
  // 伪装成自身发布的外部内容同样被过滤；其他发布者的带头部消息正常 apply。
  test("skips self-published updates via the publisher header while applying others", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:self-loop", ydoc, { snapshot: snapshotConfig() });
    await nextMicrotask();

    let updateCount = 0;
    ydoc.on("update", () => {
      updateCount += 1;
    });

    ydoc.getMap("state").set("local", "value");
    await nextMicrotask();
    const baselineCount = updateCount;
    const baselineSets = redis.sets.length;
    const baselinePublished = redis.published.length;
    expect(baselinePublished).toBe(1);

    // 自身发布的原始载荷回灌（真实 Redis 会把消息投回发布进程的 subscriber）
    redis.emitMessage("yjs:channel:session:self-loop", redis.published[0]!.value);
    expect(updateCount).toBe(baselineCount);
    expect(redis.published).toHaveLength(baselinePublished);
    expect(redis.sets).toHaveLength(baselineSets);

    // 同 publisherId 头 + 本文档未见过的外部内容：必须被自环过滤丢弃（否则会污染文档）
    const foreign = new Y.Doc();
    docs.push(foreign);
    foreign.getMap("state").set("foreign", "must-not-apply");
    const ownHeader = redis.published[0]!.value.subarray(0, 21); // flag + id + length
    redis.emitMessage(
      "yjs:channel:session:self-loop",
      Buffer.concat([ownHeader, Buffer.from(Y.encodeStateAsUpdate(foreign))]),
    );
    expect(ydoc.getMap("state").toJSON()).toEqual({ local: "value" });
    expect(updateCount).toBe(baselineCount);

    // 其他发布者（不同 publisherId）的带头部消息正常 apply
    const other = new Y.Doc();
    docs.push(other);
    other.getMap("state").set("fromOther", "applied");
    const otherUpdate = Buffer.from(Y.encodeStateAsUpdate(other));
    const otherFrame = Buffer.alloc(21 + otherUpdate.length);
    otherFrame[0] = 0x80;
    otherFrame.fill(7, 1, 17);
    otherFrame.writeUInt32BE(otherUpdate.length, 17);
    otherUpdate.copy(otherFrame, 21);
    redis.emitMessage("yjs:channel:session:self-loop", otherFrame);
    expect(ydoc.getMap("state").toJSON()).toEqual({ local: "value", fromOther: "applied" });

    await provider.destroy();
  });

  // SP-A6/SP-A1：两个 provider（模拟双进程：注入不同 publisherId）经 pub/sub 互发
  // 带头部增量仍收敛，且不自环放大消息量。
  test("converges two providers exchanging framed updates over pub/sub", async () => {
    const redis = new RedisDouble();
    const firstDoc = new Y.Doc();
    const secondDoc = new Y.Doc();
    docs.push(firstDoc, secondDoc);
    const first = createRedisProvider(redis as never, "session:fanout", firstDoc, { snapshot: snapshotConfig() });
    const secondPublisherId = new Uint8Array(16).fill(0xab);
    const second = createRedisProvider(redis as never, "session:fanout", secondDoc, {
      snapshot: snapshotConfig(),
      publisherId: secondPublisherId,
    });
    await nextMicrotask();

    firstDoc.getMap("state").set("fromFirst", "one");
    secondDoc.getMap("state").set("fromSecond", "two");
    await nextMicrotask();

    expect(firstDoc.getMap("state").toJSON()).toEqual({ fromFirst: "one", fromSecond: "two" });
    expect(secondDoc.getMap("state").toJSON()).toEqual({ fromFirst: "one", fromSecond: "two" });
    expect(redis.published).toHaveLength(2); // 各发一条，无自环/回显放大

    await first.destroy();
    await second.destroy();
  });

  // SP-C1：快照 CAS 使用调用方指定的滑动 TTL。
  test("writes snapshots with the configured sliding TTL", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:ttl-config", ydoc, {
      snapshot: snapshotConfig({ ttlSeconds: 3600 }),
    });
    await nextMicrotask();

    ydoc.getMap("state").set("value", "persisted");
    await nextMicrotask();

    expect(redis.sets).toHaveLength(1);
    expect(redis.sets[0]?.ttlSeconds).toBe(3600);

    await provider.destroy();
  });

  // SP-0：CAS 打点仅含尺寸/耗时/标识，不包含会话内容。
  test("reports snapshot CAS metrics without leaking content", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const lines: string[] = [];
    const provider = createRedisProvider(redis as never, "session:metrics", ydoc, {
      snapshot: snapshotConfig(),
      log: (line) => lines.push(line),
    });
    await nextMicrotask();

    ydoc.getMap("state").set("secret", "metrics-secret-content");
    await nextMicrotask();
    await provider.destroy();
    await nextMicrotask();

    const casLines = lines.filter((line) => line.includes("snapshot cas"));
    expect(casLines.length).toBeGreaterThan(0);
    for (const line of casLines) {
      expect(line).toContain("doc=session:metrics");
      expect(line).toContain("bytes=");
      expect(line).toContain("encodeMs=");
      expect(line).toContain("casMs=");
      expect(line).not.toContain("metrics-secret-content");
    }
  });
});
