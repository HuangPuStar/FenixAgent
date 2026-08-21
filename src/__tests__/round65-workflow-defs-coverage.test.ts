import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

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

function setAuthenticatedOrg(organizationId = "org-round65") {
  setTestAuth({
    user: { id: "user-round65", email: "round65@test.com", name: "Round 65" },
    authContext: { organizationId, userId: "user-round65", role: "owner" },
  });
  setTestOrgContext({ organizationId, userId: "user-round65", role: "owner" });
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
    id: "workflow-round65",
    userId: "user-round65",
    organizationId: "org-round65",
    name: "Round 65 工作流",
    description: "覆盖分支",
    latestVersion: 3,
    storagePath,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  };
}

function trigger(organizationId = "org-round65") {
  return {
    id: "trigger-round65",
    organizationId,
    workflowId: "workflow-round65",
    type: "webhook",
    publicHash: "abcdef0123456789",
    secret: null,
    config: { source: "round65" },
    enabled: true,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  };
}

describe("workflow-defs 第六十五轮真实路由分支", () => {
  beforeEach(() => {
    resetAllStubs();
    setAuthenticatedOrg();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  // action list 必须使用认证组织查询，不接受请求体中的伪造组织标识。
  test("action list 返回当前组织的工作流", async () => {
    const rows = [workflow()];
    stubDb({ select: () => queryResult(rows) });

    const response = await jsonRequest("/workflow-defs", { action: "list", organizationId: "other-org" });

    expect(response.status).toBe(200);
    expect((await response.json()).data[0].organizationId).toBe("org-round65");
  });

  // action get 在工作流不存在时不能泄露跨组织资源。
  test("action get 隔离其他组织工作流", async () => {
    stubDb({ select: () => queryResult([]) });

    const response = await jsonRequest("/workflow-defs", { action: "get", workflowId: "other-workflow" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // action get 对没有存储目录的工作流仍返回详情和空草稿。
  test("action get 返回未初始化工作流的空草稿", async () => {
    stubDb({ select: () => queryResult([workflow(null)]) });

    const response = await jsonRequest("/workflow-defs", { action: "get", workflowId: "workflow-round65" });

    expect(response.status).toBe(200);
    expect((await response.json()).data.draftYaml).toBeNull();
  });

  // action getVersions 应保留工作流版本历史的仓储结果。
  test("action getVersions 返回版本历史", async () => {
    const versions = [
      {
        id: "version-3",
        workflowId: "workflow-round65",
        version: 3,
        filePath: "v3.yaml",
        status: "published",
        createdBy: "user-round65",
        createdAt: new Date(),
      },
    ];
    stubDb({ select: () => queryResult(versions) });

    const response = await jsonRequest("/workflow-defs", { action: "getVersions", workflowId: "workflow-round65" });

    expect(response.status).toBe(200);
    expect((await response.json()).data[0].version).toBe(3);
  });

  // action getVersion 先校验组织归属，再决定版本文件是否存在。
  test("action getVersion 对跨组织工作流返回工作流不存在", async () => {
    stubDb({ select: () => queryResult([]) });

    const response = await jsonRequest("/workflow-defs", {
      action: "getVersion",
      workflowId: "other-workflow",
      version: 2,
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Workflow not found");
  });

  // action getVersion 在存储缺失时映射为版本不存在而非空成功响应。
  test("action getVersion 缺少 YAML 返回版本不存在", async () => {
    stubDb({ select: () => queryResult([workflow(null)]) });

    const response = await jsonRequest("/workflow-defs", {
      action: "getVersion",
      workflowId: "workflow-round65",
      version: 2,
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Version not found");
  });

  // REST 版本 YAML 路由应拒绝非数字版本，避免进入文件读取层。
  test("REST 版本 YAML 拒绝非数字版本", async () => {
    const response = await request("/workflow-defs/workflow-round65/versions/not-a-version");

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  // REST 草稿保存的空 YAML 由路由业务校验拒绝，不进行任何持久化。
  test("REST 草稿保存拒绝空 YAML", async () => {
    const response = await jsonRequest("/workflow-defs/workflow-round65/draft", { yaml: "" }, "PUT");

    expect(response.status).toBe(400);
  });

  // action save 缺少 YAML 时走兼容协议自身的业务校验。
  test("action save 缺少 YAML 返回验证错误", async () => {
    const response = await jsonRequest("/workflow-defs", { action: "save", workflowId: "workflow-round65" });

    expect(response.status).toBe(422);
  });

  // REST 发布仓储异常必须统一映射为内部错误。
  test("REST 发布异常映射为内部错误", async () => {
    stubDb({ transaction: () => Promise.reject(new Error("publish unavailable")) });

    const response = await jsonRequest("/workflow-defs/workflow-round65/publish", {});

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe("publish unavailable");
  });

  // action setLatest 在组织内找不到工作流时不可伪造版本更新成功。
  test("action setLatest 隔离跨组织工作流", async () => {
    stubDb({ select: () => queryResult([]) });

    const response = await jsonRequest("/workflow-defs", {
      action: "setLatest",
      workflowId: "other-workflow",
      version: 2,
    });

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
  });

  // REST 恢复确认的空列表应在服务调用前被 schema 阻止。
  test("REST 恢复确认拒绝空工作流列表", async () => {
    const response = await jsonRequest("/workflow-defs/recover", { workflowIds: [] });

    expect(response.status).toBe(422);
  });

  // action recoverApply 同样拒绝空恢复列表，兼容入口不能绕过约束。
  test("action recoverApply 拒绝空工作流列表", async () => {
    const response = await jsonRequest("/workflow-defs", { action: "recoverApply", workflowIds: [] });

    expect(response.status).toBe(422);
  });

  // action restoreToDraft 在仓储异常时返回受控错误，不暴露未处理异常。
  test("action restoreToDraft 映射恢复异常", async () => {
    stubDb({ select: () => queryResult([]) });

    const response = await jsonRequest("/workflow-defs", {
      action: "restoreToDraft",
      workflowId: "other-workflow",
      version: 1,
    });

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
  });

  // action delete 对当前组织中不存在的工作流返回 404。
  test("action delete 返回工作流不存在", async () => {
    stubDb({ delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) });

    const response = await jsonRequest("/workflow-defs", { action: "delete", workflowId: "missing-workflow" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Workflow not found");
  });

  // action updateMeta 对未命中组织范围的更新不能报告成功。
  test("action updateMeta 隔离未命中工作流", async () => {
    stubDb({ update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }) });

    const response = await jsonRequest("/workflow-defs", {
      action: "updateMeta",
      workflowId: "other-workflow",
      name: "新名称",
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // action createTrigger 必须先验证父工作流，跨组织目标不能写入触发器。
  test("action createTrigger 隔离跨组织父工作流", async () => {
    stubDb({ select: () => queryResult([]) });

    const response = await jsonRequest("/workflow-defs", { action: "createTrigger", workflowId: "other-workflow" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Workflow not found");
  });

  // action listTriggers 对认证组织内的触发器进行脱敏展示。
  test("action listTriggers 返回脱敏公开哈希", async () => {
    stubDb({ select: queuedSelect([workflow()], [trigger()]) });

    const response = await jsonRequest("/workflow-defs", { action: "listTriggers", workflowId: "workflow-round65" });

    expect(response.status).toBe(200);
    expect((await response.json()).data[0].publicHash).toBe("abcdef***");
  });

  // action deleteTrigger 不允许 URL 或 action 参数绕过触发器的组织隔离。
  test("action deleteTrigger 隔离其他组织触发器", async () => {
    stubDb({ select: () => queryResult([trigger("other-org")]) });

    const response = await jsonRequest("/workflow-defs", { action: "deleteTrigger", triggerId: "trigger-round65" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Trigger not found");
  });

  // action regenerateHash 对不存在的触发器返回 404，而不是生成无主公开地址。
  test("action regenerateHash 返回触发器不存在", async () => {
    stubDb({ select: () => queryResult([]) });

    const response = await jsonRequest("/workflow-defs", { action: "regenerateHash", triggerId: "missing-trigger" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // REST 启用触发器服务异常应映射为内部错误响应。
  test("REST 启用触发器映射仓储异常", async () => {
    stubDb({
      select: () => {
        throw new Error("trigger store offline");
      },
    });

    const response = await jsonRequest("/workflow-defs/workflow-round65/triggers/trigger-round65/enable", {});

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe("trigger store offline");
  });

  // action disableTrigger 保持组织隔离，其他组织记录不能被禁用。
  test("action disableTrigger 隔离其他组织触发器", async () => {
    stubDb({ select: () => queryResult([trigger("other-org")]) });

    const response = await jsonRequest("/workflow-defs", { action: "disableTrigger", triggerId: "trigger-round65" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Trigger not found");
  });

  // action getParamDefs 缺少 YAML 时返回版本不存在，不能返回伪造参数。
  test("action getParamDefs 缺少 YAML 返回版本不存在", async () => {
    stubDb({ select: () => queryResult([workflow(null)]) });

    const response = await jsonRequest("/workflow-defs", {
      action: "getParamDefs",
      workflowId: "workflow-round65",
      version: 3,
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Version not found");
  });
});
