import type { SnapshotPersistConfig } from "../../persist/snapshot-config";

type MessageListener = (channel: Buffer | string, message: Buffer) => void;

type ErrorListener = () => void;

export class SubscriberDouble {
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

  multi(): {
    set(key: string, value: Buffer, expiryMode?: string, seconds?: number): unknown;
    exec(): Promise<unknown | null>;
  } {
    let pending: { key: string; value: Buffer; ttlSeconds?: number } | null = null;
    const transaction = {
      set: (key: string, value: Buffer, expiryMode?: string, seconds?: number) => {
        pending = { key, value, ttlSeconds: expiryMode === "EX" ? seconds : undefined };
        return transaction;
      },
      exec: () => {
        if (!pending || this.watchedVersion === null || this.redis.shouldConflict(this.watchedVersion)) {
          this.watchedVersion = null;
          return Promise.resolve(null);
        }
        this.redis.writeStored(pending.key, pending.value, pending.ttlSeconds);
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

export class RedisDouble {
  readonly published: Array<{ channel: string; value: Buffer }> = [];
  readonly sets: Array<{ key: string; value: Buffer; ttlSeconds?: number }> = [];
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

  writeStored(key: string, value: Buffer, ttlSeconds?: number): void {
    this.sets.push({ key, value: Buffer.from(value), ttlSeconds });
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
    // 模拟真实 Redis：发布同步扇出到所有已连接 subscriber（含发布进程自身的订阅，
    // 即 SP-A6 自环过滤要处理的路径）。
    for (const subscriber of this.subscribers) {
      subscriber.emitMessage(channel, value);
    }
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

export const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

export const nextMicrotask = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 测试用快照参数：默认值与 agent-runtime manifest 的声明默认值同值，按用例覆盖单字段。
 *
 * provider 现在要求显式传入这一组参数（F1）：生产值由宿主装配投影、经
 * `ChatChannelDependencies.snapshotPersist` 装入 DocManager，包内不再保留默认值——
 * 默认值的唯一真相是 `envDefinitions` 声明。
 */
export function snapshotConfig(overrides: Partial<SnapshotPersistConfig> = {}): SnapshotPersistConfig {
  return { intervalMs: 2000, idleMs: 500, ttlSeconds: 604800, ...overrides };
}
