// ── SchedulerService stale job cleanup 验证 ──
// R36 修复回归测试（自旧 task.ts 调度器迁移到 v2 SchedulerService）：
// 任务从 DB 删除后，execute 发现任务不存在时必须清理残留 job 并返回 failed，
// 且不写执行日志、不遗留 running 状态（否则同一任务会被永久误判为 running）。
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SchedulerService } from "../services/scheduler/index";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

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

describe("SchedulerService stale job cleanup", () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    // 每次测试新建实例，避免 runningTasks/activeJobs 跨测试泄漏
    scheduler = new SchedulerService();
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
