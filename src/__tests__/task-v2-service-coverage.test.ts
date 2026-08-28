import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ScheduledTaskV2Row } from "../db/schema";
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
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const USER_ID = "user-current";
const ORG_ID = "org-current";

function taskRow(overrides: Partial<ScheduledTaskV2Row> = {}): ScheduledTaskV2Row {
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

function stubLookup(row: ScheduledTaskV2Row | null) {
  stubDb({ select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }) }) }) });
}

function pagedDb(rows: unknown[], total: string | number) {
  const offset = mock(() => Promise.resolve(rows));
  const limit = mock(() => ({ offset }));
  const orderBy = mock(() => ({ limit }));
  const whereRows = mock(() => ({ orderBy }));
  const whereCount = mock(() => Promise.resolve([{ total }]));
  const from = mock(() => ({ where: whereCount }));
  const select = mock<() => unknown>(() => ({ from: mock(() => ({ where: whereRows })) }));
  select.mockImplementationOnce(() => ({ from }));
  stubDb({ select });
  return { limit, offset };
}

beforeEach(resetAllStubs);
afterEach(resetAllStubs);

describe("task-v2 服务隔离、错误与分页", () => {
  // 当前组织列表应限制越界分页并映射日期。
  test("列表规范化分页并映射日期", async () => {
    const { limit, offset } = pagedDb([taskRow()], "1");
    const result = await listTasksV2(USER_ID, ORG_ID, 0, 999, { keyword: "sync", type: "http" });
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        total: 1,
        page: 1,
        pageSize: 100,
        items: [expect.objectContaining({ createdAt: 1_767_225_600, updatedAt: 1_767_312_000 })],
      }),
    });
    expect(limit).toHaveBeenCalledWith(100);
    expect(offset).toHaveBeenCalledWith(0);
  });

  // 空分页结果应保留总数和请求页码。
  test("列表空页返回空数组", async () => {
    const { offset } = pagedDb([], 0);
    expect(await listTasksV2(USER_ID, ORG_ID, 3, 5)).toEqual({
      success: true,
      data: { items: [], total: 0, page: 3, pageSize: 5 },
    });
    expect(offset).toHaveBeenCalledWith(10);
  });

  // 跨组织或用户的任务必须表现为不存在。
  test("读取不可见任务返回未找到", async () => {
    stubLookup(null);
    expect(await getTaskV2(USER_ID, ORG_ID, "task-foreign")).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "任务不存在" },
    });
  });

  // 可见任务的可空字段必须统一映射为 null。
  test("读取任务映射可空字段", async () => {
    stubLookup(taskRow({ description: undefined, timezone: undefined, lastStatus: undefined }));
    expect(await getTaskV2(USER_ID, ORG_ID, "task-1")).toEqual({
      success: true,
      data: expect.objectContaining({ description: null, timezone: null, lastStatus: null, lastRunAt: null }),
    });
  });

  // Agent 任务缺少 agentId 时不能写入不可执行任务。
  test("创建 Agent 任务缺少 agentId 时拒绝写库", async () => {
    const values = mock(() => Promise.resolve([]));
    stubDb({ insert: () => ({ values }) });
    expect(
      await createTaskV2(USER_ID, ORG_ID, { name: "agent", cron: "0 * * * *", type: "agent", definition: {} }),
    ).toEqual({ success: false, error: { code: "VALIDATION_ERROR", message: "Agent 任务必须指定 agentId" } });
    expect(values).not.toHaveBeenCalled();
  });

  // 更新不可见任务时不得透露内容或执行写入。
  test("更新不可见任务返回未找到", async () => {
    stubLookup(null);
    expect(await updateTaskV2(USER_ID, ORG_ID, "task-foreign", { name: "renamed" })).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "任务不存在" },
    });
  });

  // HTTP 任务不允许被注入 Agent 配置。
  test("HTTP 任务更新 agentId 时拒绝", async () => {
    stubLookup(taskRow());
    expect(await updateTaskV2(USER_ID, ORG_ID, "task-1", { agentId: "agent-1" })).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "HTTP 任务不能指定 agentId" },
    });
  });

  // 任务类型是创建期契约，更新时不得切换。
  test("更新任务类型时拒绝", async () => {
    stubLookup(taskRow());
    expect(await updateTaskV2(USER_ID, ORG_ID, "task-1", { type: "agent" })).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "任务类型不可修改" },
    });
  });

  // 删除不可见任务时不应取消任何调度任务。
  test("删除不可见任务返回未找到", async () => {
    stubDb({ delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) });
    expect(await deleteTaskV2(USER_ID, ORG_ID, "task-foreign")).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "任务不存在" },
    });
  });

  // 禁用任务应持久化 enabled=false 并返回新状态。
  test("切换已启用任务为禁用状态", async () => {
    const existing = taskRow();
    const set = mock(() => ({
      where: () => ({ returning: () => Promise.resolve([{ ...existing, enabled: false }]) }),
    }));
    stubDb({
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([existing]) }) }) }),
      update: () => ({ set }),
    });
    expect(await toggleTaskV2(USER_ID, ORG_ID, "task-1")).toEqual({
      success: true,
      data: { id: "task-1", enabled: false },
    });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  // 手动触发前必须按组织隔离校验任务。
  test("触发不可见任务返回未找到", async () => {
    stubLookup(null);
    expect(await triggerTaskV2(USER_ID, ORG_ID, "task-foreign")).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "任务不存在" },
    });
  });

  // 清理日志前必须校验任务归属。
  test("清理不可见任务日志返回未找到", async () => {
    stubLookup(null);
    expect(await clearExecutionLogsV2(USER_ID, ORG_ID, "task-foreign")).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "任务不存在" },
    });
  });

  // 日志分页应限制 pageSize 并将空诊断字段返回 null。
  test("执行日志分页转换空诊断字段", async () => {
    const log = {
      id: "log-1",
      taskId: "task-1",
      status: "success",
      error: undefined,
      duration: undefined,
      triggeredBy: "manual",
      skipReason: undefined,
      resultSummary: undefined,
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    };
    const { limit, offset } = pagedDb([log], "1");
    expect(await listExecutionLogsV2("task-1", -1, 500)).toEqual({
      success: true,
      data: {
        total: 1,
        items: [
          expect.objectContaining({
            error: null,
            duration: null,
            skipReason: null,
            resultSummary: null,
            createdAt: 1_767_398_400,
          }),
        ],
      },
    });
    expect(limit).toHaveBeenCalledWith(100);
    expect(offset).toHaveBeenCalledWith(0);
  });
});
