import { afterEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createRedisProvider, persistYjsClearedSnapshotWithCas } from "../persist/redis";

type MessageListener = (channel: Buffer | string, message: Buffer) => void;
type ErrorListener = () => void;

class SubscriberDouble {
  readonly subscriptions: string[] = [];
  readonly unsubscriptions: string[] = [];
  disconnected = false;
  quitCalled = false;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(private readonly subscribeHandler: (channel: string) => Promise<number> = () => Promise.resolve(1)) {}

  subscribe(channel: string): Promise<number> {
    this.subscriptions.push(channel);
    return this.subscribeHandler(channel);
  }

  unsubscribe(channel: string): Promise<number> {
    this.unsubscriptions.push(channel);
    return Promise.resolve(0);
  }

  quit(): Promise<"OK"> {
    this.quitCalled = true;
    return Promise.resolve("OK");
  }

  disconnect(): void {
    this.disconnected = true;
  }

  on(event: "messageBuffer", listener: MessageListener): void;
  on(event: "error", listener: ErrorListener): void;
  on(event: "messageBuffer" | "error", listener: MessageListener | ErrorListener): void {
    if (event === "messageBuffer") {
      this.messageListeners.add(listener as MessageListener);
      return;
    }
    this.errorListeners.add(listener as ErrorListener);
  }

  off(event: "messageBuffer", listener: MessageListener): void;
  off(event: "error", listener: ErrorListener): void;
  off(event: "messageBuffer" | "error", listener: MessageListener | ErrorListener): void {
    if (event === "messageBuffer") {
      this.messageListeners.delete(listener as MessageListener);
      return;
    }
    this.errorListeners.delete(listener as ErrorListener);
  }

  emitMessage(channel: Buffer | string, message: Buffer): void {
    for (const listener of this.messageListeners) {
      listener(channel, message);
    }
  }

  emitError(): void {
    for (const listener of this.errorListeners) listener();
  }

  listenerCount(event: "messageBuffer" | "error"): number {
    return event === "messageBuffer" ? this.messageListeners.size : this.errorListeners.size;
  }
}

class PersistenceDouble {
  disconnected = false;
  watchCalls = 0;
  unwatchCalls = 0;
  private watchedVersion: number | null = null;

  constructor(private readonly redis: RedisDouble) {}

  watch(_key: string): Promise<"OK"> {
    this.watchCalls += 1;
    this.watchedVersion = this.redis.version;
    return Promise.resolve("OK");
  }

  unwatch(): Promise<"OK"> {
    this.unwatchCalls += 1;
    this.watchedVersion = null;
    return Promise.resolve("OK");
  }

  getBuffer(): Promise<Buffer | null> {
    return this.redis.readStored();
  }

