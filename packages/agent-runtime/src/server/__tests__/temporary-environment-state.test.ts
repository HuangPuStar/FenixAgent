import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { markTemporaryEnvironmentReclaimed } from "../repositories/environment";
import {
  bindTemporaryEnvironmentStop,
  recoverExpiredTemporaryEnvironments,
  scheduleTemporaryEnvironmentExpiry,
  startTemporaryEnvironmentMaintenance,
  stopTemporaryEnvironmentMaintenance,
  temporaryEnvironmentLifecycle,
} from "../services/temporary-environment-state";
import { initializeAgentRuntimeModuleConfig, stubEnvironmentRepo } from "../testing";

/** 测试只替换数据库连接与管理仓储，持久待办 SQL 使用生产实现。 */
type ExpiryRow = { id: string; expiresAt: Date; expiryReclaimedAt?: Date | null };
const databases: Database[] = [];
function persist(rows: Map<string, ExpiryRow>, beforeQuery?: () => Promise<void>) {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(
    "CREATE TABLE environment (id TEXT PRIMARY KEY, expires_at TEXT, expiry_reclaimed_at TEXT, updated_at TEXT)",
  );
  const insert = (row: ExpiryRow) =>
    database.run("INSERT OR IGNORE INTO environment VALUES (?, ?, ?, NULL)", [
      row.id,
      row.expiresAt.toISOString(),
      row.expiryReclaimedAt?.toISOString() ?? null,
    ]);
  for (const row of rows.values()) insert(row);
  const client = {
    query: async (query: { text: string; rowMode?: string }, params: Array<string | number | null>) => {
      await beforeQuery?.();
      const result =
        query.rowMode === "array"
          ? database.query(query.text).values(...params)
          : database.query(query.text).all(...params);
      for (const row of rows.values()) {
        const stored = database
          .query("SELECT expiry_reclaimed_at AS reclaimed FROM environment WHERE id = ?")
          .get(row.id) as { reclaimed: string | null } | null;
        if (stored) row.expiryReclaimedAt = stored.reclaimed ? new Date(stored.reclaimed) : null;
      }
      return { rows: result };
    },
  };
  stubDb(drizzle({ client: client as unknown as Pool }));
  stubEnvironmentRepo({
    getById: async (id: string) => {
      const row = rows.get(id);
      if (row) insert(row);
      return row;
    },
    update: async (id: string, patch: { expiresAt: Date; expiryReclaimedAt: Date | null }) => {
      const row = rows.get(id);
      if (row) {
        row.expiresAt = patch.expiresAt;
        row.expiryReclaimedAt = patch.expiryReclaimedAt;
        database.run("UPDATE environment SET expires_at = ?, expiry_reclaimed_at = ? WHERE id = ?", [
          row.expiresAt.toISOString(),
          row.expiryReclaimedAt?.toISOString() ?? null,
          id,
        ]);
      }
      return Boolean(row);
    },
  });
}

