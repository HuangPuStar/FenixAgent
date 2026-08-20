import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import type { TaskExecutionLogRow } from "../repositories/task";
import { taskExecutionLogRepo } from "../repositories/task";
import type { ScheduledTaskV2Row } from "../repositories/task-v2";
import { scheduledTaskV2Repo } from "../repositories/task-v2";
import { schedulerService } from "../services/scheduler";
import { readJson, resetAllStubs, stubAuthApi, stubEnvironmentRepo } from "../test-utils/helpers";

const route = (await import("../routes/web/tasks-v2")).default;
const now = new Date("2026-08-19T00:00:00.000Z");

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
    createdAt: now,
    updatedAt: now,
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
    createdAt: overrides.createdAt ?? now,
  };
}

function authenticate() {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
    authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
  });
}

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function json(path: string, method: string, body: Record<string, unknown> = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
  reschedule: schedulerService.reschedule,
  schedule: schedulerService.schedule,
  unschedule: schedulerService.unschedule,
};

function restoreSeams() {
  scheduledTaskV2Repo.create = taskRepoOriginals.create;
  scheduledTaskV2Repo.deleteByUserAndOrgAndId = taskRepoOriginals.deleteByUserAndOrgAndId;
  scheduledTaskV2Repo.getByUserAndOrgAndId = taskRepoOriginals.getByUserAndOrgAndId;
  scheduledTaskV2Repo.listByUserAndOrgPaged = taskRepoOriginals.listByUserAndOrgPaged;
  scheduledTaskV2Repo.update = taskRepoOriginals.update;
  taskExecutionLogRepo.deleteByTask = logRepoOriginals.deleteByTask;
  taskExecutionLogRepo.listByTaskPaged = logRepoOriginals.listByTaskPaged;
  schedulerService.execute = schedulerOriginals.execute;
  schedulerService.reschedule = schedulerOriginals.reschedule;
  schedulerService.schedule = schedulerOriginals.schedule;
  schedulerService.unschedule = schedulerOriginals.unschedule;
}

function installSafeSeams() {
  scheduledTaskV2Repo.create = async (input) => task(input);
  scheduledTaskV2Repo.deleteByUserAndOrgAndId = async () => true;
  scheduledTaskV2Repo.getByUserAndOrgAndId = async () => task();
  scheduledTaskV2Repo.listByUserAndOrgPaged = async () => ({ rows: [task()], total: 1 });
  scheduledTaskV2Repo.update = async (id, input) => task({ id, ...input });
  taskExecutionLogRepo.deleteByTask = async () => undefined;
  taskExecutionLogRepo.listByTaskPaged = async () => ({ rows: [log()], total: 1 });
  schedulerService.execute = async () => ({ status: "success", duration: 12, resultSummary: "已执行" });
  schedulerService.reschedule = () => true;
  schedulerService.schedule = () => true;
  schedulerService.unschedule = () => undefined;
}

