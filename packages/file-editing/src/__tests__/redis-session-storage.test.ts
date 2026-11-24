import { expect, test } from "bun:test";
import { createRedisEditingSessionStorage, type EditingRedisPort } from "../server";
import type { EditingSessionRecord } from "../server/session-state";

/** Redis protocol fake keeps lease ownership observable without creating a Redis connection. */
class LeaseRedis implements EditingRedisPort {
  values = new Map<string, string>();
  releases = 0;
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string, ...args: (string | number)[]) {
    if (args.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }
  async eval(script: string, numKeys: number, ...args: (string | number)[]) {
    const keys = args.slice(0, numKeys).map(String);
    const values = args.slice(numKeys).map(String);
    if (script.includes("lease:release")) {
      if (this.values.get(keys[0] ?? "") !== values[0]) return 0;
      this.values.delete(keys[0] ?? "");
      this.releases += 1;
      return 1;
    }
    if (script.includes("lease:assert") || script.includes("lease:renew"))
      return this.values.get(keys[0] ?? "") === values[0] ? 1 : 0;
    throw new Error("Unexpected Redis script");
  }
}

function storedSession(redis: LeaseRedis, lists: Record<string, unknown>) {
  const record: EditingSessionRecord = {
    id: "session",
    scope: { organizationId: "org", userId: "user", environmentId: "env" },
    path: "a.docx",
    documentKey: "doc",
    fileType: "docx",
    baselineVersion: "v1",
    version: "v1",
    state: "editing",
    conflict: false,
    lastSavedAt: null,
    createdAt: 1,
    expiresAt: Date.now() + 100000,
    hardExpiresAt: Date.now() + 100000,
    revoked: false,
    terminal: false,
    requests: [],
    completed: [],
  };
  const prefix = "fenix:file-editing:v1:{file-editing}";
  const key = `${prefix}:session:org:user:env:session`;
  redis.values.set(`${prefix}:index:session`, key);
  redis.values.set(key, JSON.stringify({ ...record, ...lists }));
}

// Redis Lua 会把空列表重新编码为空对象，恢复读取时必须继续提供列表契约。
test.each(["completed", "requests"] as const)("restores the empty Redis %s array after Lua encoding", async (field) => {
  const redis = new LeaseRedis();
  storedSession(redis, { [field]: {} });
  const storage = createRedisEditingSessionStorage(redis);
  expect((await storage.get("session"))?.[field]).toEqual([]);
  await storage.dispose();
});

// 已有成功回执必须原样保留，不能在修复空列表时清掉有效记录。
test("preserves populated Redis receipt and request arrays", async () => {
  const redis = new LeaseRedis();
  const completed = [{ id: "save", digest: "digest", final: false, createdAt: 1 }];
  const requests = [{ id: "save", opId: "operation", createdAt: 1 }];
  storedSession(redis, { completed, requests });
  const storage = createRedisEditingSessionStorage(redis);
  expect(await storage.get("session")).toMatchObject({ completed, requests });
  await storage.dispose();
});

// 只有 Lua 的空对象可还原为空列表，其他坏数据应明确报错而非伪装成空回执。
test.each([null, { invalid: 1 }, "invalid"])("rejects malformed Redis receipt lists %j", async (completed) => {
  const redis = new LeaseRedis();
  storedSession(redis, { completed });
  const storage = createRedisEditingSessionStorage(redis);
  await expect(storage.get("session")).rejects.toMatchObject({ code: "unavailable" });
  await storage.dispose();
});

// 租约释放必须验证持有者，不能误删其他副本续接的租约。
test("Redis lease loss fails closed and cannot release a successor lease", async () => {
  const redis = new LeaseRedis();
  const storage = createRedisEditingSessionStorage(redis);
  await storage.withLease("session", async (lease) => {
    await lease.assertHeld();
    redis.values.set(lease.key, "another-holder");
    await expect(lease.assertHeld()).rejects.toMatchObject({ code: "busy" });
  });
  expect(redis.releases).toBe(0);
  expect([...redis.values.values()]).toEqual(["another-holder"]);
  await storage.dispose();
});

// 不同服务共享同一 Redis 租约键时只能顺序处理同一会话。
test("Redis session leases serialize across injected storage instances", async () => {
  const redis = new LeaseRedis();
  const first = createRedisEditingSessionStorage(redis);
  const second = createRedisEditingSessionStorage(redis);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const a = first.withLease("session", async () => {
    events.push("first");
    await gate;
    events.push("first-done");
  });
  await Bun.sleep(5);
  const b = second.withLease("session", async () => {
    events.push("second");
  });
  await Bun.sleep(10);
  expect(events).toEqual(["first"]);
  release();
  await Promise.all([a, b]);
  expect(events).toEqual(["first", "first-done", "second"]);
});