async function waitForStop(stopped: string[], id: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!stopped.includes(id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(stopped).toContain(id);
}
afterEach(() => {
  stopTemporaryEnvironmentMaintenance();
  for (const database of databases.splice(0)) database.close();
  resetAllStubs();
});

// 启动恢复查询尚未返回时也允许关闭，迟到结果不能重新开启维护或注册到期句柄。
test("shutdown during initial deadline restoration cannot restart maintenance", async () => {
  initializeAgentRuntimeModuleConfig();
  let finishRead!: () => void;
  let markReading!: () => void;
  const reading = new Promise<void>((resolve) => {
    markReading = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  persist(
    new Map([["temp-late-startup", { id: "temp-late-startup", expiresAt: new Date(Date.now() + 60_000) }]]),
    async () => {
      markReading();
      await gate;
    },
  );
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const startup = startTemporaryEnvironmentMaintenance();
    await reading;
    stopTemporaryEnvironmentMaintenance();
    finishRead();
    await startup;
    expect(timer.mock.calls).toHaveLength(0);
  } finally {
    timer.mockRestore();
  }
});

// 已确认完成的历史环境不再进入启动补偿或创建 coordinator entry。
test("startup excludes already confirmed historical environments from reclamation", async () => {
  initializeAgentRuntimeModuleConfig();
  persist(
    new Map(
      Array.from({ length: 100 }, (_, index) => [
        `temp-old-${index}`,
        { id: `temp-old-${index}`, expiresAt: new Date(0), expiryReclaimedAt: new Date(1) },
      ]),
    ),
  );
  const stopped: string[] = [];
  bindTemporaryEnvironmentStop(async (id) => {
    stopped.push(id);
  });
  await startTemporaryEnvironmentMaintenance();
  expect(stopped).toEqual([]);
});

// 失败待办保存在数据库中，清空当前控制面调度后再次启动仍会补偿。
test("startup recovers a persisted failed reclamation and then excludes its completed history", async () => {
  initializeAgentRuntimeModuleConfig();
  const rows = new Map<string, ExpiryRow>([["temp-restart", { id: "temp-restart", expiresAt: new Date(0) }]]);
  persist(rows);
  let attempts = 0;
  bindTemporaryEnvironmentStop(async () => {
    if (++attempts === 1) throw new Error("node unavailable");
  });
  await startTemporaryEnvironmentMaintenance();
  expect(rows.get("temp-restart")?.expiryReclaimedAt).toBeNull();
  stopTemporaryEnvironmentMaintenance();
  await startTemporaryEnvironmentMaintenance();
  expect(attempts).toBe(2);
  expect(rows.get("temp-restart")?.expiryReclaimedAt).toBeInstanceOf(Date);
  await recoverExpiredTemporaryEnvironments();
  expect(attempts).toBe(2);
});

// 单项长期失败不应阻塞后续分页，续期也不能影响本轮其他环境。
test("recovery pages past persistent failures and retains only unconfirmed work", async () => {
  initializeAgentRuntimeModuleConfig();
  const rows = new Map<string, ExpiryRow>(
    Array.from({ length: 205 }, (_, index) => {
      const id = `temp-page-${String(index).padStart(3, "0")}`;
      return [id, { id, expiresAt: new Date(0) }];
    }),
  );
  persist(rows);
  const stopped: string[] = [];
  bindTemporaryEnvironmentStop(async (id) => {
    stopped.push(id);
    if (id === "temp-page-000") throw new Error("unconfirmed");
  });
  await startTemporaryEnvironmentMaintenance();
  expect(stopped.length).toBe(205);
  expect(rows.get("temp-page-000")?.expiryReclaimedAt).toBeNull();
  expect(rows.get("temp-page-204")?.expiryReclaimedAt).toBeInstanceOf(Date);
  await recoverExpiredTemporaryEnvironments();
  expect(stopped.length).toBe(206);
  expect(stopped[205]).toBe("temp-page-000");
});

// 兜底固定为十分钟，停止维护后不能再安排下一轮任务。
test("durable recovery uses a ten minute wakeup", async () => {
  initializeAgentRuntimeModuleConfig();
  persist(new Map());
  bindTemporaryEnvironmentStop(async () => {});
  const timer = spyOn(globalThis, "setTimeout");
  try {
    await startTemporaryEnvironmentMaintenance();
    expect(timer.mock.calls.map((call) => call[1])).toContain(600_000);
  } finally {
    timer.mockRestore();
  }
});

// 关闭发生在严格停止等待期间时，迟到的补偿结果不能重新安排后台任务。
test("shutdown during durable reclamation does not resurrect its timer", async () => {
  initializeAgentRuntimeModuleConfig();
  persist(new Map([["temp-shutdown", { id: "temp-shutdown", expiresAt: new Date(0) }]]));
  let finishStop!: () => void;
  let markStopping!: () => void;
  const started = new Promise<void>((resolve) => {
    markStopping = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  bindTemporaryEnvironmentStop(async () => {
    markStopping();
    await stopped;
  });
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const startup = startTemporaryEnvironmentMaintenance();
    await started;
    stopTemporaryEnvironmentMaintenance();
    finishStop();
    await startup;
    expect(timer.mock.calls.map((call) => call[1])).not.toContain(600_000);
  } finally {
    timer.mockRestore();
  }
});

// 关闭后迟到的期限读取不能重新注册精确到期 timer。
test("shutdown while a stale candidate is re-read cannot schedule its renewed expiry", async () => {
  initializeAgentRuntimeModuleConfig();
  persist(new Map([["temp-late-read", { id: "temp-late-read", expiresAt: new Date(0) }]]));
  let finishRead!: () => void;
  let markReading!: () => void;
  const reading = new Promise<void>((resolve) => {
    markReading = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  stubEnvironmentRepo({
    getById: async () => {
      markReading();
      await gate;
      return { id: "temp-late-read", expiresAt: new Date(Date.now() + 60_000) };
    },
  });
  bindTemporaryEnvironmentStop(async () => {
    throw new Error("must not stop renewed work");
  });
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const startup = startTemporaryEnvironmentMaintenance();
    await reading;
    stopTemporaryEnvironmentMaintenance();
    finishRead();
    await startup;
    expect(timer.mock.calls).toHaveLength(0);
  } finally {
    timer.mockRestore();
  }
});

// 回收候选被选中后发生续期，锁内重读必须跳过旧期限；续期清除旧确认。
test("renew clears the persisted confirmation and a stale recovery candidate cannot stop it", async () => {
  initializeAgentRuntimeModuleConfig();
  const row: ExpiryRow = { id: "temp-reset", expiresAt: new Date(0), expiryReclaimedAt: new Date(1) };
  persist(new Map([[row.id, row]]));
  const stopped: string[] = [];
  bindTemporaryEnvironmentStop(async (id) => {
    stopped.push(id);
  });
  await startTemporaryEnvironmentMaintenance();
  await temporaryEnvironmentLifecycle.renew(row.id, 60, async () => {});
  expect(row.expiryReclaimedAt).toBeNull();
  expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  await markTemporaryEnvironmentReclaimed(row.id, new Date(0), new Date());
  expect(row.expiryReclaimedAt).toBeNull();
  await temporaryEnvironmentLifecycle.expire(row.id);
  await recoverExpiredTemporaryEnvironments();
  expect(stopped).toEqual([]);
});

// 启动恢复不能缩短调用方已取得的有效期，也不能改写普通环境的通用期限。
test("startup preserves persisted temporary and ordinary environment deadlines", async () => {
  initializeAgentRuntimeModuleConfig();
  const deadline = Date.now() + 60_000;
  const rows = new Map([
    ["temp-preserved", { id: "temp-preserved", expiresAt: new Date(deadline) }],
    ["env-ordinary", { id: "env-ordinary", expiresAt: new Date(deadline) }],
  ]);
  persist(rows);
  bindTemporaryEnvironmentStop(async () => {});
  await startTemporaryEnvironmentMaintenance();
  expect(rows.get("temp-preserved")?.expiresAt.getTime()).toBe(deadline);
  expect(rows.get("env-ordinary")?.expiresAt.getTime()).toBe(deadline);
  const lease = await temporaryEnvironmentLifecycle.acquire("temp-preserved");
  expect(lease.signal.aborted).toBe(false);
  lease.release();
});

// 重启后未续期的环境仍须在原期限取消活动执行并停止，不能只依赖新请求的到期校验。
test("startup restores the original deadline and cancels resumed work at expiry", async () => {
  initializeAgentRuntimeModuleConfig();
  const deadline = Date.now() + 300;
  const rows = new Map([
    ["temp-restored", { id: "temp-restored", expiresAt: new Date(deadline) }],
    ["env-ordinary", { id: "env-ordinary", expiresAt: new Date(deadline) }],
    ["temp-historical", { id: "temp-historical", expiresAt: new Date(0), expiryReclaimedAt: new Date(1) }],
  ]);
  persist(rows);
  const stopped: string[] = [];
  bindTemporaryEnvironmentStop(async (id) => {
    stopped.push(id);
  });
  await startTemporaryEnvironmentMaintenance();
  const lease = await temporaryEnvironmentLifecycle.acquire("temp-restored");
  try {
    await waitForStop(stopped, "temp-restored");
    expect(lease.signal.aborted).toBe(true);
    expect(stopped).toEqual(["temp-restored"]);
    expect(rows.get("temp-restored")?.expiresAt.getTime()).toBe(deadline);
    await expect(temporaryEnvironmentLifecycle.acquire("temp-restored")).rejects.toMatchObject({ statusCode: 410 });
  } finally {
    lease.release();
  }
});

// 恢复后的旧到期任务仍须服从显式续期，不能按重启前期限提前停止。
test("renew replaces a restored deadline without cancelling active work early", async () => {
  initializeAgentRuntimeModuleConfig();
  const deadline = Date.now() + 200;
  const rows = new Map([["temp-renewed", { id: "temp-renewed", expiresAt: new Date(deadline) }]]);
  persist(rows);
  const stopped: string[] = [];
  bindTemporaryEnvironmentStop(async (id) => {
    stopped.push(id);
  });
  await startTemporaryEnvironmentMaintenance();
  const lease = await temporaryEnvironmentLifecycle.acquire("temp-renewed");
  try {
    const renewed = await temporaryEnvironmentLifecycle.renew("temp-renewed", 1, async () => {});
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 50));
    expect(stopped).toEqual([]);
    expect(lease.signal.aborted).toBe(false);
    await waitForStop(stopped, "temp-renewed");
    expect(stopped).toEqual(["temp-renewed"]);
    expect(lease.signal.aborted).toBe(true);
    expect(rows.get("temp-renewed")?.expiresAt.getTime()).toBe(renewed.getTime());
  } finally {
    lease.release();
  }
});

// 活动期限成功后移出补偿集合，失败继续重试，续期后新一轮到期仍应回收。
test("maintenance only retries failed stops and schedules a renewed deadline again", async () => {
  initializeAgentRuntimeModuleConfig();
  const rows = new Map<string, { id: string; expiresAt: Date }>();
  persist(rows);
  const attempts = new Map<string, number>();
  bindTemporaryEnvironmentStop(async (id) => {
    const count = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, count);
    if (id === "temp-retry" && count === 1) throw new Error("stop unconfirmed");
  });
  await startTemporaryEnvironmentMaintenance();
  for (const id of ["temp-success", "temp-retry"]) {
    rows.set(id, { id, expiresAt: new Date(0) });
    scheduleTemporaryEnvironmentExpiry(id, new Date(0));
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await recoverExpiredTemporaryEnvironments();
  expect(attempts.get("temp-success")).toBe(1);
  expect(attempts.get("temp-retry")).toBe(2);
  await temporaryEnvironmentLifecycle.renew("temp-success", 1, async () => {});
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(attempts.get("temp-success")).toBe(2);
  expect(attempts.get("temp-retry")).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(attempts.get("temp-success")).toBe(2);
  expect(attempts.get("temp-retry")).toBe(2);
});

// 时钟回拨或长 TTL 的分段 timer 提前唤醒时，仍要安排真实期限而不是丢失回收。
test("an early wakeup rechecks and schedules the persisted future deadline", async () => {
  initializeAgentRuntimeModuleConfig();
  persist(new Map([["temp-future", { id: "temp-future", expiresAt: new Date(Date.now() + 300) }]]));
  let stopped = 0;
  bindTemporaryEnvironmentStop(async () => {
    stopped++;
  });
  await startTemporaryEnvironmentMaintenance();
  scheduleTemporaryEnvironmentExpiry("temp-future", new Date(0));
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(stopped).toBe(1);
});