describe("round55 Tasks V2 Web 路由", () => {
  beforeEach(() => {
    resetAllStubs();
    restoreSeams();
    authenticate();
    installSafeSeams();
  });

  afterEach(() => {
    resetTestAuth();
    restoreSeams();
    resetAllStubs();
  });

  // 未认证访问必须在任何任务仓储操作前被认证守卫拒绝。
  test("未认证列表返回 401", async () => {
    let listed = false;
    scheduledTaskV2Repo.listByUserAndOrgPaged = async () => {
      listed = true;
      return { rows: [], total: 0 };
    };
    resetTestAuth();
    stubEnvironmentRepo({ getBySecret: async () => null });
    stubAuthApi({ getSession: async () => null, verifyApiKey: async () => ({ valid: false }) });

    expect((await request("/tasks/v2")).status).toBe(401);
    expect(listed).toBe(false);
  });

  // 列表必须以认证上下文中的用户和组织执行隔离查询。
  test("列表传递认证用户与组织", async () => {
    let received: string[] = [];
    scheduledTaskV2Repo.listByUserAndOrgPaged = async (userId, organizationId) => {
      received = [userId, organizationId];
      return { rows: [], total: 0 };
    };

    expect((await request("/tasks/v2")).status).toBe(200);
    expect(received).toEqual(["user-1", "org-1"]);
  });

  // 空列表仍应保持稳定的分页成功响应。
  test("列表返回空分页结果", async () => {
    scheduledTaskV2Repo.listByUserAndOrgPaged = async () => ({ rows: [], total: 0 });

    expect(await readJson(await request("/tasks/v2"))).toEqual({
      success: true,
      data: { items: [], total: 0, page: 1, pageSize: 20 },
    });
  });

  // 列表查询必须转发名称、类型和 Agent 筛选条件。
  test("列表转发全部筛选条件", async () => {
    let options: unknown;
    scheduledTaskV2Repo.listByUserAndOrgPaged = async (_userId, _organizationId, _page, _pageSize, value) => {
      options = value;
      return { rows: [], total: 0 };
    };

    await request("/tasks/v2?keyword=日报&type=agent&agentId=agent-1");
    expect(options).toEqual({ keyword: "日报", type: "agent", agentId: "agent-1" });
  });

  // 非数字页码应回退到路由默认分页值。
  test("列表无效页码使用默认值", async () => {
    let pagination: number[] = [];
    scheduledTaskV2Repo.listByUserAndOrgPaged = async (_userId, _organizationId, page, pageSize) => {
      pagination = [page, pageSize];
      return { rows: [], total: 0 };
    };

    await request("/tasks/v2?page=invalid&pageSize=invalid");
    expect(pagination).toEqual([1, 20]);
  });

  // 创建必须把认证租户身份而非请求体数据传给服务层。
  test("创建任务保留认证隔离身份", async () => {
    let received: string[] = [];
    scheduledTaskV2Repo.create = async (input) => {
      received = [input.userId, input.organizationId];
      return task(input);
    };

    expect(
      (
        await json("/tasks/v2", "POST", {
          name: "新任务",
          cron: "0 8 * * *",
          type: "http",
          definition: { url: "https://example.test" },
        })
      ).status,
    ).toBe(200);
    expect(received).toEqual(["user-1", "org-1"]);
  });

  // HTTP 任务创建成功后应返回经过服务层标准化的任务信息。
  test("创建 HTTP 任务返回任务数据", async () => {
    const response = await json("/tasks/v2", "POST", {
      name: "新任务",
      cron: "0 8 * * *",
      type: "http",
      definition: { url: "https://example.test" },
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      data: expect.objectContaining({ name: "新任务", type: "http", enabled: true }),
    });
  });

  // Agent 任务缺少 agentId 属于跨字段校验错误而非服务器故障。
  test("创建 Agent 任务缺少 agentId 返回 400", async () => {
    const response = await json("/tasks/v2", "POST", {
      name: "Agent 任务",
      cron: "0 8 * * *",
      type: "agent",
      definition: { prompt: "执行日报" },
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  // 缺少必填名称必须在 HTTP schema 层拒绝，禁止调用创建仓储。
  test("创建缺少名称返回 422", async () => {
    let created = false;
    scheduledTaskV2Repo.create = async (input) => {
      created = true;
      return task(input);
    };

    expect(
      (
        await json("/tasks/v2", "POST", {
          cron: "0 8 * * *",
          type: "http",
          definition: { url: "https://example.test" },
        })
      ).status,
    ).toBe(422);
    expect(created).toBe(false);
  });

  // 非整数超时值必须由请求 schema 拒绝。
  test("创建拒绝非整数超时", async () => {
    expect(
      (
        await json("/tasks/v2", "POST", {
          name: "新任务",
          cron: "0 8 * * *",
          timeoutSeconds: 1.5,
          type: "http",
          definition: { url: "https://example.test" },
        })
      ).status,
    ).toBe(422);
  });

  // 详情读取必须作用于认证用户和组织范围。
  test("详情传递认证隔离身份", async () => {
    let received: string[] = [];
    scheduledTaskV2Repo.getByUserAndOrgAndId = async (userId, organizationId, id) => {
      received = [userId, organizationId, id];
      return task();
    };

    expect((await request("/tasks/v2/task-1")).status).toBe(200);
    expect(received).toEqual(["user-1", "org-1", "task-1"]);
  });

  // 不存在任务必须映射为不泄露内部细节的 404。
  test("详情不存在返回 404", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = async () => null as never;

    const response = await request("/tasks/v2/missing");
    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ error: { code: "not_found", message: "任务不存在" } });
  });

  // 更新名称应写入当前任务并返回更新后的数据。
  test("更新名称返回更新任务", async () => {
    scheduledTaskV2Repo.update = async (id, input) => task({ id, ...input, name: "更新后" });

    const response = await json("/tasks/v2/task-1", "PUT", { name: "更新后" });
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ data: { name: "更新后" } });
  });

  // 修改任务类型是业务校验错误，必须映射为 400。
  test("更新任务类型返回 400", async () => {
    const response = await json("/tasks/v2/task-1", "PUT", { type: "agent" });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: { code: "validation_error" } });
  });

  // 更新不存在任务必须返回 404。
  test("更新不存在任务返回 404", async () => {
    scheduledTaskV2Repo.getByUserAndOrgAndId = async () => null as never;

    expect((await json("/tasks/v2/missing", "PUT", { name: "新名称" })).status).toBe(404);
  });

  // 空名称必须由更新 schema 拒绝，禁止进入服务层。
  test("更新拒绝空名称", async () => {
    let read = false;
    scheduledTaskV2Repo.getByUserAndOrgAndId = async () => {
      read = true;
      return task();
    };

    expect((await json("/tasks/v2/task-1", "PUT", { name: "" })).status).toBe(422);
    expect(read).toBe(false);
  });

  // 删除成功必须返回统一的空 data 响应。
  test("删除任务返回空数据", async () => {
    expect(await readJson(await request("/tasks/v2/task-1", { method: "DELETE" }))).toEqual({
      success: true,
      data: null,
    });
  });

  // 删除未命中任务必须映射为 404。
  test("删除不存在任务返回 404", async () => {
    scheduledTaskV2Repo.deleteByUserAndOrgAndId = async () => false;

    expect((await request("/tasks/v2/missing", { method: "DELETE" })).status).toBe(404);
  });

  // 取消任务切换应返回切换后的 enabled 状态。
  test("切换任务返回禁用状态", async () => {
    scheduledTaskV2Repo.update = async (id, input) => task({ id, ...input });

    expect(await readJson(await request("/tasks/v2/task-1/toggle", { method: "POST" }))).toEqual({
      success: true,
      data: { id: "task-1", enabled: false },
    });
  });

  // 切换不存在任务必须不触发调度器并返回 404。
  test("切换不存在任务返回 404", async () => {
    let scheduled = false;
    scheduledTaskV2Repo.getByUserAndOrgAndId = async () => null as never;
    schedulerService.schedule = () => {
      scheduled = true;
      return true;
    };

    expect((await request("/tasks/v2/missing/toggle", { method: "POST" })).status).toBe(404);
    expect(scheduled).toBe(false);
  });

  // 手动触发应返回调度执行器的结果，不产生真实进程或网络调用。
  test("手动触发返回执行结果", async () => {
    const response = await request("/tasks/v2/task-1/trigger", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      data: { status: "success", duration: 12, resultSummary: "已执行" },
    });
  });

  // 手动触发不存在任务必须在执行器之前被拒绝。
  test("触发不存在任务不执行调度器", async () => {
    let executed = false;
    scheduledTaskV2Repo.getByUserAndOrgAndId = async () => null as never;
    schedulerService.execute = async () => {
      executed = true;
      return { status: "success", duration: 0 };
    };

    expect((await request("/tasks/v2/missing/trigger", { method: "POST" })).status).toBe(404);
    expect(executed).toBe(false);
  });

  // 日志页码必须被夹紧到最小 1、最大 pageSize 100。
  test("日志分页执行边界夹紧", async () => {
    let pagination: number[] = [];
    taskExecutionLogRepo.listByTaskPaged = async (_id, page, pageSize) => {
      pagination = [page, pageSize];
      return { rows: [], total: 0 };
    };

    expect((await request("/tasks/v2/task-1/logs?page=-3&pageSize=999")).status).toBe(200);
    expect(pagination).toEqual([1, 100]);
  });

  // 查询日志前必须验证任务在当前认证租户内存在。
  test("日志不存在任务不读取日志仓储", async () => {
    let listed = false;
    scheduledTaskV2Repo.getByUserAndOrgAndId = async () => null as never;
    taskExecutionLogRepo.listByTaskPaged = async () => {
      listed = true;
      return { rows: [], total: 0 };
    };

    expect((await request("/tasks/v2/missing/logs")).status).toBe(404);
    expect(listed).toBe(false);
  });

  // 清空日志必须调用日志仓储且返回统一空数据。
  test("清空日志返回空数据", async () => {
    let deletedTaskId = "";
    taskExecutionLogRepo.deleteByTask = async (taskId) => {
      deletedTaskId = taskId;
    };

    expect(await readJson(await request("/tasks/v2/task-1/logs", { method: "DELETE" }))).toEqual({
      success: true,
      data: null,
    });
    expect(deletedTaskId).toBe("task-1");
  });

  // 清空不存在任务必须不删除任何日志。
  test("清空不存在任务不删除日志", async () => {
    let deleted = false;
    scheduledTaskV2Repo.getByUserAndOrgAndId = async () => null as never;
    taskExecutionLogRepo.deleteByTask = async () => {
      deleted = true;
    };

    expect((await request("/tasks/v2/missing/logs", { method: "DELETE" })).status).toBe(404);
    expect(deleted).toBe(false);
  });
});
