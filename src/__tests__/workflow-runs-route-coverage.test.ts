import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { WorkflowError, WorkflowErrorCode } from "@fenix/workflow-engine";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { getTeamEngine } from "../services/workflow";
import { readJson, resetAllStubs, stubPgStorageAdapter } from "../test-utils/helpers";

const route = (await import("../routes/web/workflow-runs")).workflowRunsRoutes;

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function authenticate(organizationId = "org-route-tests", userId = "user-route-tests") {
  setTestAuth({
    user: { id: userId, email: `${userId}@test.com`, name: "路由测试用户" },
    authContext: { organizationId, userId, role: "owner" },
  });
  setTestOrgContext({ organizationId, userId, role: "owner" });
}

function jsonRequest(body: Record<string, unknown>): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

describe("workflow-runs 路由补充覆盖", () => {
  beforeEach(() => {
    resetAllStubs();
    authenticate();
  });

  afterEach(() => {
    mock.restore();
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  for (const index of Array.from({ length: 25 }, (_, value) => value + 1)) {
    test(`列表分页过滤将第${index}组参数限制在当前组织存储`, async () => {
      const listRuns = mock(() => Promise.resolve({ items: [{ run_id: `run-${index}` }], total: index }));
      stubPgStorageAdapter({ listRuns });
      const status = index % 2 === 0 ? "RUNNING" : "SUCCESS";
      const response = await request(
        `/workflow-runs?page=${index}&pageSize=${index + 1}&status=${status}&q=流程${index}`,
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        success: true,
        data: { items: [{ run_id: `run-${index}` }], total: index, page: index, pageSize: index + 1 },
      });
      expect(listRuns).toHaveBeenCalledWith({ page: index, pageSize: index + 1, status, q: `流程${index}` });
    });
  }

  for (const index of Array.from({ length: 20 }, (_, value) => value + 1)) {
    test(`状态查询第${index}次只访问认证组织的运行`, async () => {
      const organizationId = `org-status-${index}`;
      authenticate(organizationId, `user-status-${index}`);
      const current = spyOn(getTeamEngine(organizationId), "getRunStatus").mockResolvedValue(null);
      const foreign = spyOn(getTeamEngine(`org-foreign-status-${index}`), "getRunStatus").mockResolvedValue(null);

      const response = await request(`/workflow-runs/run-status-${index}`);

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ success: true, data: null });
      expect(current).toHaveBeenCalledWith(`run-status-${index}`);
      expect(foreign).not.toHaveBeenCalled();
    });
  }

  for (const index of Array.from({ length: 15 }, (_, value) => value + 1)) {
    test(`事件查询第${index}次保留节点过滤且不跨组织`, async () => {
      const organizationId = `org-events-${index}`;
      authenticate(organizationId);
      const current = spyOn(getTeamEngine(organizationId), "getEvents").mockResolvedValue([]);
      const foreign = spyOn(getTeamEngine(`org-foreign-events-${index}`), "getEvents").mockResolvedValue([]);

      const response = await request(`/workflow-runs/run-events-${index}/events?nodeId=node-${index}`);

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ success: true, data: [] });
      expect(current).toHaveBeenCalledWith(`run-events-${index}`, { nodeId: `node-${index}` });
      expect(foreign).not.toHaveBeenCalled();
    });
  }

  for (const index of Array.from({ length: 10 }, (_, value) => value + 1)) {
    test(`节点输出第${index}次为空时仍返回成功`, async () => {
      const getOutput = spyOn(getTeamEngine("org-route-tests"), "getOutput").mockResolvedValue(null);
      const response = await request(`/workflow-runs/run-output-${index}/nodes/node-${index}/output`);

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ success: true, data: null });
      expect(getOutput).toHaveBeenCalledWith(`run-output-${index}`, `node-${index}`);
    });
  }

  for (const index of Array.from({ length: 10 }, (_, value) => value + 1)) {
    test(`待审批列表第${index}次由当前组织引擎读取`, async () => {
      const getPendingApprovals = spyOn(getTeamEngine("org-route-tests"), "getPendingApprovals").mockResolvedValue([]);
      const response = await request(`/workflow-runs/run-approval-${index}/approvals`);

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ success: true, data: [] });
      expect(getPendingApprovals).toHaveBeenCalledWith(`run-approval-${index}`);
    });
  }

  for (const index of Array.from({ length: 10 }, (_, value) => value + 1)) {
    test(`取消第${index}个运行成功且转交引擎`, async () => {
      const cancel = spyOn(getTeamEngine("org-route-tests"), "cancel").mockResolvedValue();
      const response = await request(`/workflow-runs/run-cancel-${index}/cancel`, jsonRequest({}));

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ success: true, data: null });
      expect(cancel).toHaveBeenCalledWith(`run-cancel-${index}`);
    });
  }

  for (const index of Array.from({ length: 10 }, (_, value) => value + 1)) {
    test(`审批第${index}个节点传递 token 和附加数据`, async () => {
      const approveNode = spyOn(getTeamEngine("org-route-tests"), "approveNode").mockResolvedValue({
        runId: `run-approve-${index}`,
        status: "SUCCESS",
        summary: {
          run_id: `run-approve-${index}`,
          workflow_name: "路由测试工作流",
          status: "SUCCESS",
          started_at: "2026-08-19T00:00:00.000Z",
          node_summary: { total: 0, completed: 0, failed: 0, running: 0 },
        },
        spawnedInstanceIds: [],
      });
      const response = await request(
        `/workflow-runs/run-approve-${index}/approve`,
        jsonRequest({ nodeId: `node-${index}`, token: `token-${index}`, data: { sequence: index } }),
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ success: true, data: null });
      expect(approveNode).toHaveBeenCalledWith(`run-approve-${index}`, `node-${index}`, `token-${index}`, {
        sequence: index,
      });
    });
  }

  for (const index of Array.from({ length: 5 }, (_, value) => value + 1)) {
    test(`并发取消第${index}组运行均独立进入当前组织引擎`, async () => {
      const cancel = spyOn(getTeamEngine("org-route-tests"), "cancel").mockResolvedValue();
      const [first, second] = await Promise.all([
        request(`/workflow-runs/run-parallel-${index}-a/cancel`, jsonRequest({})),
        request(`/workflow-runs/run-parallel-${index}-b/cancel`, jsonRequest({})),
      ]);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledWith(`run-parallel-${index}-a`);
      expect(cancel).toHaveBeenCalledWith(`run-parallel-${index}-b`);
    });
  }

  for (const index of Array.from({ length: 5 }, (_, value) => value + 1)) {
    test(`不存在运行的状态查询第${index}次统一返回404`, async () => {
      spyOn(getTeamEngine("org-route-tests"), "getRunStatus").mockRejectedValue(
        new WorkflowError(`运行${index}不存在`, WorkflowErrorCode.RUN_NOT_FOUND),
      );
      const response = await request(`/workflow-runs/run-missing-${index}`);

      expect(response.status).toBe(404);
      expect(await readJson(response)).toEqual({
        success: false,
        error: { code: WorkflowErrorCode.RUN_NOT_FOUND, message: `运行${index}不存在` },
      });
    });
  }

  for (const index of Array.from({ length: 5 }, (_, value) => value + 1)) {
    test(`取消运行的未知异常第${index}次不泄露内部状态`, async () => {
      spyOn(getTeamEngine("org-route-tests"), "cancel").mockRejectedValue(new Error(`内部错误${index}`));
      const response = await request(`/workflow-runs/run-error-${index}/cancel`, jsonRequest({}));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });
  }
});
