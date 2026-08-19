import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { taskExecutionLogRepo } from "../repositories/task";
import type { ScheduledTaskV2Row } from "../repositories/task-v2";
import { scheduledTaskV2Repo } from "../repositories/task-v2";
import { schedulerService } from "../services/scheduler";
import {
  clearExecutionLogsV2,
  createTaskV2,
  deleteTaskV2,
  getTaskV2,
  listExecutionLogsV2,
  listTasksV2,
  toggleTaskV2,
  triggerTaskV2,
  updateTaskV2,
} from "../services/task-v2";

const USER_ID = "user-current";
const ORG_ID = "org-current";

function task(overrides: Partial<ScheduledTaskV2Row> = {}): ScheduledTaskV2Row {
  return {
    id: "task-1",
    userId: USER_ID,
    organizationId: ORG_ID,
    name: "daily sync",
    description: null,
    cron: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    timeoutSeconds: 60,
    type: "http",
    agentId: null,
    definition: { url: "https://example.test/hook" },
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

const repoOriginals = {
  create: scheduledTaskV2Repo.create,
  deleteByUserAndOrgAndId: scheduledTaskV2Repo.deleteByUserAndOrgAndId,
  getByUserAndOrgAndId: scheduledTaskV2Repo.getByUserAndOrgAndId,
  listByUserAndOrgPaged: scheduledTaskV2Repo.listByUserAndOrgPaged,
  update: scheduledTaskV2Repo.update,
};
const schedulerOriginals = {
  execute: schedulerService.execute,
  reschedule: schedulerService.reschedule,
  schedule: schedulerService.schedule,
  unschedule: schedulerService.unschedule,
};
const logOriginals = {
  deleteByTask: taskExecutionLogRepo.deleteByTask,
  listByTaskPaged: taskExecutionLogRepo.listByTaskPaged,
};

function restoreDependencies() {
  scheduledTaskV2Repo.create = repoOriginals.create;
  scheduledTaskV2Repo.deleteByUserAndOrgAndId = repoOriginals.deleteByUserAndOrgAndId;
  scheduledTaskV2Repo.getByUserAndOrgAndId = repoOriginals.getByUserAndOrgAndId;
  scheduledTaskV2Repo.listByUserAndOrgPaged = repoOriginals.listByUserAndOrgPaged;
  scheduledTaskV2Repo.update = repoOriginals.update;
  schedulerService.execute = schedulerOriginals.execute;
  schedulerService.reschedule = schedulerOriginals.reschedule;
  schedulerService.schedule = schedulerOriginals.schedule;
  schedulerService.unschedule = schedulerOriginals.unschedule;
  taskExecutionLogRepo.deleteByTask = logOriginals.deleteByTask;
  taskExecutionLogRepo.listByTaskPaged = logOriginals.listByTaskPaged;
}

describe("Task v2 服务的隔离、调度与资源释放", () => {
  beforeEach(restoreDependencies);
  afterEach(restoreDependencies);

  // 非法 cron 字段数必须在创建前被拒绝，避免调度器接收无效任务。
  test("创建拒绝字段数错误的 cron", async () => {
    const create = mock(async () => task());
    scheduledTaskV2Repo.create = create;
    await expect(
      createTaskV2(USER_ID, ORG_ID, { name: "bad", cron: "0 1 *", type: "http", definition: {} }),
    ).resolves.toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "cron 表达式必须为 5 字段（分 时 日 月 周）" },
    });
    expect(create).not.toHaveBeenCalled();
  });

  // cron 的非法字符必须在写入前被安全过滤。
  test("创建拒绝 cron 非法字符", async () => {
    scheduledTaskV2Repo.create = mock(async () => task());
    await expect(
      createTaskV2(USER_ID, ORG_ID, { name: "bad", cron: "0 @ * * *", type: "http", definition: {} }),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  // 创建应清理展示字段空白并将空时区归一化为 null。
  test("创建规范化名称描述时区与 cron", async () => {
    let received: ScheduledTaskV2Row | null = null;
    scheduledTaskV2Repo.create = mock(async (input) => {
      received = input as ScheduledTaskV2Row;
      return task(input);
    });
    schedulerService.schedule = mock(() => true);
    const result = await createTaskV2(USER_ID, ORG_ID, {
      name: "  sync  ",
      description: "  description  ",
      cron: " 0 9 * * * ",
      timezone: "   ",
      type: "http",
      definition: {},
    });
    expect(result).toMatchObject({ success: true, data: { name: "sync", description: "description", timezone: null } });
    expect(received).toMatchObject({ name: "sync", cron: "0 9 * * *", timezone: null, timeoutSeconds: 300 });
  });

  // 创建启用任务必须请求调度，确保状态和运行资源一致。
  test("创建启用任务注册调度", async () => {
    const row = task();
    scheduledTaskV2Repo.create = mock(async () => row);
    const schedule = mock(() => true);
    schedulerService.schedule = schedule;
    await createTaskV2(USER_ID, ORG_ID, { name: "sync", cron: "0 9 * * *", type: "http", definition: {} });
    expect(schedule).toHaveBeenCalledWith(row);
  });

  // 调度器拒绝 cron 时创建仍应保留任务记录以供用户修正。
  test("创建在调度失败时仍返回已创建任务", async () => {
    scheduledTaskV2Repo.create = mock(async () => task());
    schedulerService.schedule = mock(() => false);
    await expect(
      createTaskV2(USER_ID, ORG_ID, { name: "sync", cron: "0 9 * * *", type: "http", definition: {} }),
    ).resolves.toMatchObject({
      success: true,
      data: { id: "task-1" },
    });
  });

  // 用户和组织均透传给分页仓储，防止跨租户数据混入。
  test("列表将双重租户边界传给仓储", async () => {
    const list = mock(async () => ({ rows: [], total: 0 }));
    scheduledTaskV2Repo.listByUserAndOrgPaged = list;
    await listTasksV2(USER_ID, ORG_ID, 2, 20, { agentId: "agent-1" });
    expect(list).toHaveBeenCalledWith(USER_ID, ORG_ID, 2, 20, { agentId: "agent-1" });
  });

  // 列表应将小数分页向下取整，避免偏移量不确定。
  test("列表向下取整小数分页", async () => {
    scheduledTaskV2Repo.listByUserAndOrgPaged = mock(async () => ({ rows: [], total: 0 }));
    await expect(listTasksV2(USER_ID, ORG_ID, 2.9, 3.8)).resolves.toMatchObject({ data: { page: 2, pageSize: 3 } });
  });

  // 不可见任务必须作为不存在返回，避免泄漏另一租户资源。
  test("读取跨租户任务返回未找到", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => null);
    await expect(getTaskV2(USER_ID, ORG_ID, "foreign")).resolves.toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
  });

  // 更新不可见任务必须作为不存在返回，避免泄漏另一租户资源。
  test("更新跨租户任务返回未找到", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => null);
    await expect(updateTaskV2(USER_ID, ORG_ID, "foreign", { name: "new" })).resolves.toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
  });

  // 更新空 cron 不能绕过语义校验。
  test("更新拒绝空 cron", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => task());
    await expect(updateTaskV2(USER_ID, ORG_ID, "task-1", { cron: "" })).resolves.toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  // 仅元数据变更不应重建调度资源。
  test("更新名称不重新调度", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => task());
    scheduledTaskV2Repo.update = mock(async (_id, changes) => task(changes));
    const reschedule = mock(() => true);
    schedulerService.reschedule = reschedule;
    await expect(updateTaskV2(USER_ID, ORG_ID, "task-1", { name: " renamed " })).resolves.toMatchObject({
      success: true,
      data: { name: "renamed" },
    });
    expect(reschedule).not.toHaveBeenCalled();
  });

  // cron 变更后必须重新调度，释放旧 job 并注册新 job。
  test("更新 cron 后重新调度", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => task());
    const updated = task({ cron: "5 9 * * *" });
    scheduledTaskV2Repo.update = mock(async () => updated);
    const reschedule = mock(() => true);
    schedulerService.reschedule = reschedule;
    await updateTaskV2(USER_ID, ORG_ID, "task-1", { cron: "5 9 * * *" });
    expect(reschedule).toHaveBeenCalledWith(updated);
  });

  // 更新写入后对象消失时必须报告明确的未找到状态。
  test("更新写入后消失返回未找到", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => task());
    scheduledTaskV2Repo.update = mock(async () => null);
    await expect(updateTaskV2(USER_ID, ORG_ID, "task-1", { name: "new" })).resolves.toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "任务不存在（更新后未找到）" },
    });
  });

  // agent 任务允许更新其 agentId，保持任务类型约束。
  test("Agent 任务更新 agentId", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => task({ type: "agent", agentId: "agent-old" }));
    scheduledTaskV2Repo.update = mock(async (_id, changes) => task({ type: "agent", ...changes }));
    await expect(updateTaskV2(USER_ID, ORG_ID, "task-1", { agentId: "agent-new" })).resolves.toMatchObject({
      success: true,
      data: { agentId: "agent-new" },
    });
  });

  // 删除成功后必须释放对应调度资源。
  test("删除任务后取消调度", async () => {
    scheduledTaskV2Repo.deleteByUserAndOrgAndId = mock(async () => true);
    const unschedule = mock(() => undefined);
    schedulerService.unschedule = unschedule;
    await expect(deleteTaskV2(USER_ID, ORG_ID, "task-1")).resolves.toEqual({ success: true, data: undefined });
    expect(unschedule).toHaveBeenCalledWith("task-1");
  });

  // 删除失败时不得取消可能属于其他租户的调度任务。
  test("删除不可见任务不取消调度", async () => {
    scheduledTaskV2Repo.deleteByUserAndOrgAndId = mock(async () => false);
    const unschedule = mock(() => undefined);
    schedulerService.unschedule = unschedule;
    await deleteTaskV2(USER_ID, ORG_ID, "foreign");
    expect(unschedule).not.toHaveBeenCalled();
  });

  // 启用任务应调度新 job，恢复自动执行能力。
  test("切换禁用任务为启用时调度", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => task({ enabled: false }));
    const updated = task({ enabled: true });
    scheduledTaskV2Repo.update = mock(async () => updated);
    const schedule = mock(() => true);
    schedulerService.schedule = schedule;
    await expect(toggleTaskV2(USER_ID, ORG_ID, "task-1")).resolves.toMatchObject({ data: { enabled: true } });
    expect(schedule).toHaveBeenCalledWith(updated);
  });

  // 禁用任务应立即取消 job，防止后续 cron 继续运行。
  test("切换启用任务为禁用时取消调度", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => task({ enabled: true }));
    scheduledTaskV2Repo.update = mock(async () => task({ enabled: false }));
    const unschedule = mock(() => undefined);
    schedulerService.unschedule = unschedule;
    await expect(toggleTaskV2(USER_ID, ORG_ID, "task-1")).resolves.toMatchObject({ data: { enabled: false } });
    expect(unschedule).toHaveBeenCalledWith("task-1");
  });

  // 切换时写入竞争导致更新失败，应返回未找到而不调度。
  test("切换写入失败不变更调度", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => task());
    scheduledTaskV2Repo.update = mock(async () => null);
    const unschedule = mock(() => undefined);
    schedulerService.unschedule = unschedule;
    await expect(toggleTaskV2(USER_ID, ORG_ID, "task-1")).resolves.toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
    expect(unschedule).not.toHaveBeenCalled();
  });

  // 手动触发仅在当前用户和组织可见时才委派调度器。
  test("手动触发委派调度器", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => task());
    schedulerService.execute = mock(async () => ({ status: "success", duration: 7, resultSummary: "ok" }));
    await expect(triggerTaskV2(USER_ID, ORG_ID, "task-1")).resolves.toMatchObject({
      success: true,
      data: { status: "success" },
    });
  });

  // 执行日志分页应将负数页码和过大页大小限制为安全范围。
  test("执行日志规范化分页参数", async () => {
    const list = mock(async () => ({ rows: [], total: 0 }));
    taskExecutionLogRepo.listByTaskPaged = list;
    await listExecutionLogsV2("task-1", -4, 500);
    expect(list).toHaveBeenCalledWith("task-1", 1, 100);
  });

  // 清理日志必须先校验双重租户范围，再释放诊断资源。
  test("清理可见任务日志", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = mock(async () => task());
    const clear = mock(async () => undefined);
    taskExecutionLogRepo.deleteByTask = clear;
    await expect(clearExecutionLogsV2(USER_ID, ORG_ID, "task-1")).resolves.toEqual({ success: true, data: undefined });
    expect(clear).toHaveBeenCalledWith("task-1");
  });
});
