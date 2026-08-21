import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { WorkflowError, WorkflowErrorCode } from "@fenix/workflow-engine";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { getTeamEngine } from "../services/workflow";
import { readJson, resetAllStubs, stubAuthApi } from "../test-utils/helpers";

const route = (await import("../routes/web/workflow-runs")).workflowRunsRoutes;

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function setAuthenticatedOrg(organizationId: string) {
  setTestAuth({
    user: { id: "user-1", email: "user@test.com", name: "Tester" },
    authContext: { organizationId, userId: "user-1", role: "owner" },
  });
  setTestOrgContext({ organizationId, userId: "user-1", role: "owner" });
}

describe("Workflow runs routes isolation and state boundaries", () => {
  beforeEach(() => {
    resetAllStubs();
    setAuthenticatedOrg("org-runs-1");
  });

  afterEach(() => {
    mock.restore();
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  // 运行状态查询必须只调用当前认证组织对应的 engine，避免跨组织读取同名 runId。
  test("状态查询按当前组织隔离 engine", async () => {
    const firstOrgEngine = getTeamEngine("org-runs-1");
    const secondOrgEngine = getTeamEngine("org-runs-2");
    const firstStatus = spyOn(firstOrgEngine, "getRunStatus").mockResolvedValue(null);
    const secondStatus = spyOn(secondOrgEngine, "getRunStatus").mockResolvedValue(null);

    const firstResponse = await request("/workflow-runs/run-shared-id");
    setAuthenticatedOrg("org-runs-2");
    const secondResponse = await request("/workflow-runs/run-shared-id");

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(await readJson(firstResponse)).toEqual({ success: true, data: null });
    expect(await readJson(secondResponse)).toEqual({ success: true, data: null });
    expect(firstStatus).toHaveBeenCalledTimes(1);
    expect(secondStatus).toHaveBeenCalledTimes(1);
    expect(firstStatus).toHaveBeenCalledWith("run-shared-id");
    expect(secondStatus).toHaveBeenCalledWith("run-shared-id");
  });

  // 取消不存在或不属于当前组织的运行必须统一映射为 404，不能泄露引擎内部错误。
  test("取消不存在运行映射为 404", async () => {
    const engine = getTeamEngine("org-runs-1");
    spyOn(engine, "cancel").mockRejectedValue(new WorkflowError("run not found", WorkflowErrorCode.RUN_NOT_FOUND));

    const response = await request("/workflow-runs/run-missing/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: WorkflowErrorCode.RUN_NOT_FOUND, message: "run not found" },
    });
  });

  // 取消请求可安全重试：路由不缓存结果，每次请求都转交同一组织 engine 处理幂等语义。
  test("重复取消请求分别转交同一组织 engine", async () => {
    const engine = getTeamEngine("org-runs-1");
    const cancel = spyOn(engine, "cancel").mockResolvedValue();

    const responses = await Promise.all([
      request("/workflow-runs/run-retry/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      request("/workflow-runs/run-retry/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenNthCalledWith(1, "run-retry");
    expect(cancel).toHaveBeenNthCalledWith(2, "run-retry");
  });

  // 审批缺少 token 时必须在进入 engine 前由 schema 拒绝，防止不完整状态转换。
  test("审批缺少 token 返回 422 且不调用 engine", async () => {
    const engine = getTeamEngine("org-runs-1");
    const approveNode = spyOn(engine, "approveNode");

    const response = await request("/workflow-runs/run-approval/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "approval-node" }),
    });

    expect(response.status).toBe(422);
    expect(approveNode).not.toHaveBeenCalled();
  });

  // 运行事件读取应将可选 nodeId 原样传给当前组织 engine，保持服务端过滤边界。
  test("事件查询将 nodeId 限定传给当前组织 engine", async () => {
    const engine = getTeamEngine("org-runs-1");
    const getEvents = spyOn(engine, "getEvents").mockResolvedValue([]);

    const response = await request("/workflow-runs/run-events/events?nodeId=node-private");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: [] });
    expect(getEvents).toHaveBeenCalledWith("run-events", { nodeId: "node-private" });
  });

  // 未认证请求必须在调用 engine 之前由认证插件拒绝，避免绕过组织上下文。
  test("未认证审批返回 401 且不调用 engine", async () => {
    const engine = getTeamEngine("org-runs-1");
    const approveNode = spyOn(engine, "approveNode");
    resetTestAuth();
    setTestOrgContext(null);
    stubAuthApi({ getSession: async () => null });

    const response = await request("/workflow-runs/run-approval/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "approval-node", token: "approval-token" }),
    });

    expect(response.status).toBe(401);
    expect(approveNode).not.toHaveBeenCalled();
  });

  for (const index of Array.from({ length: 4 }, (_, value) => value + 1)) {
    test(`取消当前组织运行并发布状态第${index}例`, async () => {
      const cancel = spyOn(getTeamEngine("org-runs-1"), "cancel").mockResolvedValue();

      const response = await request(`/workflow-runs/run-cancel-${index}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId: `workflow-cancel-${index}` }),
      });

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ success: true, data: null });
      expect(cancel).toHaveBeenCalledWith(`run-cancel-${index}`);
    });
  }
});
