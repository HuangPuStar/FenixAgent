import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubAuthApi, stubDb } from "../test-utils/helpers";

const workflowDefsRoute = (await import("../routes/web/workflow-defs")).default;

function request(path: string, init?: RequestInit) {
  return workflowDefsRoute.handle(new Request(`http://localhost${path}`, init));
}

function setAuthenticatedOrg(organizationId = "org-1") {
  setTestAuth({
    user: { id: "user-1", email: "user@test.com", name: "Tester" },
    authContext: { organizationId, userId: "user-1", role: "owner" },
  });
  setTestOrgContext({ organizationId, userId: "user-1", role: "owner" });
}

function queryResult(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        orderBy: () => Promise.resolve(rows),
        limit: () => Promise.resolve(rows),
      }),
    }),
  };
}

function asJson(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

describe("Web Workflow Definition Routes", () => {
  beforeEach(() => {
    resetAllStubs();
    setAuthenticatedOrg();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  // 未认证调用工作流定义列表必须在进入仓储前被认证插件拒绝。
  test("未认证获取工作流列表返回 401", async () => {
    resetTestAuth();
    setTestOrgContext(null);
    stubAuthApi({ getSession: async () => null });

    const response = await request("/workflow-defs");

    expect(response.status).toBe(401);
    expect((await response.json()).error.type).toBe("unauthorized");
  });

  // 工作流列表只能通过当前认证组织的查询链路返回，不能依赖请求方传入组织标识。
  test("获取工作流列表返回当前组织的仓储结果", async () => {
    const workflows = [
      {
        id: "workflow-1",
        userId: "user-1",
        organizationId: "org-1",
        name: "当前组织工作流",
        description: null,
        latestVersion: null,
        storagePath: null,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-02"),
      },
    ];
    stubDb({ select: () => queryResult(workflows) });

    const response = await request("/workflow-defs?organizationId=org-2");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: asJson(workflows) });
  });

  // 跨组织或不存在的工作流详情必须统一映射为 404，避免泄露资源存在性。
  test("查询不可访问的工作流详情返回 404", async () => {
    stubDb({ select: () => queryResult([]) });

    const response = await request("/workflow-defs/workflow-from-another-org");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Workflow not found" },
    });
  });

  // 可访问的工作流详情应携带草稿字段；空 storagePath 不应触发任何文件系统读取。
  test("查询当前组织工作流详情返回草稿字段", async () => {
    const workflow = {
      id: "workflow-1",
      userId: "user-1",
      organizationId: "org-1",
      name: "当前组织工作流",
      description: "说明",
      latestVersion: 1,
      storagePath: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
    };
    stubDb({ select: () => queryResult([workflow]) });

    const response = await request("/workflow-defs/workflow-1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { ...asJson(workflow), draftYaml: null } });
  });

  // 创建请求缺少必填名称时必须被路由参数校验拒绝，且不执行数据库写入。
  test("创建工作流时缺少名称返回 422", async () => {
    const insert = mock();
    stubDb({ insert });

    const response = await request("/workflow-defs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(422);
    expect(insert).not.toHaveBeenCalled();
  });

  // 更新元数据时仓储返回记录应被映射为标准成功响应。
  test("更新当前组织工作流元数据返回更新后的记录", async () => {
    const updated = {
      id: "workflow-1",
      userId: "user-1",
      organizationId: "org-1",
      name: "新名称",
      description: "新说明",
      latestVersion: null,
      storagePath: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-03"),
    };
    stubDb({
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([updated]) }),
        }),
      }),
    });

    const response = await request("/workflow-defs/workflow-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "新名称", description: "新说明" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: asJson(updated) });
  });

  // 唯一约束异常必须被映射为 409，而非向客户端暴露为通用服务器错误。
  test("更新工作流遇到唯一约束异常返回 409", async () => {
    const duplicateKeyError = new Error("update failed", { cause: new Error("duplicate key value") });
    stubDb({
      update: () => ({
        set: () => {
          throw duplicateKeyError;
        },
      }),
    });

    const response = await request("/workflow-defs/workflow-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "重复名称" }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("CONFLICT");
  });

  // 删除仓储未匹配当前组织资源时必须返回 404，避免误报删除成功。
  test("删除不可访问工作流返回 404", async () => {
    stubDb({
      delete: () => ({
        where: () => ({ returning: () => Promise.resolve([]) }),
      }),
    });

    const response = await request("/workflow-defs/workflow-from-another-org", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });
});
