import { expect, test } from "bun:test";
import { createRedisEditingSessionStorage, type EditingRedisPort } from "../server";

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