  multi(): { set(key: string, value: Buffer): unknown; exec(): Promise<unknown | null> } {
    let pending: { key: string; value: Buffer } | null = null;
    const transaction = {
      set: (key: string, value: Buffer) => {
        pending = { key, value };
        return transaction;
      },
      exec: () => {
        if (!pending || this.watchedVersion === null || this.redis.shouldConflict(this.watchedVersion)) {
          this.watchedVersion = null;
          return Promise.resolve(null);
        }
        this.redis.writeStored(pending.key, pending.value);
        this.watchedVersion = null;
        return Promise.resolve([[null, "OK"]]);
      },
    };
    return transaction;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class RedisDouble {
  readonly published: Array<{ channel: string; value: Buffer }> = [];
  readonly sets: Array<{ key: string; value: Buffer }> = [];
  readonly subscribers: SubscriberDouble[] = [];
  readonly persistences: PersistenceDouble[] = [];
  duplicateCalls = 0;
  getBufferCalls = 0;
  disconnected = false;
  version = 0;
  conflictNextExecs = 0;
  private stored: Buffer | null;

  constructor(
    stored: Buffer | null = null,
    private readonly getBufferHandler?: () => Promise<Buffer | null>,
    private readonly subscriberFactory?: () => SubscriberDouble,
  ) {
    this.stored = stored;
  }

  readStored(): Promise<Buffer | null> {
    return Promise.resolve(this.stored ? Buffer.from(this.stored) : null);
  }

  writeStored(key: string, value: Buffer): void {
    this.sets.push({ key, value: Buffer.from(value) });
    this.stored = Buffer.from(value);
    this.version += 1;
  }

  shouldConflict(watchedVersion: number): boolean {
    if (this.conflictNextExecs > 0) {
      this.conflictNextExecs -= 1;
      this.version += 1;
      return true;
    }
    return watchedVersion !== this.version;
  }

  getBuffer(): Promise<Buffer | null> {
    this.getBufferCalls += 1;
    return this.getBufferHandler?.() ?? this.readStored();
  }

  set(key: string, value: Buffer): Promise<"OK"> {
    this.writeStored(key, value);
    return Promise.resolve("OK");
  }

  publish(channel: string, value: Buffer): Promise<number> {
    this.published.push({ channel, value });
    return Promise.resolve(1);
  }

  duplicate(): SubscriberDouble | PersistenceDouble {
    const duplicateIndex = this.duplicateCalls;
    this.duplicateCalls += 1;
    if (duplicateIndex % 2 === 0) {
      const persistence = new PersistenceDouble(this);
      this.persistences.push(persistence);
      return persistence;
    }

    const subscriber = this.subscriberFactory?.() ?? new SubscriberDouble();
    this.subscribers.push(subscriber);
    return subscriber;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emitMessage(channel: Buffer | string, message: Buffer): void {
    for (const subscriber of this.subscribers) {
      subscriber.emitMessage(channel, message);
    }
  }
}

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

const nextMicrotask = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

describe("createRedisProvider", () => {
  const docs: Y.Doc[] = [];

  afterEach(() => {
    for (const doc of docs.splice(0)) doc.destroy();
  });

  // 主连接保持命令模式；订阅只使用 duplicate 的独立连接。
  test("uses a duplicate subscriber while the command connection persists and publishes", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:commands", ydoc);
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
    const provider = createRedisProvider(redis as never, "session:one", ydoc);
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
    const firstProvider = createRedisProvider(redis as never, "session:concurrent", firstDoc);
    const secondProvider = createRedisProvider(redis as never, "session:concurrent", secondDoc);
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
    const restoredProvider = createRedisProvider(redis as never, "session:concurrent", restored);
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
    const provider = createRedisProvider(redis as never, "session:legacy", ydoc);
    await nextMicrotask();

    expect(ydoc.getMap("state").toJSON()).toEqual({ legacy: "restored" });

    await provider.destroy();
  });

  // 当前频道的远端 update 只应用到文档，且不会反向发布或持久化。
  test("applies remote updates without publishing or persisting them", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    const source = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:remote", ydoc);
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
    const firstProvider = createRedisProvider(redis as never, "session:first", firstDoc);
    const secondProvider = createRedisProvider(redis as never, "session:second", secondDoc);
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
    const provider = createRedisProvider(redis as never, "session:initial-order", ydoc);

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
    const provider = createRedisProvider(redis as never, "session:subscribe-handoff", ydoc);

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
    const provider = createRedisProvider(redis as never, "session:pending-local", ydoc);
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
    const provider = createRedisProvider(redis as never, "session:subscriber-error", ydoc);
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
    const provider = createRedisProvider(redis as never, "session:subscribe-throw", ydoc);
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
    const provider = createRedisProvider(redis as never, "session:pending-destroy", ydoc);
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
    const loadFailureProvider = createRedisProvider(loadFailureRedis as never, "session:load-failure", loadFailureDoc);
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
    );
    await nextMicrotask();

    subscribeFailureDoc.getMap("state").set("afterSubscribeFailure", true);
    await nextMicrotask();
    expect(subscribeFailureRedis.sets).toHaveLength(1);
    expect(subscribeFailureRedis.published).toHaveLength(1);

    await loadFailureProvider.destroy();
    await subscribeFailureProvider.destroy();
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
    );

    expect(persisted).toBe(true);
    expect(redis.sets).toHaveLength(1);
    Y.applyUpdate(restored, redis.sets[0]?.value ?? Buffer.alloc(0));
    expect(restored.getArray("messages").toArray()).toEqual([]);
    expect(restored.getArray("structuredMessages").toArray()).toEqual([]);
    expect(restored.getMap("streaming").toJSON()).toEqual({});
    expect(restored.getMap("tools").toJSON()).toEqual({});
    expect(restored.getArray("artifacts").toArray()).toEqual([]);
    expect(restored.getMap("meta").toJSON()).toMatchObject({ status: "idle", loading: null });
  });

  // destroy 后同一频道的消息不会再影响文档，也不会触发持久化或发布。
  test("does not flush a scheduled snapshot after destroy", async () => {
    const redis = new RedisDouble();
    const ydoc = new Y.Doc();
    const source = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:destroyed", ydoc);
    await nextMicrotask();

    ydoc.getMap("state").set("value", "pending");
    await provider.destroy();
    await nextMicrotask();

    expect(redis.sets).toHaveLength(0);
    expect(redis.published).toHaveLength(1);
    const setCountBeforeRemoteMessage = redis.sets.length;
    const publishCountBeforeRemoteMessage = redis.published.length;

    source.getMap("state").set("remote", "ignored");
    redis.emitMessage("yjs:channel:session:destroyed", Buffer.from(Y.encodeStateAsUpdate(source)));

    expect(ydoc.getMap("state").toJSON()).toEqual({ value: "pending" });
    expect(redis.sets).toHaveLength(setCountBeforeRemoteMessage);
    expect(redis.published).toHaveLength(publishCountBeforeRemoteMessage);

    source.destroy();
  });
});
