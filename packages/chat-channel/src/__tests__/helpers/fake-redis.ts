// packages/chat-channel/src/__tests__/helpers/fake-redis.ts
// 测试用 Redis 双：只实现 DocManager / Redis provider 实际触达的命令面。
//
// 能力：
// - 主连接：SET NX / GET / GETBUFFER / EVAL / PUBLISH / DUPLICATE / DISCONNECT；
// - 交替 duplicate：偶数次为 WATCH/MULTI 持久化连接，奇数次为 Pub/Sub 订阅连接；
// - GETBUFFER 可按键注入延迟或失败，用于复现「快照尚未水合就被读取历史」的时序；
// - 快照 CAS 只做单进程版本冲突判定，足够覆盖 provider 的 WATCH/MULTI/EXEC 路径。

type MessageListener = (channel: Buffer | string, message: Buffer) => void;
type ErrorListener = () => void;

export class FakeRedisSubscriber {
  readonly subscriptions: string[] = [];
  disconnected = false;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(private readonly onSubscribe: (channel: string) => Promise<number> = () => Promise.resolve(1)) {}

  subscribe(channel: string): Promise<number> {
    this.subscriptions.push(channel);
    return this.onSubscribe(channel);
  }

  unsubscribe(): Promise<number> {
    return Promise.resolve(0);
  }

  quit(): Promise<"OK"> {
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
    for (const listener of this.messageListeners) listener(channel, message);
  }
}

export class FakeRedisPersistence {
  disconnected = false;
  private watchedVersion: number | null = null;

  constructor(private readonly redis: FakeRedis) {}

  watch(): Promise<"OK"> {
    this.watchedVersion = this.redis.version;
    return Promise.resolve("OK");
  }

  unwatch(): Promise<"OK"> {
    this.watchedVersion = null;
    return Promise.resolve("OK");
  }

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  getBuffer(key: string): Promise<Buffer | null> {
    return this.redis.getBuffer(key);
  }

  multi(): {
    set(key: string, value: Buffer, expiryMode?: string, seconds?: number): unknown;
    exec(): Promise<unknown | null>;
  } {
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

export class FakeRedis {
  readonly subscribers: FakeRedisSubscriber[] = [];
  readonly persistences: FakeRedisPersistence[] = [];
  /** 主连接收到的 GETBUFFER 键顺序，用于断言历史读取确实在快照读取之后。 */
  readonly bufferReads: string[] = [];
  version = 0;
  private duplicateCalls = 0;
  private readonly stored = new Map<string, Buffer>();
  private readonly values = new Map<string, string>();
  private readonly bufferGates = new Map<string, Promise<void>>();
  private readonly bufferFailures = new Map<string, Error>();

  /** 注入一次性 GETBUFFER 延迟；该键的快照读取会等待 `gate` 落定。 */
  delayBuffer(key: string, gate: Promise<void>): void {
    this.bufferGates.set(key, gate);
  }

  /** 注入一次性 GETBUFFER 失败；用于验证加载失败不会被当作“无历史”。 */
  failBufferOnce(key: string, error: Error): void {
    this.bufferFailures.set(key, error);
  }

  seedActiveGeneration(rcsSessionId: string, generation: string): void {
    this.values.set(`yjs:active-generation:${rcsSessionId}`, generation);
  }

  seedSnapshot(docName: string, generation: string, update: Uint8Array): void {
    this.stored.set(`yjs:${docName}:${generation}`, Buffer.from(update));
    this.version += 1;
  }

  writeStored(key: string, value: Buffer): void {
    this.stored.set(key, Buffer.from(value));
    this.version += 1;
  }

  shouldConflict(watchedVersion: number): boolean {
    return watchedVersion !== this.version;
  }

  set(key: string, value: string, mode?: string): Promise<"OK" | null> {
    if (mode === "NX" && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve("OK");
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  getBuffer(key: string): Promise<Buffer | null> {
    this.bufferReads.push(key);
    const failure = this.bufferFailures.get(key);
    if (failure) {
      this.bufferFailures.delete(key);
      return Promise.reject(failure);
    }
    const gate = this.bufferGates.get(key);
    if (gate) {
      this.bufferGates.delete(key);
      return gate.then(() => {
        const value = this.stored.get(key);
        return value ? Buffer.from(value) : null;
      });
    }
    const value = this.stored.get(key);
    return Promise.resolve(value ? Buffer.from(value) : null);
  }

  /** provider 只在带 generation 时用 EVAL 发布；双进程扇出不参与这些用例。 */
  eval(): Promise<number> {
    return Promise.resolve(0);
  }

  publish(channel: Buffer | string, value: Buffer): Promise<number> {
    for (const subscriber of this.subscribers) subscriber.emitMessage(channel, value);
    return Promise.resolve(1);
  }

  duplicate(): FakeRedisPersistence | FakeRedisSubscriber {
    const index = this.duplicateCalls;
    this.duplicateCalls += 1;
    if (index % 2 === 0) {
      const persistence = new FakeRedisPersistence(this);
      this.persistences.push(persistence);
      return persistence;
    }
    const subscriber = new FakeRedisSubscriber();
    this.subscribers.push(subscriber);
    return subscriber;
  }

  disconnect(): void {
    /* no-op */
  }
}
