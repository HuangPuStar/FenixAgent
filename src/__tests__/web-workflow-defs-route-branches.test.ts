import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const workflowDefsRoute = (await import("../routes/web/workflow-defs")).default;
const WORKFLOW_BASE_DIR = join(process.cwd(), ".agents", "workflows");
const testStoragePath = join(WORKFLOW_BASE_DIR, "org-current", "workflow-1");

function request(path: string, init?: RequestInit) {
  return workflowDefsRoute.handle(new Request(`http://localhost${path}`, init));
}

function jsonRequest(path: string, body: Record<string, unknown>, method = "POST") {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setAuthenticatedOrg(organizationId = "org-current") {
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
    id: "workflow-1",
    userId: "user-1",
    organizationId: "org-current",
    name: "当前工作流",
    description: null,
    latestVersion: 2,
    storagePath,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
  };
}

function trigger(organizationId = "org-current") {
  return {
    id: "trigger-1",
    organizationId,
    workflowId: "workflow-1",
    type: "webhook",
    publicHash: "abcdef123456",
    secret: null,
    config: null,
    enabled: true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
  };
}

describe("Web Workflow Definition Routes 补充分支", () => {
  beforeEach(() => {
    resetAllStubs();
    setAuthenticatedOrg();
  });

  afterEach(async () => {
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
    await rm(testStoragePath, { recursive: true, force: true });
  });

  // 保存草稿应在当前组织工作流目录写入 YAML，并补建 draft 版本记录。
  test("保存草稿写入当前组织的工作流目录", async () => {
    const inserted: unknown[] = [];
    stubDb({
      select: queuedSelect([workflow(testStoragePath)], []),
      insert: () => ({
        values: (value: unknown) => {
          inserted.push(value);
          return Promise.resolve();
        },
      }),
      update: () => ({
        set: () => ({ where: () => Promise.resolve() }),
      }),
    });

    const response = await jsonRequest("/workflow-defs/workflow-1/draft", { yaml: "name: saved-draft" }, "PUT");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
    expect(await Bun.file(join(testStoragePath, "draft.yaml")).text()).toBe("name: saved-draft");
    expect(inserted).toHaveLength(1);
  });

  // 版本列表应在当前组织找不到工作流时返回空数组，而不是暴露其他组织版本。
  test("跨组织工作流的版本列表返回空数组", async () => {
    stubDb({ select: queuedSelect([]) });

    const response = await request("/workflow-defs/other-workflow/versions");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: [] });
  });

  // 非数字版本号必须由路由显式拒绝，避免传入仓储查询。
  test("读取非数字版本返回验证错误", async () => {
    const response = await request("/workflow-defs/workflow-1/versions/not-a-number");

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  // 指定版本前先验证工作流组织归属，跨组织资源统一映射为 404。
  test("读取跨组织版本返回工作流不存在", async () => {
    stubDb({ select: queuedSelect([]) });

    const response = await request("/workflow-defs/other-workflow/versions/1");

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Workflow not found");
  });

  // 已授权工作流存在对应 YAML 文件时，应导出请求版本内容和版本号。
  test("读取指定版本返回导出的 YAML", async () => {
    await mkdir(testStoragePath, { recursive: true });
    await Bun.write(join(testStoragePath, "v2.yaml"), "name: exported-workflow");
    stubDb({ select: queuedSelect([workflow(testStoragePath)]) });

    const response = await request("/workflow-defs/workflow-1/versions/2");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { workflowId: "workflow-1", version: 2, yaml: "name: exported-workflow" },
    });
  });

  // 已授权工作流没有对应 YAML 文件时不能返回空成功响应。
  test("读取不存在的版本文件返回版本不存在", async () => {
    stubDb({ select: queuedSelect([workflow(null)]) });

    const response = await request("/workflow-defs/workflow-1/versions/2");

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Version not found");
  });

  // 设置最新版本必须验证工作流属于当前组织，仓储错误应保留为受控 500 响应。
  test("设置跨组织最新版本返回内部错误", async () => {
    stubDb({ select: queuedSelect([]) });

    const response = await jsonRequest("/workflow-defs/other-workflow/versions/2/set-latest", {});

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
  });

  // 设置不存在版本时不应更新工作流 latestVersion。
  test("设置不存在版本返回内部错误", async () => {
    stubDb({ select: queuedSelect([{ id: "workflow-1" }], []) });

    const response = await jsonRequest("/workflow-defs/workflow-1/versions/99/set-latest", {});

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe("Version 99 not found");
  });

  // 参数定义读取必须先完成组织隔离检查。
  test("读取跨组织参数定义返回工作流不存在", async () => {
    stubDb({ select: queuedSelect([]) });

    const response = await request("/workflow-defs/other-workflow/params");

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Workflow not found");
  });

  // 参数定义的版本 query 必须满足正整数 Zod 约束。
  test("读取参数定义时零版本查询返回 422", async () => {
    const response = await request("/workflow-defs/workflow-1/params?version=0");

    expect(response.status).toBe(422);
  });

  // 未初始化存储目录的工作流不能伪造参数定义成功响应。
  test("读取缺失 YAML 的参数定义返回版本不存在", async () => {
    stubDb({ select: queuedSelect([workflow(null)]) });

    const response = await request("/workflow-defs/workflow-1/params?version=2");

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Version not found");
  });

  // 创建触发器前必须验证工作流归属，避免向其他组织资源写入触发器。
  test("为跨组织工作流创建触发器返回 404", async () => {
    stubDb({ select: queuedSelect([]) });

    const response = await jsonRequest("/workflow-defs/other-workflow/triggers", { type: "webhook" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 触发器请求 config 不是对象时必须由 Zod 在服务调用前拒绝。
  test("创建触发器的非对象配置返回 422", async () => {
    const response = await jsonRequest("/workflow-defs/workflow-1/triggers", { config: "invalid" });

    expect(response.status).toBe(422);
  });

  // 列表触发器也必须验证父工作流的组织可见性。
  test("列出跨组织工作流触发器返回 404", async () => {
    stubDb({ select: queuedSelect([]) });

    const response = await request("/workflow-defs/other-workflow/triggers");

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 删除触发器时服务层必须拒绝不属于当前组织的触发器。
  test("删除其他组织触发器返回 404", async () => {
    stubDb({ select: queuedSelect([trigger("org-other")]) });

    const response = await request("/workflow-defs/workflow-1/triggers/trigger-1", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Trigger not found");
  });

  // 重新生成哈希不得越过组织边界读取或更新其他组织触发器。
  test("重新生成其他组织触发器哈希返回 404", async () => {
    stubDb({ select: queuedSelect([trigger("org-other")]) });

    const response = await jsonRequest("/workflow-defs/workflow-1/triggers/trigger-1/regenerate", {});

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 启用触发器必须保留服务层组织隔离，即使 URL 中包含任意 workflowId。
  test("启用其他组织触发器返回 404", async () => {
    stubDb({ select: queuedSelect([trigger("org-other")]) });

    const response = await jsonRequest("/workflow-defs/workflow-1/triggers/trigger-1/enable", {});

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Trigger not found");
  });

  // 禁用触发器同样必须拒绝其他组织记录，不能因路径参数而绕过隔离。
  test("禁用其他组织触发器返回 404", async () => {
    stubDb({ select: queuedSelect([trigger("org-other")]) });

    const response = await jsonRequest("/workflow-defs/workflow-1/triggers/trigger-1/disable", {});

    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Trigger not found");
  });

  // action 协议不认识的动作必须走统一验证错误映射，而不是落入默认业务分支。
  test("未知 action 被 Zod 拒绝", async () => {
    const response = await jsonRequest("/workflow-defs", { action: "unknown-action" });

    expect(response.status).toBe(422);
  });

  // action 导入的版本号类型必须满足 schema，避免字符串版本号进入版本仓储。
  test("action 获取版本的字符串版本号返回 422", async () => {
    const response = await jsonRequest("/workflow-defs", {
      action: "getVersion",
      workflowId: "workflow-1",
      version: "2",
    });

    expect(response.status).toBe(422);
  });
});
