import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { readJson, resetAllStubs, stubAuthApi, stubDb } from "../test-utils/helpers";

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

function setAuthenticatedOrg(organizationId = "org-round38") {
  setTestAuth({
    user: { id: "user-round38", email: "round38@test.invalid", name: "Round 38" },
    authContext: { organizationId, userId: "user-round38", role: "owner" },
  });
  setTestOrgContext({ organizationId, userId: "user-round38", role: "owner" });
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

function workflow(storagePath: string | null = null) {
  return {
    id: "workflow-round38",
    userId: "user-round38",
    organizationId: "org-round38",
    name: "Round 38 workflow",
    description: null,
    latestVersion: 2,
    storagePath,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
  };
}

function trigger(organizationId = "org-round38", enabled = true) {
  return {
    id: "trigger-round38",
    organizationId,
    workflowId: "workflow-round38",
    type: "webhook",
    publicHash: "123456abcdef",
    secret: null,
    config: { source: "round38" },
    enabled,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
  };
}

describe("Round 38 工作流定义路由行为", () => {
  beforeEach(() => {
    resetAllStubs();
    setAuthenticatedOrg();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  // 未认证用户不能扫描可恢复工作流目录。
  test("未认证扫描可恢复工作流返回 401", async () => {
    resetTestAuth();
    setTestOrgContext(null);
    stubAuthApi({ getSession: async () => null });

    const response = await request("/workflow-defs/recoverable");

    expect(response.status).toBe(401);
  });

  // 恢复请求的空数组必须在执行恢复前被 schema 拒绝。
  test("恢复空工作流列表返回 422", async () => {
    const response = await jsonRequest("/workflow-defs/recover", { workflowIds: [] });

    expect(response.status).toBe(422);
  });

  // REST 创建不接受只有空白字符的名称。
  test("REST 创建空白名称返回验证错误", async () => {
    const response = await jsonRequest("/workflow-defs", { name: "   " });

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("VALIDATION_ERROR");
  });

  // 兼容 action 创建同样不能绕过名称空白校验。
  test("action 创建空白名称返回验证错误", async () => {
    const response = await jsonRequest("/workflow-defs", { action: "create", name: "\t" });

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.message).toBe("name is required");
  });

  // 保存 action 必须同时包含工作流 ID 与非空 YAML。
  test("action 保存缺少 YAML 返回验证错误", async () => {
    const response = await jsonRequest("/workflow-defs", { action: "save", workflowId: "workflow-round38", yaml: "" });

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.message).toBe("workflowId and yaml are required");
  });

  // action 获取其他组织工作流不得泄露其详情。
  test("action 获取跨组织工作流返回 404", async () => {
    stubDb({ select: queuedSelect([]) });

    const response = await jsonRequest("/workflow-defs", { action: "get", workflowId: "workflow-foreign" });

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe("NOT_FOUND");
  });

  // action 获取版本时先校验工作流组织归属。
  test("action 获取跨组织版本返回 404", async () => {
    stubDb({ select: queuedSelect([]) });

    const response = await jsonRequest("/workflow-defs", {
      action: "getVersion",
      workflowId: "workflow-foreign",
      version: 1,
    });

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.message).toBe("Workflow not found");
  });

  // action 获取版本列表不暴露当前组织不可见工作流的版本。
  test("action 获取跨组织版本列表返回空数组", async () => {
    stubDb({ select: queuedSelect([]) });

    const response = await jsonRequest("/workflow-defs", { action: "getVersions", workflowId: "workflow-foreign" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: [] });
  });

  // action 设置最新版本成功时更新当前组织工作流。
  test("action 设置最新版本返回成功", async () => {
    const updates: unknown[] = [];
    stubDb({
      select: queuedSelect([{ id: "workflow-round38" }], [{ id: "version-row" }]),
      update: () => ({
        set: (value: unknown) => {
          updates.push(value);
          return { where: () => Promise.resolve() };
        },
      }),
    });

    const response = await jsonRequest("/workflow-defs", {
      action: "setLatest",
      workflowId: "workflow-round38",
      version: 2,
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: null });
    expect(updates).toHaveLength(1);
  });

  // action 更新不可见工作流时返回统一的未找到响应。
  test("action 更新跨组织元数据返回 404", async () => {
    stubDb({ update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }) });

    const response = await jsonRequest("/workflow-defs", {
      action: "updateMeta",
      workflowId: "workflow-foreign",
      name: "不应更新",
    });

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe("NOT_FOUND");
  });

  // action 删除当前组织工作流返回空成功载荷。
  test("action 删除当前组织工作流返回成功", async () => {
    stubDb({ delete: () => ({ where: () => ({ returning: () => Promise.resolve([{ storagePath: null }]) }) }) });

    const response = await jsonRequest("/workflow-defs", { action: "delete", workflowId: "workflow-round38" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: null });
  });

  // REST 更新的非字符串字段必须在仓储调用前被拒绝。
  test("REST 更新元数据的非字符串名称返回 422", async () => {
    const response = await jsonRequest("/workflow-defs/workflow-round38", { name: 42 }, "PATCH");

    expect(response.status).toBe(422);
  });

  // REST 删除遇到仓储异常时映射为受控内部错误。
  test("REST 删除仓储异常返回 500", async () => {
    stubDb({
      delete: () => {
        throw new Error("delete unavailable");
      },
    });

    const response = await request("/workflow-defs/workflow-round38", { method: "DELETE" });

    expect(response.status).toBe(500);
    expect((await readJson(response)).error.code).toBe("INTERNAL_ERROR");
  });

  // 版本恢复拒绝非数字路径参数，避免进入文件与仓储操作。
  test("恢复非数字版本返回验证错误", async () => {
    const response = await jsonRequest("/workflow-defs/workflow-round38/versions/invalid/restore", {});

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("VALIDATION_ERROR");
  });

  // 设置最新版本拒绝非数字路径参数。
  test("设置非数字最新版本返回验证错误", async () => {
    const response = await jsonRequest("/workflow-defs/workflow-round38/versions/invalid/set-latest", {});

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.message).toBe("workflowId and version are required");
  });

  // 参数定义未指定版本时采用当前工作流的 latestVersion。
  test("参数定义缺少 YAML 时使用最新版本并返回 404", async () => {
    stubDb({ select: queuedSelect([workflow(null)], []) });

    const response = await request("/workflow-defs/workflow-round38/params");

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.message).toBe("Version not found");
  });

  // 创建触发器默认采用 webhook 类型并返回完整视图。
  test("创建触发器默认类型返回完整 webhook URL", async () => {
    const inserted: unknown[] = [];
    const created = trigger();
    stubDb({
      select: queuedSelect([workflow()]),
      insert: () => ({
        values: (value: unknown) => {
          inserted.push(value);
          return { returning: () => Promise.resolve([created]) };
        },
      }),
    });

    const response = await jsonRequest("/workflow-defs/workflow-round38/triggers", {});
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.publicHash).toBe(created.publicHash);
    expect(body.data.webhookUrl).toContain("/hooks/");
    expect(inserted).toHaveLength(1);
  });

  // 列出触发器时必须遮蔽公开哈希而不返回 webhook URL。
  test("列出当前组织触发器返回脱敏视图", async () => {
    const listed = trigger();
    stubDb({ select: queuedSelect([workflow()], [listed]) });

    const response = await request("/workflow-defs/workflow-round38/triggers");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[0].publicHash).toBe("123456***");
    expect(body.data[0].webhookUrl).toBeNull();
  });

  // 删除当前组织触发器应在服务层确认归属后成功。
  test("删除当前组织触发器返回成功", async () => {
    stubDb({
      select: queuedSelect([trigger()]),
      delete: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: "trigger-round38" }]) }) }),
    });

    const response = await request("/workflow-defs/workflow-round38/triggers/trigger-round38", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: null });
  });

  // 启用当前组织触发器应更新其启用状态。
  test("启用当前组织触发器返回成功", async () => {
    const updates: unknown[] = [];
    stubDb({
      select: queuedSelect([trigger("org-round38", false)]),
      update: () => ({
        set: (value: unknown) => {
          updates.push(value);
          return { where: () => Promise.resolve() };
        },
      }),
    });

    const response = await jsonRequest("/workflow-defs/workflow-round38/triggers/trigger-round38/enable", {});

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: null });
    expect(updates).toHaveLength(1);
  });

  // 禁用当前组织触发器应更新其禁用状态。
  test("禁用当前组织触发器返回成功", async () => {
    const updates: unknown[] = [];
    stubDb({
      select: queuedSelect([trigger()]),
      update: () => ({
        set: (value: unknown) => {
          updates.push(value);
          return { where: () => Promise.resolve() };
        },
      }),
    });

    const response = await jsonRequest("/workflow-defs/workflow-round38/triggers/trigger-round38/disable", {});

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: null });
    expect(updates).toHaveLength(1);
  });

  // action 启用其他组织触发器必须保持隔离。
  test("action 启用跨组织触发器返回 404", async () => {
    stubDb({ select: queuedSelect([trigger("org-foreign")]) });

    const response = await jsonRequest("/workflow-defs", { action: "enableTrigger", triggerId: "trigger-round38" });

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.message).toBe("Trigger not found");
  });

  // action 禁用其他组织触发器必须保持隔离。
  test("action 禁用跨组织触发器返回 404", async () => {
    stubDb({ select: queuedSelect([trigger("org-foreign")]) });

    const response = await jsonRequest("/workflow-defs", { action: "disableTrigger", triggerId: "trigger-round38" });

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe("NOT_FOUND");
  });
});
