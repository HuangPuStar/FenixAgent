import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { createWebWorkflowRunsRoutes } from "../server/routes/web/workflow-runs";
import { initializeWorkflowModuleConfig, stubPgStorageAdapter } from "../server/testing";
import { createStubSessionAuthGuard } from "./guard-stubs";

// route 模块导入 — pg-storage-adapter 已在 setup-mocks.ts 中通过 preload mock 注册，
// stub 行为通过 stubPgStorageAdapter() 在 beforeEach 中配置
const guard = createStubSessionAuthGuard();

// 路由经工厂构造并注入会话守卫替身：静态条件禁止包内测试依赖宿主 `@server/plugins/auth`，
// 而 Elysia 的 macro/state 是实例作用域的，守卫必须是构造时传入的同一实例。
const route = createWebWorkflowRunsRoutes({ authGuardPlugin: guard });

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

describe("GET /web/workflow-runs", () => {
  const mockListRuns = mock();

  beforeEach(() => {
    initializeWorkflowModuleConfig();
    guard.setActor({ organizationId: "org-1", userId: "org-1" });
    mockListRuns.mockReset();
    stubPgStorageAdapter({ listRuns: mockListRuns });
  });

  afterEach(() => {
    guard.setActor(null);
    resetAllStubs();
  });

  // 正常分页查询，传入 page=1 pageSize=10，验证返回 data.items 数组和 data.total
  test("GET /workflow-runs?page=1&pageSize=10 返回分页数据", async () => {
    mockListRuns.mockImplementation(() =>
      Promise.resolve({
        items: [{ run_id: "run-1", workflow_name: "test-workflow" }],
        total: 1,
      }),
    );

    const res = await request("/workflow-runs?page=1&pageSize=10");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.items)).toBe(true);
    expect(json.data.items.length).toBe(1);
    expect(json.data.total).toBe(1);
    expect(json.data.page).toBe(1);
    expect(json.data.pageSize).toBe(10);
  });

  // 不传 page/pageSize，验证使用默认值 page=1, pageSize=20
  test("GET /workflow-runs 不传分页参数时使用默认值", async () => {
    mockListRuns.mockImplementation(() => Promise.resolve({ items: [], total: 0 }));

    const res = await request("/workflow-runs");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    // 验证 route 将默认值传入 listRuns
    expect(mockListRuns).toHaveBeenCalledWith({ page: 1, pageSize: 20, status: undefined, q: undefined });
  });

  // 传入 status=RUNNING，验证 query 参数正确传递
  test("GET /workflow-runs?status=RUNNING 按状态过滤", async () => {
    mockListRuns.mockImplementation(() => Promise.resolve({ items: [], total: 0 }));

    const res = await request("/workflow-runs?status=RUNNING");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockListRuns).toHaveBeenCalledWith({ page: 1, pageSize: 20, status: "RUNNING", q: undefined });
  });

  // 传入 q=测试，验证 query 参数正确传递
  test("GET /workflow-runs?q=测试 按名称搜索", async () => {
    mockListRuns.mockImplementation(() => Promise.resolve({ items: [], total: 0 }));

    const res = await request("/workflow-runs?q=%E6%B5%8B%E8%AF%95");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockListRuns).toHaveBeenCalledWith({ page: 1, pageSize: 20, status: undefined, q: "测试" });
  });

  // 不设置 auth context，验证返回 401
  test("未设置 auth context 返回 401 未认证", async () => {
    guard.setActor(null);
    // sessionAuth macro 在 _testAuth 为 null 时会走真实认证链路，
    // getSession 返回 null 触发 API key fallback，无 key 时最终返回 401
    guard.setActor(null);

    const res = await request("/workflow-runs");
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.type).toBe("unauthorized");
  });

  // 传入 pageSize=200 超过 100 上限，验证返回 400 参数校验错误
  test("GET /workflow-runs?pageSize=200 返回 400 参数校验错误", async () => {
    const res = await request("/workflow-runs?pageSize=200");
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("INVALID_PARAMS");
    // 验证校验失败时不调用 listRuns
    expect(mockListRuns).not.toHaveBeenCalled();
  });
});
