// ── SchedulerService 执行入口验证 ──
// R36 修复回归测试（自旧 task.ts 调度器迁移到 v2 SchedulerService）：
// 任务从 DB 删除后，execute 发现任务不存在时必须清理残留 job 并返回 failed，
// 且不写执行日志、不遗留 running 状态（否则同一任务会被永久误判为 running）。
// G2a 追加：执行入口的关联 ID（§7）——HTTP/manual 透传触发请求的 requestId，cron 入口自建并与
// 创建 job 的请求上下文隔离，两者都经显式输入 `TaskExecInput.requestId` 交给执行器。
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { requestAls } from "@fenix/logger";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import type { ScheduledTaskV2Row } from "../server/repositories/task-v2";
import { SchedulerService } from "../server/services/scheduler/index";
import { resetStubsWithDb } from "./db-stub";

// 任务查询（getById 链：select().from().where().limit()）返回给定行集合
function stubTaskLookup(rows: unknown[]) {
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  });
}

// 完整调度链路的替身：任务查询、执行日志写入（insert().values().returning()）与任务状态更新
// （update().set().where().returning()）——execute 与 schedule 都会写任务状态，缺一条链路就会抛错
function stubSchedulerDb(rows: ScheduledTaskV2Row[]) {
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  });
}

// 调度器实际读取的字段：id / enabled / cron / timezone / type
function scheduledTaskRow(overrides: Partial<ScheduledTaskV2Row> = {}): ScheduledTaskV2Row {
  return {
    id: "task-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "sync",
    description: null,
    // 秒级字段只为让 cron 用例在 1s 内触发；生产任务的 cron 由服务层限定为 5 字段
    cron: "* * * * * *",
    timezone: null,
    enabled: true,
    timeoutSeconds: 30,
    agentId: null,
    type: "http",
    definition: { url: "https://scheduler.invalid/hook" },
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("SchedulerService stale job cleanup", () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    // 每次测试新建实例，避免 runningTasks/activeJobs 跨测试泄漏
    scheduler = new SchedulerService();
    resetStubsWithDb();
  });

  afterEach(() => {
    scheduler.stop();
    resetAllStubs();
  });

  // 任务已从 DB 删除时，execute 应返回 failed（task not found）且不写任何执行日志
  test("returns failed and skips execution log when task is missing from DB", async () => {
    const insertSpy = mock(() => Promise.resolve([]));
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: insertSpy,
        }),
      }),
    });

    const result = await scheduler.execute("task-1", "cron");

    expect(result.status).toBe("failed");
    expect(result.error).toBe("task not found");
    // 任务不存在时直接 unschedule，不应产生 skipped/失败日志
    expect(insertSpy).not.toHaveBeenCalled();
  });

  // task not found 后 runningTasks 必须释放，连续执行不被误判为 previous_run_still_active
  test("releases running state so a deleted task is not permanently marked as running", async () => {
    stubTaskLookup([]);

    const first = await scheduler.execute("task-1", "cron");
    const second = await scheduler.execute("task-1", "cron");

    expect(first.error).toBe("task not found");
    // 若第一次执行后 runningTasks 未清理，第二次会走 skipped 分支而非重新查询任务
    expect(second.error).toBe("task not found");
  });
});

describe("SchedulerService 执行入口的关联 ID", () => {
  let scheduler: SchedulerService;
  // 执行器取代身：只记录调度入口交给执行器的显式输入与当时的日志上下文
  let seen: Array<{ inputRequestId?: string; alsRequestId?: string }>;
  let onExecuted: () => void;

  beforeEach(() => {
    scheduler = new SchedulerService();
    resetStubsWithDb();
    seen = [];
    onExecuted = () => {};
    // 用替身执行器替换 http 执行器：既不发起真实请求，也不需要 DB 里的任务定义有效
    scheduler.register({
      type: "http",
      async execute(input) {
        seen.push({ inputRequestId: input.requestId, alsRequestId: requestAls.getStore()?.requestId });
        onExecuted();
        return { status: "success", duration: 1 };
      },
    });
  });

  afterEach(() => {
    scheduler.stop();
    resetAllStubs();
  });

  // HTTP/manual 触发的执行必须把触发请求的 requestId 透传给执行器（显式输入，§7）
  test("透传触发请求的 requestId", async () => {
    stubSchedulerDb([scheduledTaskRow()]);

    await requestAls.run({ requestId: "req-http-1" }, () => scheduler.execute("task-1", "manual"));

    expect(seen[0]?.inputRequestId).toBe("req-http-1");
  });

  // 无上游请求的执行必须自建关联 ID，且每次执行互不相同（不能退化成空值或固定值）
  test("无请求上下文时自建互不相同的关联 ID", async () => {
    stubSchedulerDb([scheduledTaskRow()]);

    await scheduler.execute("task-1", "cron");
    await scheduler.execute("task-1", "cron");

    expect(seen).toHaveLength(2);
    expect(seen[0]?.inputRequestId).toBeString();
    expect(seen[1]?.inputRequestId).toBeString();
    expect(seen[1]?.inputRequestId).not.toBe(seen[0]?.inputRequestId);
  });

  // cron 入口自建的 ID 必须优先于继承来的 ALS 上下文：否则定时执行会关联到创建 job 的那次请求
  test("显式传入的 requestId 优先于残留的 ALS 上下文", async () => {
    stubSchedulerDb([scheduledTaskRow()]);

    await requestAls.run({ requestId: "creating-request" }, () => scheduler.execute("task-1", "cron", "run-cron-1"));

    expect(seen[0]?.inputRequestId).toBe("run-cron-1");
  });

  // cron 触发自建关联 ID，并把下游日志上下文切到同一个 ID（node-schedule 定时器继承创建 job 时的上下文）
  test("cron 触发自建关联 ID 且与创建 job 的请求上下文隔离", async () => {
    stubSchedulerDb([scheduledTaskRow()]);
    const executed = new Promise<void>((resolve) => {
      onExecuted = resolve;
    });

    // 复刻生产路径：job 在带请求上下文的入口（建任务 / 改 cron / 启用任务）创建
    requestAls.run({ requestId: "creating-request" }, () => {
      scheduler.schedule(scheduledTaskRow());
    });

    await executed;

    expect(seen[0]?.inputRequestId).toBeString();
    expect(seen[0]?.inputRequestId).not.toBe("creating-request");
    // 执行器日志所在的上下文必须与显式输入同源，否则整条执行链的日志会归到创建请求上
    expect(seen[0]?.alsRequestId).toBe(seen[0]?.inputRequestId);
  }, 5000);
});
