// task-v2-validation.test.ts —— v2 任务 CRUD 校验不变量
// v1 调度器下线后，v2 必须延续 v1 的 cron 语义校验（R36 不变量）：
// 空串/非法 cron 在 service 层即被拒绝且不触达数据库。
// 注：HTTP 层 Zod（min(1)）已拦截空串，本测试守护 service 层防御纵深，
// 因为 createTaskV2/updateTaskV2 是公共导出，可能被非 HTTP 入口调用。
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ScheduledTaskV2Row } from "../db/schema";
import { createTaskV2, updateTaskV2 } from "../services/task-v2";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const USER_ID = "user-1";
const ORG_ID = "org-1";

// 现有任务行（update 路径 getByUserAndOrgAndId 的返回值）
const existingTask: ScheduledTaskV2Row = {
  id: "task-1",
  userId: USER_ID,
  organizationId: ORG_ID,
  name: "existing-task",
  description: null,
  cron: "0 0 * * *",
  timezone: "UTC",
  enabled: true,
  timeoutSeconds: 300,
  type: "http",
  agentId: null,
  definition: { url: "https://example.com/hook" },
  lastRunAt: null,
  nextRunAt: null,
  lastStatus: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

// stub update 路径：getByUserAndOrgAndId 返回 existingTask，set 层用 spy 捕获写入数据
// 注意：updateTaskV2 成功后 schedulerService.reschedule 还会再调一次 repo.update
// 持久化 nextRunAt，因此 setSpy 可能被多次调用，断言需区分首次更新
function stubUpdatePath(updatedRow?: ScheduledTaskV2Row) {
  const setSpy = mock((_data: Record<string, unknown>) => ({
    where: () => ({
      returning: () => Promise.resolve(updatedRow ? [updatedRow] : []),
    }),
  }));
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([existingTask]),
        }),
      }),
    }),
    update: () => ({ set: setSpy }),
  });
  return setSpy;
}

afterEach(() => {
  resetAllStubs();
});

describe("createTaskV2 cron 校验", () => {
  // 6 字段 cron 不是合法 5 字段表达式，必须被 service 层拒绝且不写库
  test("拒绝 6 字段 cron 表达式", async () => {
    const createSpy = mock(() => Promise.resolve([]));
    stubDb({ insert: () => ({ values: () => ({ returning: createSpy }) }) });

    const result = await createTaskV2(USER_ID, ORG_ID, {
      name: "t",
      cron: "*/5 * * * * *",
      type: "http",
      definition: { url: "https://example.com/hook" },
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("updateTaskV2 cron 校验", () => {
  // R36 回归：空串 cron 更新必须被拒绝（v1 曾用真值判断放过空串导致静默失败）
  test("拒绝空串 cron 更新", async () => {
    const setSpy = stubUpdatePath();

    const result = await updateTaskV2(USER_ID, ORG_ID, "task-1", { cron: "" });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(setSpy).not.toHaveBeenCalled();
  });

  // 非法字符 cron（周字段 X 不在合法字符集内）必须被拒绝
  test("拒绝非法字符 cron 更新", async () => {
    const setSpy = stubUpdatePath();

    const result = await updateTaskV2(USER_ID, ORG_ID, "task-1", { cron: "0 0 * * X" });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(setSpy).not.toHaveBeenCalled();
  });

  // 合法 5 字段 cron 更新应通过校验并写入新值（首次 set 即任务更新，含新 cron）
  test("合法 cron 更新成功", async () => {
    const updatedRow = { ...existingTask, cron: "0 6 * * *" };
    const setSpy = stubUpdatePath(updatedRow);

    const result = await updateTaskV2(USER_ID, ORG_ID, "task-1", { cron: "0 6 * * *" });

    expect(result.success).toBe(true);
    expect(setSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ cron: "0 6 * * *" }));
  });
});
