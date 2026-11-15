import { describe, expect, test } from "bun:test";
import { TemporaryEnvironmentLifecycle } from "../services/temporary-environment-lifecycle";

function fixture() {
  let now = 1_000;
  let expiresAt = new Date(2_000);
  const stopped: string[] = [];
  const lifecycle = new TemporaryEnvironmentLifecycle({
    markReclaimed: async () => {},
    now: () => now,
    read: async () => ({ id: "temp-test", expiresAt }),
    writeExpiry: async (_id, value) => {
      expiresAt = value;
    },
    stop: async (id) => {
      stopped.push(id);
    },
  });
  return {
    lifecycle,
    stopped,
    setTime: (value: number) => {
      now = value;
    },
    expiry: () => expiresAt,
  };
}

describe("临时环境硬期限", () => {
  // 仅实际停止成功后确认本轮回收，已确认的历史环境不再次停止。
  test("expiry persists reclamation only after stop is confirmed and skips completed work", async () => {
    let reclaimedAt: Date | null = null;
    let stops = 0;
    let finishStop!: () => void;
    let startedStop!: () => void;
    const stopping = new Promise<void>((resolve) => {
      startedStop = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const lifecycle = new TemporaryEnvironmentLifecycle({
      now: () => 2_000,
      read: async () => ({ id: "temp-confirm", expiresAt: new Date(1_000), expiryReclaimedAt: reclaimedAt }),
      writeExpiry: async () => {},
      markReclaimed: async (_id, _expiry, value) => {
        reclaimedAt = value;
      },
      stop: async () => {
        stops++;
        startedStop();
        await stopped;
      },
    });
    const expired = lifecycle.expire("temp-confirm");
    await stopping;
    expect(reclaimedAt).toBeNull();
    finishStop();
    await expired;
    expect(reclaimedAt).toEqual(new Date(2_000));
    await lifecycle.expire("temp-confirm");
    expect(stops).toBe(1);
  });
  // 确认写入失败时仍需补偿，不能因内存里已停止而丢失持久待办。
  test("a failed reclamation write remains retryable", async () => {
    let reclaimedAt: Date | null = null;
    let attempts = 0;
    const lifecycle = new TemporaryEnvironmentLifecycle({
      now: () => 2_000,
      read: async () => ({ id: "temp-confirm", expiresAt: new Date(1_000), expiryReclaimedAt: reclaimedAt }),
      writeExpiry: async () => {},
      markReclaimed: async (_id, _expiry, value) => {
        if (++attempts === 1) throw new Error("confirmation write failed");
        reclaimedAt = value;
      },
      stop: async () => {},
    });
    await expect(lifecycle.expire("temp-confirm")).rejects.toThrow("confirmation write failed");
    expect(reclaimedAt).toBeNull();
    await lifecycle.expire("temp-confirm");
    expect(reclaimedAt).toEqual(new Date(2_000));
  });
  // 到期取消执行并严格回收，不能因请求仍在运行而豁免。
  test("expiry aborts active work and stops the environment", async () => {
    const f = fixture();
    const lease = await f.lifecycle.acquire("temp-test");
    f.setTime(2_000);
    await f.lifecycle.expire("temp-test");
    expect(lease.signal.aborted).toBe(true);
    expect(f.stopped).toEqual(["temp-test"]);
    await expect(f.lifecycle.acquire("temp-test")).rejects.toMatchObject({
      statusCode: 410,
      code: "ENVIRONMENT_EXPIRED",
    });
    lease.release();
  });
  // 取消已送达后不再保留操作登记，严格停止失败也不等待 Agent 的终态回执。
  test.each([false, true])("expiry releases cancellation registrations when stop fails=%s", async (stopFails) => {
    let now = 1_000;
    const lifecycle = new TemporaryEnvironmentLifecycle({
      now: () => now,
      read: async () => ({ id: "temp-test", expiresAt: new Date(2_000) }),
      markReclaimed: async () => {},
      writeExpiry: async () => {},
      stop: async () => {
        if (stopFails) throw new Error("stop unconfirmed");
      },
    });
    const operations = Reflect.get(lifecycle, "operations") as ReadonlyMap<string, ReadonlySet<AbortController>>;
    const leases = await Promise.all([lifecycle.acquire("temp-test"), lifecycle.acquire("temp-test")]);
    const registered = operations.get("temp-test");
    expect(registered?.size).toBe(2);
    now = 2_000;
    if (stopFails) await expect(lifecycle.expire("temp-test")).rejects.toThrow("stop unconfirmed");
    else await lifecycle.expire("temp-test");
    expect(leases.every((lease) => lease.signal.aborted)).toBe(true);
    expect(operations.has("temp-test")).toBe(false);
    expect(registered?.size).toBe(0);
    for (const lease of leases) lease.release();
  });
  // 旧请求迟到释放只能影响旧批次，续期后新请求仍须在新期限收到取消。
  test("late lease release preserves renewed cancellation registrations", async () => {
    const f = fixture();
    const old = await f.lifecycle.acquire("temp-test");
    f.setTime(2_000);
    await f.lifecycle.expire("temp-test");
    await f.lifecycle.renew("temp-test", 3, async () => {});
    const current = await f.lifecycle.acquire("temp-test");
    old.release();
    old.release();
    expect(current.signal.aborted).toBe(false);
    f.setTime(5_000);
    await f.lifecycle.expire("temp-test");
    expect(current.signal.aborted).toBe(true);
    current.release();
  });
  // 删除记录不能让失去终态回执的旧请求永久留在取消登记中。
  test("expiry releases registrations after the environment record is deleted", async () => {
    let exists = true;
    const lifecycle = new TemporaryEnvironmentLifecycle({
      now: () => 1_000,
      read: async () => (exists ? { id: "temp-test", expiresAt: new Date(2_000) } : undefined),
      markReclaimed: async () => {},
      writeExpiry: async () => {},
      stop: async () => {
        throw new Error("Deleted environments have already stopped their runtimes");
      },
    });
    const lease = await lifecycle.acquire("temp-test");
    const operations = Reflect.get(lifecycle, "operations") as ReadonlyMap<string, ReadonlySet<AbortController>>;
    expect(operations.get("temp-test")?.size).toBe(1);
    exists = false;
    await lifecycle.expire("temp-test");
    expect(lease.signal.aborted).toBe(true);
    expect(operations.has("temp-test")).toBe(false);
    lease.release();
  });
  // 旧扫描发现过期后，真正停止前必须重读续期后的截止时间。
  test("renew wins over a stale expiry candidate", async () => {
    const f = fixture();
    f.setTime(2_000);
    await f.lifecycle.renew("temp-test", 3, async () => {});
    await f.lifecycle.expire("temp-test");
    expect(f.stopped).toEqual([]);
    expect(f.expiry().getTime()).toBe(5_000);
  });
  // stop 已经开始时，续期等待停止结果再恢复，旧 stop 不能落到新 runtime。
  test("renew waits for an in-flight stop before activation", async () => {
    let finishStop!: () => void;
    let didStartStop!: () => void;
    const startedStop = new Promise<void>((resolve) => {
      didStartStop = resolve;
    });
    const stopDone = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    let expiresAt = new Date(0);
    const events: string[] = [];
    const lifecycle = new TemporaryEnvironmentLifecycle({
      now: () => 1_000,
      read: async () => ({ id: "temp-test", expiresAt }),
      markReclaimed: async () => {},
      writeExpiry: async (_id, value) => {
        expiresAt = value;
        events.push("renew");
      },
      stop: async () => {
        didStartStop();
        await stopDone;
        events.push("stopped");
      },
    });
    const expiry = lifecycle.expire("temp-test");
    await startedStop;
    const renewed = lifecycle.renew("temp-test", 5, async () => {
      events.push("started");
    });
    expect(events).toEqual([]);
    finishStop();
    await Promise.all([expiry, renewed]);
    expect(events).toEqual(["stopped", "renew", "started"]);
  });
  // 并发准入拒绝不会撤销已持久化的新期限，调用方可原身份重试。
  test("activation failure preserves the renewed expiry", async () => {
    const f = fixture();
    await expect(
      f.lifecycle.renew("temp-test", 5, async () => {
        throw new Error("quota");
      }),
    ).rejects.toThrow("quota");
    expect(f.expiry().getTime()).toBe(6_000);
  });
  // renew 不取消期限内正在执行的工作，已签发操作等待新的硬期限。
  test("active leases survive renewal and abort at the new expiry", async () => {
    const f = fixture();
    const lease = await f.lifecycle.acquire("temp-test");
    await f.lifecycle.renew("temp-test", 5, async () => {});
    f.setTime(2_000);
    await f.lifecycle.expire("temp-test");
    expect(lease.signal.aborted).toBe(false);
    f.setTime(6_000);
    await f.lifecycle.expire("temp-test");
    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });
});
