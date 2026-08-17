// packages/acp-server/src/__tests__/doc-manager.test.ts
import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { DocManager } from "../state/doc-manager";

// ── 最小 Redis fake（仅覆盖 doc-manager Redis 恢复分支所需方法）──

/** 可被 multi().set().exec() 链式调用的最小持久化事务 */
class FakePersistence {
  constructor(private readonly stored: Buffer | null) {}
  watch(): Promise<"OK"> {
    return Promise.resolve("OK");
  }
  unwatch(): Promise<"OK"> {
    return Promise.resolve("OK");
  }
  getBuffer(): Promise<Buffer | null> {
    return Promise.resolve(this.stored ? Buffer.from(this.stored) : null);
  }
  multi(): {
    set(key: string, value: Buffer): { exec(): Promise<[unknown]> };
  } {
    return {
      set: () => ({
        exec: () => Promise.resolve([null as unknown]),
      }),
    };
  }
  disconnect(): void {}
}

/** 订阅连接最小 fake：createRedisProvider 只注册监听，不实际收发 */
class FakeSubscriber {
  on(): this {
    return this;
  }
  off(): this {
    return this;
  }
  disconnect(): void {}
}

class FakeRedis {
  constructor(private readonly stored: Buffer | null) {}
  getBuffer(): Promise<Buffer | null> {
    return Promise.resolve(this.stored ? Buffer.from(this.stored) : null);
  }
  publish(): Promise<number> {
    return Promise.resolve(1);
  }
  duplicate(): FakePersistence | FakeSubscriber {
    // createRedisProvider 先 duplicate 持久化连接，再 duplicate 订阅连接
    return new FakePersistence(this.stored);
  }
  disconnect(): void {}
}

// ── 测试辅助 ──

/** 等待 setImmediate（及更早排队的 microtask）执行完毕 */
function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** 构造一个含进行中 turn 状态的 Session Doc 快照（meta.loading 非空） */
function buildLoadingSnapshot(): Buffer {
  const ydoc = new Y.Doc();
  const meta = ydoc.getMap("meta");
  meta.set("status", "loading");
  meta.set("loading", { kind: "session/respond", label: "Agent is thinking...", since: Date.now() });
  meta.set("acpSessionId", "ses_test");
  ydoc.getArray("messages");
  return Buffer.from(Y.encodeStateAsUpdate(ydoc));
}

const docsToDestroy: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docsToDestroy.splice(0)) {
    try {
      doc.destroy();
    } catch {
      /* ignore */
    }
  }
});

// 回归：缓存命中（前端刷新/多标签页重连）时保留进行中 turn 的 loading，
// 否则前端刷新后无法从 Y.Doc 恢复 cancel 按钮与输入禁用态
test("openSession keeps loading when the session doc is already cached", async () => {
  const manager = new DocManager({ onLog: () => {} });
  const first = await manager.openSession("user_1", "agent_1", "rcs_1");
  docsToDestroy.push(first.ydoc);

  // 模拟聚合层 user_message_chunk 写入的进行中 turn 状态
  first.ydoc.getMap("meta").set("loading", {
    kind: "session/respond",
    label: "Agent is thinking...",
    since: Date.now(),
  });

  // 再次打开同一会话（等价于前端刷新后的 WS 重连）
  const reopened = await manager.openSession("user_1", "agent_1", "rcs_1");
  docsToDestroy.push(reopened.ydoc);

  expect(reopened).toBe(first);
  expect(reopened.ydoc.getMap("meta").get("loading")).not.toBeNull();
});

// 新创建的 Session Doc 初始不携带 loading
test("openSession creates a fresh session doc without loading", async () => {
  const manager = new DocManager({ onLog: () => {} });
  const doc = await manager.openSession("user_1", "agent_1", "rcs_2");
  docsToDestroy.push(doc.ydoc);

  expect(doc.ydoc.getMap("meta").get("loading")).toBeNull();
  expect(doc.ydoc.getMap("meta").get("status")).toBe("idle");
});

// 防御行为保留：Redis 恢复分支（服务端重启后首次打开）必须清除残留 loading，
// 否则已死 turn 的 loading 会在 agent 新进程下永久卡住前端
test("openSession clears stale loading when restoring from redis", async () => {
  const redis = new FakeRedis(buildLoadingSnapshot());
  const manager = new DocManager({
    getRedis: () => redis as never,
    onLog: () => {},
  });

  const doc = await manager.openSession("user_1", "agent_1", "rcs_3");
  docsToDestroy.push(doc.ydoc);

  // Redis 快照恢复为 microtask，清除动作在 setImmediate（macrotask）中执行
  await flushMacrotask();

  expect(doc.ydoc.getMap("meta").get("loading")).toBeNull();
});
