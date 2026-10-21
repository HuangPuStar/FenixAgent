import { afterEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createRedisProvider } from "../persist/redis";
import { createChatDoc } from "../state/factory";
import {
  deferred,
  nextMicrotask,
  RedisDouble,
  SubscriberDouble,
  snapshotConfig,
} from "./helpers/redis-provider-double";

describe("createRedisProvider 初始化与同步", () => {
  const docs: Y.Doc[] = [];

  afterEach(() => {
    for (const doc of docs.splice(0)) doc.destroy();
  });

  // 主连接保持命令模式；订阅只使用 duplicate 的独立连接。
  test("uses a duplicate subscriber while the command connection persists and publishes", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:commands", ydoc, { snapshot: snapshotConfig() });
    await nextMicrotask();

    const subscriber = redis.subscribers[0];
    expect(redis.duplicateCalls).toBe(2);
    expect(redis.persistences).toHaveLength(1);
    expect(subscriber?.subscriptions).toEqual(["yjs:channel:session:commands"]);

    ydoc.getMap("state").set("value", "written");
    await nextMicrotask();

    expect(redis.sets).toHaveLength(1);
    expect(redis.published).toHaveLength(1);
    expect(redis.disconnected).toBe(false);

    await provider.destroy();

    expect(subscriber?.unsubscriptions).toEqual([]);
    expect(subscriber?.disconnected).toBe(true);
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(subscriber?.quitCalled).toBe(false);
    expect(redis.disconnected).toBe(false);
  });

  // 同一事件循环内的本地变更会合并为一个可恢复快照，但每个增量都会发布。
  test("coalesces same-tick changes into one recoverable full snapshot while publishing every delta", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:one", ydoc, { snapshot: snapshotConfig() });
    await nextMicrotask();

    const state = ydoc.getMap<string>("state");
    state.set("first", "one");
    state.set("second", "two");
    await nextMicrotask();

    expect(redis.sets).toHaveLength(1);
    expect(redis.sets[0]?.key).toBe("yjs:session:one");
    expect(redis.sets[0]?.value).toBeInstanceOf(Buffer);
    expect(redis.published).toHaveLength(2);
    expect(redis.published.every(({ value }) => Buffer.isBuffer(value))).toBe(true);

    const restored = new Y.Doc();
    docs.push(restored);
    Y.applyUpdate(restored, redis.sets[0]?.value ?? Buffer.alloc(0));
    expect(restored.getMap("state").toJSON()).toEqual({ first: "one", second: "two" });

    await provider.destroy();
  });

  // 两个 provider 的 Pub/Sub 消息都丢失时，CAS 重试后的 Redis 全量状态仍须保留双方独立更新。
  test("merges concurrent full snapshots so a later provider restores both disconnected updates", async () => {
    const redis = new RedisDouble();
    const firstDoc = new Y.Doc();
    const secondDoc = new Y.Doc();
    docs.push(firstDoc, secondDoc);
    const firstProvider = createRedisProvider(redis as never, "session:concurrent", firstDoc, {
      snapshot: snapshotConfig(),
    });
    const secondProvider = createRedisProvider(redis as never, "session:concurrent", secondDoc, {
      snapshot: snapshotConfig(),
    });
    await nextMicrotask();

    redis.conflictNextExecs = 1;
    firstDoc.getMap("state").set("fromFirst", "one");
    secondDoc.getMap("state").set("fromSecond", "two");
    await nextMicrotask();
    await nextMicrotask();
    await nextMicrotask();

    expect(redis.persistences[0]?.watchCalls).toBeGreaterThan(1);
    expect(redis.persistences[1]?.watchCalls).toBeGreaterThan(0);
    expect(redis.sets.every(({ value }) => Buffer.isBuffer(value))).toBe(true);

    const restored = new Y.Doc();
    docs.push(restored);
    const restoredProvider = createRedisProvider(redis as never, "session:concurrent", restored, {
      snapshot: snapshotConfig(),
    });
    await nextMicrotask();

    expect(restored.getMap("state").toJSON()).toEqual({ fromFirst: "one", fromSecond: "two" });

    await firstProvider.destroy();
    await secondProvider.destroy();
    await restoredProvider.destroy();
  });
  // getBuffer 返回的旧版 base64 快照可以恢复到文档。
  test("restores legacy base64 snapshots returned by getBuffer", async () => {
    const source = new Y.Doc();
    source.getMap("state").set("legacy", "restored");
    const legacySnapshot = Buffer.from(Y.encodeStateAsUpdate(source)).toString("base64");
    source.destroy();

    const redis = new RedisDouble(Buffer.from(legacySnapshot));
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:legacy", ydoc, { snapshot: snapshotConfig() });
    await nextMicrotask();

    expect(ydoc.getMap("state").toJSON()).toEqual({ legacy: "restored" });

    await provider.destroy();
  });

  // 当前频道的远端 update 只应用到文档，且不会反向发布或持久化；无发布者头的
  // 旧格式（滚动部署窗口）按原始 update 全量 apply 回落，无损兼容。
  test("applies remote updates without publishing or persisting them", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    const source = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:remote", ydoc, { snapshot: snapshotConfig() });
    await nextMicrotask();

    source.getMap("state").set("remote", "applied");
    redis.emitMessage(Buffer.from("yjs:channel:session:remote"), Buffer.from(Y.encodeStateAsUpdate(source)));

    expect(ydoc.getMap("state").toJSON()).toEqual({ remote: "applied" });
    expect(redis.sets).toHaveLength(0);
    expect(redis.published).toHaveLength(0);

    source.destroy();
    await provider.destroy();
  });

  // 其他频道的远端 update 不能应用到当前文档。
  test("ignores remote updates from another provider channel", async () => {
    const redis = new RedisDouble();
    const firstDoc = new Y.Doc();
    const secondDoc = new Y.Doc();
    const source = new Y.Doc();
    docs.push(firstDoc, secondDoc);
    const firstProvider = createRedisProvider(redis as never, "session:first", firstDoc, {
      snapshot: snapshotConfig(),
    });
    const secondProvider = createRedisProvider(redis as never, "session:second", secondDoc, {
      snapshot: snapshotConfig(),
    });
    await nextMicrotask();

    source.getMap("state").set("remote", "first-only");
    redis.emitMessage("yjs:channel:session:first", Buffer.from(Y.encodeStateAsUpdate(source)));

    expect(firstDoc.getMap("state").toJSON()).toEqual({ remote: "first-only" });
    expect(secondDoc.getMap("state").toJSON()).toEqual({});

    source.destroy();
    await firstProvider.destroy();
    await secondProvider.destroy();
  });

  // 订阅确认后才读取快照；读取期间收到的远端消息和快照都必须合并。
  test("subscribes before loading and merges remote updates received during the initial snapshot read", async () => {
    const subscribe = deferred<number>();
    const snapshot = deferred<Buffer | null>();
    const redis = new RedisDouble(
      null,
      () => snapshot.promise,
      () => new SubscriberDouble(() => subscribe.promise),
    );
    const ydoc = new Y.Doc();
    const remoteSource = new Y.Doc();
    const snapshotSource = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:initial-order", ydoc, {
      snapshot: snapshotConfig(),
    });

    redis.emitMessage("yjs:channel:session:initial-order", Buffer.from(Y.encodeStateAsUpdate(remoteSource)));
    expect(redis.getBufferCalls).toBe(0);

    subscribe.resolve(1);
    await nextMicrotask();
    expect(redis.getBufferCalls).toBe(1);

    remoteSource.getMap("state").set("remote", "received-during-load");
    redis.emitMessage("yjs:channel:session:initial-order", Buffer.from(Y.encodeStateAsUpdate(remoteSource)));
    snapshotSource.getMap("state").set("snapshot", "loaded-after-subscribe");
    snapshot.resolve(Buffer.from(Y.encodeStateAsUpdate(snapshotSource)));
    await nextMicrotask();

    expect(ydoc.getMap("state").toJSON()).toEqual({
      remote: "received-during-load",
      snapshot: "loaded-after-subscribe",
    });

    remoteSource.destroy();
    snapshotSource.destroy();
    await provider.destroy();
  });

  // 订阅监听器已生效但 subscribe Promise 尚未 resolve 时收到的消息不能丢失。
  test("applies a message received before the subscribe promise resolves", async () => {
    const subscribe = deferred<number>();
    const redis = new RedisDouble(null, undefined, () => new SubscriberDouble(() => subscribe.promise));
    const ydoc = new Y.Doc();
    const source = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:subscribe-handoff", ydoc, {
      snapshot: snapshotConfig(),
    });

    source.getMap("state").set("remote", "received-before-ready");
    redis.emitMessage("yjs:channel:session:subscribe-handoff", Buffer.from(Y.encodeStateAsUpdate(source)));
    expect(ydoc.getMap("state").toJSON()).toEqual({ remote: "received-before-ready" });

    subscribe.resolve(1);
    await nextMicrotask();

    source.destroy();
    await provider.destroy();
  });

  // load pending 时产生的本地增量须按原顺序发布，并和加载快照一起恢复为完整状态。
  test("publishes local updates made while loading and persists their merged snapshot", async () => {
    const snapshot = deferred<Buffer | null>();
    const redis = new RedisDouble(null, () => snapshot.promise);
    const ydoc = new Y.Doc();
    const snapshotSource = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:pending-local", ydoc, {
      snapshot: snapshotConfig(),
    });
    await nextMicrotask();

    const state = ydoc.getMap<string>("state");
    state.set("first", "local-one");
    state.set("second", "local-two");
    expect(redis.published).toHaveLength(0);

    snapshotSource.getMap("state").set("snapshot", "loaded");
    snapshot.resolve(Buffer.from(Y.encodeStateAsUpdate(snapshotSource)));
    await nextMicrotask();

    expect(redis.published).toHaveLength(2);
    expect(redis.sets).toHaveLength(1);
    const restored = new Y.Doc();
    docs.push(restored);
    Y.applyUpdate(restored, redis.sets[0]?.value ?? Buffer.alloc(0));
    expect(restored.getMap("state").toJSON()).toEqual({
      first: "local-one",
      second: "local-two",
      snapshot: "loaded",
    });

    snapshotSource.destroy();
    await provider.destroy();
  });

  // subscriber 的 error 事件有安全处理器，不能成为未处理的 EventEmitter 错误。
  test("handles subscriber errors without throwing", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:subscriber-error", ydoc, {
      snapshot: snapshotConfig(),
    });
    const subscriber = redis.subscribers[0];

    expect(() => subscriber?.emitError()).not.toThrow();
    expect(subscriber?.listenerCount("error")).toBe(1);

    await provider.destroy();
    expect(subscriber?.listenerCount("messageBuffer")).toBe(0);
    expect(subscriber?.listenerCount("error")).toBe(0);
  });

  // subscribe 同步抛错时必须移除两个监听器并断开刚 duplicate 的连接。
  test("cleans up a duplicated subscriber when subscribe throws synchronously", async () => {
    const subscriber = new SubscriberDouble(() => {
      throw new Error("subscribe threw");
    });
    const redis = new RedisDouble(null, undefined, () => subscriber);
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:subscribe-throw", ydoc, {
      snapshot: snapshotConfig(),
    });
    await nextMicrotask();

    expect(subscriber.disconnected).toBe(true);
    expect(subscriber.listenerCount("messageBuffer")).toBe(0);
    expect(subscriber.listenerCount("error")).toBe(0);

    ydoc.getMap("state").set("local", "still-enabled");
    await nextMicrotask();
    expect(redis.published).toHaveLength(1);
    expect(redis.sets).toHaveLength(1);

    await provider.destroy();
  });

  test("destroys promptly while subscribe is pending and skips later initialization", async () => {
    const subscribe = deferred<number>();
    const redis = new RedisDouble(null, undefined, () => new SubscriberDouble(() => subscribe.promise));
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:pending-destroy", ydoc, {
      snapshot: snapshotConfig(),
    });
    const subscriber = redis.subscribers[0];

    await expect(
      Promise.race([
        provider.destroy().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]),
    ).resolves.toBe(true);
    expect(subscriber?.disconnected).toBe(true);

    subscribe.resolve(1);
    await nextMicrotask();
    expect(redis.getBufferCalls).toBe(0);
  });

  // 初始加载或订阅失败后，本地变更仍必须持久化并逐条发布。
  test("keeps local persistence and publishing enabled after initial load or subscribe failure", async () => {
    const loadFailureRedis = new RedisDouble(null, () => Promise.reject(new Error("load failed")));
    const loadFailureDoc = new Y.Doc();
    docs.push(loadFailureDoc);
    const loadFailureProvider = createRedisProvider(loadFailureRedis as never, "session:load-failure", loadFailureDoc, {
      snapshot: snapshotConfig(),
    });
    await nextMicrotask();

    loadFailureDoc.getMap("state").set("afterLoadFailure", true);
    await nextMicrotask();
    expect(loadFailureRedis.sets).toHaveLength(1);
    expect(loadFailureRedis.published).toHaveLength(1);

    const subscribeFailureRedis = new RedisDouble(
      null,
      undefined,
      () => new SubscriberDouble(() => Promise.reject(new Error("subscribe failed"))),
    );
    const subscribeFailureDoc = new Y.Doc();
    docs.push(subscribeFailureDoc);
    const subscribeFailureProvider = createRedisProvider(
      subscribeFailureRedis as never,
      "session:subscribe-failure",
      subscribeFailureDoc,
      { snapshot: snapshotConfig() },
    );
    await nextMicrotask();

    subscribeFailureDoc.getMap("state").set("afterSubscribeFailure", true);
    await nextMicrotask();
    expect(subscribeFailureRedis.sets).toHaveLength(1);
    expect(subscribeFailureRedis.published).toHaveLength(1);

    await loadFailureProvider.destroy();
    await subscribeFailureProvider.destroy();
  });
});

// F1：包内不再保留快照参数的第二份默认值——Redis 模式下拿不到装配注入的参数时必须立即失败，
// 而不是静默用代码里的默认值（默认值真相只在 agent-runtime manifest 的 `envDefinitions` 声明，
// 断言见 apps/server/src/__tests__/assembly-env.test.ts）。
test("rejects Redis-mode docs when snapshot parameters are not injected", () => {
  const redis = new RedisDouble();

  expect(() => createChatDoc("rcs_missing_snapshot_config", redis as never)).toThrow("快照参数未注入");
});
