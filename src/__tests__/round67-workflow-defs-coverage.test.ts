import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { readJson, resetAllStubs, stubDb } from "../test-utils/helpers";

const route = (await import("../routes/web/workflow-defs")).default;

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function jsonRequest(path: string, body: Record<string, unknown>, method = "POST") {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setAuthenticatedOrg() {
  setTestAuth({
    user: { id: "user-round67", email: "round67@test.invalid", name: "Round 67" },
    authContext: { organizationId: "org-round67", userId: "user-round67", role: "owner" },
  });
  setTestOrgContext({ organizationId: "org-round67", userId: "user-round67", role: "owner" });
}

function queryResult(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
        orderBy: () => Promise.resolve(rows),
      }),
    }),
  };
}

function queuedSelect(...results: unknown[][]) {
  let index = 0;
  return () => queryResult(results[index++] ?? []);
}

function workflow() {
  return {
    id: "workflow-round67",
    userId: "user-round67",
    organizationId: "org-round67",
    name: "Round 67 工作流",
    description: null,
    latestVersion: 1,
    storagePath: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  };
}

function trigger(overrides: Record<string, unknown> = {}) {
  return {
    id: "trigger-round67",
    organizationId: "org-round67",
    workflowId: "workflow-round67",
    type: "webhook",
    publicHash: "abcdef0123456789",
    secret: null,
    config: { source: "round67" },
    enabled: true,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("workflow-defs 第六十七轮路由补充覆盖", () => {
  beforeEach(() => {
    resetAllStubs();
    setAuthenticatedOrg();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  // REST 元数据更新找不到当前组织记录时必须隐藏资源存在性。
  test("REST 更新跨组织工作流返回 404", async () => {
    stubDb({ update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }) });

    const response = await jsonRequest("/workflow-defs/foreign-workflow", { name: "不应更新" }, "PATCH");

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe("NOT_FOUND");
  });

  // REST 删除当前组织工作流应返回统一空成功载荷。
  test("REST 删除当前组织工作流返回成功", async () => {
    stubDb({ delete: () => ({ where: () => ({ returning: () => Promise.resolve([{ storagePath: null }]) }) }) });

    const response = await request("/workflow-defs/workflow-round67", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: null });
  });

  // REST 创建触发器的唯一约束异常必须映射为冲突响应。
  test("REST 创建触发器映射唯一约束异常", async () => {
    const duplicateError = new Error("insert failed", { cause: new Error("unique constraint violated") });
    stubDb({
      select: () => queryResult([workflow()]),
      insert: () => {
        throw duplicateError;
      },
    });

    const response = await jsonRequest("/workflow-defs/workflow-round67/triggers", { type: "webhook" });

    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("CONFLICT");
  });

  // REST 删除触发器的意外仓储错误必须受控映射为 500。
  test("REST 删除触发器映射仓储异常", async () => {
    stubDb({
      select: () => {
        throw new Error("trigger lookup unavailable");
      },
    });

    const response = await request("/workflow-defs/workflow-round67/triggers/trigger-round67", { method: "DELETE" });

    expect(response.status).toBe(500);
    expect((await readJson(response)).error.message).toBe("trigger lookup unavailable");
  });

  // REST 重新生成哈希仅在当前组织触发器存在时返回完整新哈希视图。
  test("REST 重新生成当前组织触发器哈希", async () => {
    const updates: unknown[] = [];
    stubDb({
      select: queuedSelect([trigger()], [trigger({ publicHash: "newhash0123456789" })]),
      update: () => ({
        set: (value: unknown) => {
          updates.push(value);
          return { where: () => Promise.resolve() };
        },
      }),
    });

    const response = await jsonRequest("/workflow-defs/workflow-round67/triggers/trigger-round67/regenerate", {});
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.publicHash).toBe("newhash0123456789");
    expect(body.data.webhookUrl).toContain("/hooks/newhash0123456789");
    expect(updates).toHaveLength(1);
  });

  // REST 禁用不存在或跨组织触发器时不能误报操作成功。
  test("REST 禁用不存在触发器返回 404", async () => {
    stubDb({ select: () => queryResult([]) });

    const response = await jsonRequest("/workflow-defs/workflow-round67/triggers/missing-trigger/disable", {});

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe("NOT_FOUND");
  });

  // action 创建触发器必须将认证组织和用户写入服务输入。
  test("action 创建触发器返回当前组织的完整视图", async () => {
    const inserts: unknown[] = [];
    stubDb({
      select: () => queryResult([workflow()]),
      insert: () => ({
        values: (value: unknown) => {
          inserts.push(value);
          return { returning: () => Promise.resolve([trigger()]) };
        },
      }),
    });

    const response = await jsonRequest("/workflow-defs", {
      action: "createTrigger",
      workflowId: "workflow-round67",
      type: "webhook",
      config: { source: "action" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.publicHash).toBe("abcdef0123456789");
    expect(body.data.webhookUrl).toContain("/hooks/");
    expect(inserts).toHaveLength(1);
  });

  // action 重新生成哈希应返回更新后的完整触发器，而非旧的脱敏记录。
  test("action 重新生成当前组织触发器哈希", async () => {
    stubDb({
      select: queuedSelect([trigger()], [trigger({ publicHash: "actionhash01234567" })]),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    });

    const response = await jsonRequest("/workflow-defs", { action: "regenerateHash", triggerId: "trigger-round67" });

    expect(response.status).toBe(200);
    expect((await readJson(response)).data.publicHash).toBe("actionhash01234567");
  });

  // action 启用当前组织触发器应完成状态更新并返回空成功载荷。
  test("action 启用当前组织触发器返回成功", async () => {
    const updates: unknown[] = [];
    stubDb({
      select: () => queryResult([trigger({ enabled: false })]),
      update: () => ({
        set: (value: unknown) => {
          updates.push(value);
          return { where: () => Promise.resolve() };
        },
      }),
    });

    const response = await jsonRequest("/workflow-defs", { action: "enableTrigger", triggerId: "trigger-round67" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: null });
    expect(updates).toHaveLength(1);
  });
});
