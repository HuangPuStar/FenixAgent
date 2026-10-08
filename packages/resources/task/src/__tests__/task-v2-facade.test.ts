// Task V2 Facade 的职责断言：**把 actor 换成显式归属范围**，并保证执行日志只在所属任务对 actor 可读时
// 才被读出/清空。
//
// 与 `./round55-tasks-v2-routes.test.ts` 的分工：路由用例证明对外协议行为（状态码、响应形状、参数夹紧），
// 本文件证明**交给仓储的归属谓词确实来自 actor**——替身按收到的 `(userId, organizationId)` 模拟
// `user_id AND organization_id` 条件，因此跨用户/跨组织的行走不到调用方。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { taskV2Facade } from "../server/facades/task-v2-facade";
import type { TaskExecutionLogRow } from "../server/repositories/task";
import { taskExecutionLogRepo } from "../server/repositories/task";
import type { ScheduledTaskV2Row } from "../server/repositories/task-v2";
import { scheduledTaskV2Repo } from "../server/repositories/task-v2";
import { schedulerService } from "../server/services/scheduler";

const NOW = new Date("2026-08-19T00:00:00.000Z");
const ACTOR = { userId: "user-1", organizationId: "org-1" } as const;

function task(overrides: Partial<ScheduledTaskV2Row> = {}): ScheduledTaskV2Row {
  return {
    id: "task-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "日报任务",
    description: null,
    cron: "0 9 * * *",
    timezone: "Asia/Shanghai",
    enabled: true,
    timeoutSeconds: 300,
    type: "http",
    agentId: null,
    definition: { url: "https://example.test/hook", method: "POST" },
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function log(overrides: Partial<TaskExecutionLogRow> = {}): TaskExecutionLogRow {
  return {
    id: "log-1",
    taskId: "task-1",
    status: "success",
    error: null,
    duration: 15,
    triggeredBy: "manual",
    skipReason: null,
    resultSummary: "完成",
    workspacePath: null,
    workspaceName: null,
    taskSnapshot: null,
    createdAt: NOW,
    ...overrides,
  };
}

const taskRepoOriginals = {
  create: scheduledTaskV2Repo.create,
  deleteByUserAndOrgAndId: scheduledTaskV2Repo.deleteByUserAndOrgAndId,
  getByUserAndOrgAndId: scheduledTaskV2Repo.getByUserAndOrgAndId,
  listByUserAndOrgPaged: scheduledTaskV2Repo.listByUserAndOrgPaged,
  update: scheduledTaskV2Repo.update,
};
const logRepoOriginals = {
  deleteByTask: taskExecutionLogRepo.deleteByTask,
  listByTaskPaged: taskExecutionLogRepo.listByTaskPaged,
};
const schedulerOriginals = {
  execute: schedulerService.execute,
  schedule: schedulerService.schedule,
  unschedule: schedulerService.unschedule,
};

function restoreSeams(): void {
  scheduledTaskV2Repo.create = taskRepoOriginals.create;
  scheduledTaskV2Repo.deleteByUserAndOrgAndId = taskRepoOriginals.deleteByUserAndOrgAndId;
  scheduledTaskV2Repo.getByUserAndOrgAndId = taskRepoOriginals.getByUserAndOrgAndId;
  scheduledTaskV2Repo.listByUserAndOrgPaged = taskRepoOriginals.listByUserAndOrgPaged;
  scheduledTaskV2Repo.update = taskRepoOriginals.update;
  taskExecutionLogRepo.deleteByTask = logRepoOriginals.deleteByTask;
  taskExecutionLogRepo.listByTaskPaged = logRepoOriginals.listByTaskPaged;
  schedulerService.execute = schedulerOriginals.execute;
  schedulerService.schedule = schedulerOriginals.schedule;
  schedulerService.unschedule = schedulerOriginals.unschedule;
}

describe("Task V2 Facade 的归属推导", () => {
  beforeEach(() => {
    restoreSeams();
    scheduledTaskV2Repo.create = async (input) => task(input);
    // 删除同样按双归属条件模拟：只有命中 user_id + organization_id 的行才真的被删。
    scheduledTaskV2Repo.deleteByUserAndOrgAndId = async (userId, organizationId, taskId) =>
      userId === "user-1" && organizationId === "org-1" && taskId === "task-1";
    // 替身模拟 SQL 的双归属条件：只把同时命中 user_id 与 organization_id 的行返回给调用方。
    scheduledTaskV2Repo.getByUserAndOrgAndId = async (userId, organizationId, taskId) =>
      userId === "user-1" && organizationId === "org-1" && taskId === "task-1" ? task() : null;
    scheduledTaskV2Repo.listByUserAndOrgPaged = async (userId, organizationId) =>
      userId === "user-1" && organizationId === "org-1" ? { rows: [task()], total: 1 } : { rows: [], total: 0 };
    scheduledTaskV2Repo.update = async (id, input) => task({ id, ...input });
    taskExecutionLogRepo.deleteByTask = async () => undefined;
    taskExecutionLogRepo.listByTaskPaged = async () => ({ rows: [log()], total: 1 });
    schedulerService.execute = async () => ({ status: "success", duration: 12, resultSummary: "已执行" });
    schedulerService.schedule = () => true;
    schedulerService.unschedule = () => undefined;
  });

  afterEach(restoreSeams);

  // 列表把 actor 的用户与组织一起下推为归属谓词：跨用户的行不可能出现在结果里。
  test("list 用 actor 的双归属下推查询谓词", async () => {
    const listByUserAndOrgPaged = mock(async () => ({ rows: [task()], total: 1 }));
    scheduledTaskV2Repo.listByUserAndOrgPaged = listByUserAndOrgPaged;

    const page = await taskV2Facade.list(ACTOR, 1, 20, { keyword: "日报" });

    expect(listByUserAndOrgPaged).toHaveBeenCalledWith("user-1", "org-1", 1, 20, {
      keyword: "日报",
      type: undefined,
      agentId: undefined,
    });
    expect(page).toMatchObject({ total: 1, items: [{ id: "task-1" }] });
  });

  // 创建任务：两个归属字段都只能来自 actor，请求体没有改写归属的机会。
  test("create 用 actor 落成任务归属", async () => {
    const create = mock(async (input) => task(input));
    scheduledTaskV2Repo.create = create;

    await taskV2Facade.create(ACTOR, {
      name: "新任务",
      cron: "0 9 * * *",
      type: "http",
      definition: { url: "https://example.test/hook" },
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", organizationId: "org-1" }));
  });

  // 详情：非本用户的任务一律按不存在处理（跨用户与不存在同形，不给探测面）。
  test("get 对非归属任务返回 NOT_FOUND", async () => {
    const result = await taskV2Facade.get({ userId: "user-2", organizationId: "org-1" }, "task-1");

    expect(result.success).toBe(false);
    expect(result).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 详情：本用户在本组织的任务可读。
  test("get 返回归属范围内的任务", async () => {
    const result = await taskV2Facade.get(ACTOR, "task-1");

    // 响应是协议 DTO：归属列不出现在对外载荷里（越权与否只能由查询谓词决定）。
    expect(result).toMatchObject({ success: true, data: { id: "task-1", name: "日报任务" } });
  });

  // 更新与切换：非归属任务不得写入，且必须先命中归属查询。
  test("update 与 toggle 对非归属任务返回 NOT_FOUND", async () => {
    const update = mock(async () => task());
    scheduledTaskV2Repo.update = update;

    const foreign = { userId: "user-2", organizationId: "org-1" } as const;
    await expect(taskV2Facade.update(foreign, "task-1", { name: "改名" })).resolves.toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
    await expect(taskV2Facade.toggle(foreign, "task-1")).resolves.toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
    expect(update).not.toHaveBeenCalled();
  });

  // 删除：非归属任务不得删除，也不得触碰调度器——替身按收到的双归属返回未命中，钉住下推的谓词。
  test("remove 用 actor 的双归属下推删除条件", async () => {
    const remove = mock(
      async (userId: string, organizationId: string, taskId: string) =>
        userId === "user-1" && organizationId === "org-1" && taskId === "task-1",
    );
    const unschedule = mock(() => undefined);
    scheduledTaskV2Repo.deleteByUserAndOrgAndId = remove;
    schedulerService.unschedule = unschedule;

    const foreign = await taskV2Facade.remove({ userId: "user-1", organizationId: "org-2" }, "task-1");
    expect(foreign).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(unschedule).not.toHaveBeenCalled();

    const owned = await taskV2Facade.remove(ACTOR, "task-1");
    expect(owned).toMatchObject({ success: true });
    expect(remove).toHaveBeenLastCalledWith("user-1", "org-1", "task-1");
    expect(unschedule).toHaveBeenCalledWith("task-1");
  });

  // 执行日志：所属任务不归属 actor 时不得读取日志行（日志不是可越权的独立资源）。
  test("listLogs 在任务非归属时不读取日志", async () => {
    const listByTaskPaged = mock(async () => ({ rows: [log()], total: 1 }));
    taskExecutionLogRepo.listByTaskPaged = listByTaskPaged;

    const result = await taskV2Facade.listLogs({ userId: "user-1", organizationId: "org-2" }, "task-1", 1, 20);

    expect(result).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(listByTaskPaged).not.toHaveBeenCalled();
  });

  // 执行日志：归属命中时按任务分页读取。
  test("listLogs 在归属命中时返回分页日志", async () => {
    const listByTaskPaged = mock(async () => ({ rows: [log()], total: 1 }));
    taskExecutionLogRepo.listByTaskPaged = listByTaskPaged;

    const result = await taskV2Facade.listLogs(ACTOR, "task-1", 2, 10);

    expect(result).toMatchObject({ success: true, data: { total: 1, items: [{ id: "log-1", taskId: "task-1" }] } });
    expect(listByTaskPaged).toHaveBeenCalledWith("task-1", 2, 10);
  });

  // 清空日志：任务非归属时一行都不删。
  test("clearLogs 在任务非归属时不删除日志", async () => {
    const deleteByTask = mock(async () => undefined);
    taskExecutionLogRepo.deleteByTask = deleteByTask;

    const result = await taskV2Facade.clearLogs({ userId: "user-2", organizationId: "org-1" }, "task-1");

    expect(result).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(deleteByTask).not.toHaveBeenCalled();
  });

  // 手动触发：非归属任务不得触达调度器（否则等于替他人执行任务）。
  test("trigger 对非归属任务不触发调度", async () => {
    const execute = mock(async () => ({ status: "success", duration: 1, resultSummary: "已执行" }));
    schedulerService.execute = execute;

    const result = await taskV2Facade.trigger({ userId: "user-2", organizationId: "org-1" }, "task-1");

    expect(result).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(execute).not.toHaveBeenCalled();
  });
});
