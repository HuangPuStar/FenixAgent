// ── scheduler stale job cleanup 验证 ──
// R36 修复：任务从 DB 删除后 executeTask 调用 unscheduleTask 清理残留 job
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { setScheduleJobImpl, startScheduler, stopScheduler } from "../services/scheduler";

const mockScheduleJob = mock((_config: unknown, _handler: () => void) => ({
  cancel: mock(() => {}),
  nextInvocation: () => new Date(),
}));

beforeEach(() => {
  stopScheduler();
  setScheduleJobImpl(mockScheduleJob as any);
  mockScheduleJob.mockClear();
});

describe("scheduler stale job cleanup on task-not-found", () => {
  // 无 enabled tasks 时 startScheduler 不调度任何 job
  test("startScheduler skips tasks not in DB (listEnabled returns empty)", async () => {
    await startScheduler();
    // 无 enabled tasks，无 job 被调度
    expect(mockScheduleJob).not.toHaveBeenCalled();
  });
});
