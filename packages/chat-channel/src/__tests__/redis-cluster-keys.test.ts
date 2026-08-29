import { afterEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  buildRedisProviderKeys,
  buildRedisSessionKeys,
  createRedisProvider,
  getOrCreateActiveGeneration,
} from "../persist/redis";

function redisSlot(key: string): number {
  const open = key.indexOf("{");
  const close = open >= 0 ? key.indexOf("}", open + 1) : -1;
  const value = open >= 0 && close > open + 1 ? key.slice(open + 1, close) : key;
  let crc = 0;
  for (const byte of Buffer.from(value, "utf8")) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc % 16_384;
}

class PersistenceDouble {
  readonly watchedKeys: string[][] = [];
  disconnected = false;
  private watched = false;

  constructor(private readonly redis: RedisClusterDouble) {}

  watch(...keys: string[]): Promise<"OK"> {
    this.watchedKeys.push(keys);
    this.watched = true;
    return Promise.resolve("OK");
  }

  unwatch(): Promise<"OK"> {
    this.watched = false;
    return Promise.resolve("OK");
  }

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  getBuffer(key: string): Promise<Buffer | null> {
    return this.redis.readBuffer(key);
  }

  multi() {
    let pending: { key: string; value: Buffer; seconds?: number } | null = null;
    const transaction = {
      set: (key: string, value: Buffer, expiryMode?: "EX", seconds?: number) => {
        pending = { key, value, seconds: expiryMode === "EX" ? seconds : undefined };
        return transaction;
      },
      exec: async () => {
        if (!this.watched || !pending) return null;
        this.redis.writeBuffer(pending.key, pending.value, pending.seconds);
        this.watched = false;
        return [[null, "OK"]];
      },
    };
    return transaction;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

type MessageListener = (channel: Buffer | string, message: Buffer) => void;

class SubscriberDouble {
  readonly subscriptions: string[] = [];
  disconnected = false;
  private readonly messageListeners = new Set<MessageListener>();

  subscribe(channel: string): Promise<number> {
    this.subscriptions.push(channel);
    return Promise.resolve(1);
  }

  on(event: "messageBuffer" | "error", listener: MessageListener | (() => void)): void {
    if (event === "messageBuffer") this.messageListeners.add(listener as MessageListener);
  }

  off(event: "messageBuffer" | "error", listener: MessageListener | (() => void)): void {
    if (event === "messageBuffer") this.messageListeners.delete(listener as MessageListener);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class RedisClusterDouble {
  readonly bufferReads: string[] = [];
  readonly stringReads: string[] = [];
  readonly writes: Array<{ key: string; value: Buffer; seconds?: number }> = [];
  readonly stringWrites: Array<{ key: string; value: string; mode?: string }> = [];
  readonly evalKeys: string[][] = [];
  readonly publishes: string[] = [];
  readonly persistences: PersistenceDouble[] = [];
  readonly subscribers: SubscriberDouble[] = [];
  private readonly buffers = new Map<string, Buffer>();
  private readonly strings = new Map<string, string>();
  private duplicateCount = 0;

  seedBuffer(key: string, value: Uint8Array): void {
    this.buffers.set(key, Buffer.from(value));
  }

  seedString(key: string, value: string): void {
    this.strings.set(key, value);
  }

  getBuffer(key: string): Promise<Buffer | null> {
    this.bufferReads.push(key);
    return this.readBuffer(key);
  }

  readBuffer(key: string): Promise<Buffer | null> {
    const value = this.buffers.get(key);
    return Promise.resolve(value ? Buffer.from(value) : null);
  }

  get(key: string): Promise<string | null> {
    this.stringReads.push(key);
    return Promise.resolve(this.strings.get(key) ?? null);
  }

  set(key: string, value: string, mode?: string): Promise<"OK"> {
    this.stringWrites.push({ key, value, mode });
    if (mode !== "NX" || !this.strings.has(key)) this.strings.set(key, value);
    return Promise.resolve("OK");
  }

  writeBuffer(key: string, value: Buffer, seconds?: number): void {
    this.buffers.set(key, Buffer.from(value));
    this.writes.push({ key, value: Buffer.from(value), seconds });
  }

  publish(channel: string): Promise<number> {
    this.publishes.push(channel);
    return Promise.resolve(1);
  }

  eval(_script: string, numberOfKeys: number, ...args: unknown[]): Promise<number> {
    const keys = args.slice(0, numberOfKeys).map(String);
    this.evalKeys.push(keys);
    if (numberOfKeys === 2) {
      const expected = String(args[2]);
      if (this.strings.get(keys[0]!) === expected) this.publishes.push(keys[1]!);
    }
    return Promise.resolve(1);
  }

  duplicate(): PersistenceDouble | SubscriberDouble {
    if (this.duplicateCount++ % 2 === 0) {
      const persistence = new PersistenceDouble(this);
      this.persistences.push(persistence);
      return persistence;
    }
    const subscriber = new SubscriberDouble();
    this.subscribers.push(subscriber);
    return subscriber;
  }
}

function snapshot(value: string): Uint8Array {
  const ydoc = new Y.Doc();
  ydoc.getMap("state").set("source", value);
  const update = Y.encodeStateAsUpdate(ydoc);
  ydoc.destroy();
  return update;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("Redis Cluster 安全键与快照迁移", () => {
  const docs: Y.Doc[] = [];

  afterEach(() => {
    for (const doc of docs.splice(0)) doc.destroy();
  });

  // 恶意花括号、冒号和 Unicode ID 只能进入 base64url，三类运行时键必须共槽。
  test("为边界 RCS ID 构造受控且共槽的键", () => {
    for (const id of ["tenant{evil}:a", "tenant:with:colons", "租户:会话:一"]) {
      const keys = buildRedisProviderKeys(`session:${id}`, "gen:一");
      expect(keys.snapshotKey).not.toContain(id);
      expect(keys.channel).not.toContain(id);
      expect(keys.activeGenerationKey).not.toContain(id);
      expect(new Set([keys.snapshotKey, keys.channel, keys.activeGenerationKey].map(redisSlot)).size).toBe(1);
      expect(keys.hashTag).toMatch(/^\{rcs-[A-Za-z0-9_-]+\}$/);
    }
    expect(buildRedisProviderKeys("session:tenant{evil}:a", "gen-1").legacySnapshotKey).toBeNull();
  });

  // 新键存在时必须具有绝对优先级，不能额外读取或合并旧快照。
  test("新快照键优先于旧键", async () => {
    const redis = new RedisClusterDouble();
    const keys = buildRedisProviderKeys("session:tenant:one");
    redis.seedBuffer(keys.snapshotKey, snapshot("new"));
    redis.seedBuffer(keys.legacySnapshotKey!, snapshot("legacy"));
    const ydoc = new Y.Doc();
    docs.push(ydoc);

    const provider = createRedisProvider(redis as never, "session:tenant:one", ydoc);
    await settle();

    expect(ydoc.getMap("state").toJSON()).toEqual({ source: "new" });
    expect(redis.bufferReads).toEqual([keys.snapshotKey]);
    await provider.destroy();
  });

  // 只有新键不存在（null）时才允许读取旧快照，保障滚动升级恢复。
  test("新快照缺失时回退读取旧键", async () => {
    const redis = new RedisClusterDouble();
    const keys = buildRedisProviderKeys("chat:tenant:legacy");
    redis.seedBuffer(keys.legacySnapshotKey!, snapshot("legacy"));
    const ydoc = new Y.Doc();
    docs.push(ydoc);

    const provider = createRedisProvider(redis as never, "chat:tenant:legacy", ydoc);
    await settle();

    expect(ydoc.getMap("state").toJSON()).toEqual({ source: "legacy" });
    expect(redis.bufferReads).toEqual([keys.snapshotKey, keys.legacySnapshotKey!]);
    await provider.destroy();
  });

  // 新键即使为空或损坏也代表迁移已发生，不得回退并复活旧数据。
  test("存在但无效的新快照不回退旧键", async () => {
    const redis = new RedisClusterDouble();
    const keys = buildRedisProviderKeys("session:tenant:invalid");
    redis.seedBuffer(keys.snapshotKey, Buffer.alloc(0));
    redis.seedBuffer(keys.legacySnapshotKey!, snapshot("must-not-revive"));
    const ydoc = new Y.Doc();
    docs.push(ydoc);

    const provider = createRedisProvider(redis as never, "session:tenant:invalid", ydoc);
    await settle();

    expect(ydoc.getMap("state").toJSON()).toEqual({});
    expect(redis.bufferReads).toEqual([keys.snapshotKey]);
    await provider.destroy();
  });

  // fenced EVAL 和 snapshot WATCH 的全部 KEYS 必须共槽，写入与订阅只使用新格式。
  test("fenced 发布和快照 CAS 只使用共槽新键", async () => {
    const redis = new RedisClusterDouble();
    const generation = "gen-safe";
    const keys = buildRedisProviderKeys("session:tenant{evil}:a", generation);
    redis.seedString(keys.activeGenerationKey, generation);
    const ydoc = new Y.Doc();
    docs.push(ydoc);
    const provider = createRedisProvider(redis as never, "session:tenant{evil}:a", ydoc, { generation });
    await settle();

    ydoc.getMap("state").set("local", true);
    await settle();

    expect(redis.subscribers[0]?.subscriptions).toEqual([keys.channel]);
    expect(redis.evalKeys).toEqual([[keys.activeGenerationKey, keys.channel]]);
    expect(redis.persistences[0]?.watchedKeys).toEqual([[keys.snapshotKey, keys.activeGenerationKey]]);
    expect(redis.writes.map(({ key }) => key)).toEqual([keys.snapshotKey]);
    expect(redis.writes.some(({ key }) => key === keys.legacySnapshotKey)).toBe(false);
    expect(new Set([...redis.evalKeys[0]!, ...redis.persistences[0]!.watchedKeys[0]!].map(redisSlot)).size).toBe(1);
    await provider.destroy();
  });

  // generation 迁移可以读旧 fence，但所有 set 只落受控的新键。
  test("active generation 双读后只写新键", async () => {
    const redis = new RedisClusterDouble();
    const keys = buildRedisSessionKeys("tenant:legacy");
    redis.seedString(keys.legacyActiveGenerationKey!, "gen-legacy");

    expect(await getOrCreateActiveGeneration(redis as never, "tenant:legacy")).toBe("gen-legacy");
    expect(redis.stringWrites).toEqual([{ key: keys.activeGenerationKey, value: "gen-legacy", mode: "NX" }]);
  });
});
