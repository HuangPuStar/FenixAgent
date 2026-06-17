import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubAuthApi } from "../test-utils/helpers";

// 必须在 route 模块导入前注册 mock，避免调用真实 DB
const mockListRuns = mock();

mock.module("../services/workflow/pg-storage-adapter", () => ({
  createPgStorageAdapter: () => ({
    listRuns: mockListRuns,
  }),
}));

// 注意：workflowRunsRoutes 未设置 prefix，路由路径为 /workflow-runs
// /web 前缀由父级 index.ts 的 webApp 统一添加
const route = (await import("../routes/web/workflow-runs")).workflowRunsRoutes;

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

describe("GET /web/workflow-runs", () => {
  beforeEach(() => {
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    mockListRuns.mockReset();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
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
    resetTestAuth();
    setTestOrgContext(null);
    // sessionAuth macro 在 _testAuth 为 null 时会走真实认证链路，
    // getSession 返回 null 触发 API key fallback，无 key 时最终返回 401
    stubAuthApi({ getSession: async () => null });

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
