import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type DAGRunResult, WorkflowError, WorkflowErrorCode } from "@fenix/workflow-engine";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { getTeamEngine } from "../services/workflow";
import { readJson, resetAllStubs, stubAuthApi, stubPgStorageAdapter } from "../test-utils/helpers";

const route = (await import("../routes/web/workflow-runs")).workflowRunsRoutes;

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function post(body: Record<string, unknown>): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function authenticate(organizationId = "org-round40", userId = "user-round40") {
  setTestAuth({
    user: { id: userId, email: `${userId}@test.invalid`, name: "Round 40" },
    authContext: { organizationId, userId, role: "owner" },
  });
  setTestOrgContext({ organizationId, userId, role: "owner" });
}

function result(runId = "run-result", status: DAGRunResult["status"] = "SUCCESS"): DAGRunResult {
  return {
    runId,
    status,
    summary: {
      run_id: runId,
      workflow_name: "Round 40 workflow",
      status,
      started_at: "2026-08-19T00:00:00.000Z",
      node_summary: { total: 1, completed: 1, failed: 0, running: 0 },
    },
    spawnedInstanceIds: [],
  };
}

describe("Round 40 workflow-runs 路由业务覆盖", () => {
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

  // 未认证列表请求必须在访问组织存储前被认证层拒绝。
  test("未认证列表返回 401 且不读取运行记录", async () => {
    const listRuns = mock();
    stubPgStorageAdapter({ listRuns });
    resetTestAuth();
    setTestOrgContext(null);
    stubAuthApi({ getSession: async () => null });

    const response = await request("/workflow-runs");

    expect(response.status).toBe(401);
    expect(listRuns).not.toHaveBeenCalled();
  });

  // 列表省略查询参数时应使用路由定义的默认分页值。
  test("列表使用默认分页并返回存储结果", async () => {
    const listRuns = mock(async () => ({ items: [], total: 0 }));
    stubPgStorageAdapter({ listRuns });

    const response = await request("/workflow-runs");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: { items: [], total: 0, page: 1, pageSize: 20 } });
    expect(listRuns).toHaveBeenCalledWith({ page: 1, pageSize: 20, status: undefined, q: undefined });
  });

  // 列表过滤条件必须原样交给当前组织的存储适配器。
  test("列表传递状态和名称过滤条件", async () => {
    const listRuns = mock(async () => ({ items: [{ run_id: "run-filter" }], total: 1 }));
    stubPgStorageAdapter({ listRuns });

    const response = await request("/workflow-runs?page=2&pageSize=10&status=RUNNING&q=deploy");

    expect(response.status).toBe(200);
    expect(listRuns).toHaveBeenCalledWith({ page: 2, pageSize: 10, status: "RUNNING", q: "deploy" });
  });

  // 非法页码不得进入存储层，避免无效查询消耗数据库资源。
  test("列表页码小于一返回 400", async () => {
    const listRuns = mock();
    stubPgStorageAdapter({ listRuns });

    const response = await request("/workflow-runs?page=0");

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("INVALID_PARAMS");
    expect(listRuns).not.toHaveBeenCalled();
  });

  // 存储异常对客户端应映射为通用错误而非暴露内部细节。
  test("列表存储异常返回通用 500", async () => {
    stubPgStorageAdapter({ listRuns: async () => Promise.reject(new Error("database unavailable")) });

    const response = await request("/workflow-runs");

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Failed to list workflow runs" },
    });
  });

  // 状态快照读取只应使用认证组织对应的 engine。
  test("详情读取当前组织的运行快照", async () => {
    const current = spyOn(getTeamEngine("org-round40"), "getRunStatus").mockResolvedValue({
      snapshot_id: "snapshot-1",
      run_id: "run-detail",
      last_event_id: "event-1",
      timestamp: "2026-08-19T00:00:00.000Z",
      node_states: { build: { status: "COMPLETED", exit_code: 0 } },
      dag_status: "SUCCESS",
    });
    const foreign = spyOn(getTeamEngine("org-foreign"), "getRunStatus").mockResolvedValue(null);

    const response = await request("/workflow-runs/run-detail");

    expect(response.status).toBe(200);
    expect((await readJson(response)).data.run_id).toBe("run-detail");
    expect(current).toHaveBeenCalledWith("run-detail");
    expect(foreign).not.toHaveBeenCalled();
  });

  // 不存在的详情统一映射为 404，避免将引擎错误直接抛给客户端。
  test("详情不存在运行映射为 404", async () => {
    spyOn(getTeamEngine("org-round40"), "getRunStatus").mockRejectedValue(
      new WorkflowError("missing run", WorkflowErrorCode.RUN_NOT_FOUND),
    );

    const response = await request("/workflow-runs/run-missing");

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe(WorkflowErrorCode.RUN_NOT_FOUND);
  });

  // 非 WorkflowError 的详情失败需作为内部错误处理。
  test("详情未知错误映射为 500", async () => {
    spyOn(getTeamEngine("org-round40"), "getRunStatus").mockRejectedValue(new Error("engine offline"));

    const response = await request("/workflow-runs/run-failed");

    expect(response.status).toBe(500);
    expect((await readJson(response)).error).toEqual({ code: "INTERNAL_ERROR", message: "engine offline" });
  });

  // 事件读取没有 nodeId 时仍应显式传递未定义筛选条件。
  test("事件列表不带筛选条件读取当前组织", async () => {
    const getEvents = spyOn(getTeamEngine("org-round40"), "getEvents").mockResolvedValue([]);

    const response = await request("/workflow-runs/run-events/events");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: [] });
    expect(getEvents).toHaveBeenCalledWith("run-events", { nodeId: undefined });
  });

  // 事件读取对不存在运行同样遵循 404 的资源边界。
  test("事件列表不存在运行映射为 404", async () => {
    spyOn(getTeamEngine("org-round40"), "getEvents").mockRejectedValue(
      new WorkflowError("events missing", WorkflowErrorCode.RUN_NOT_FOUND),
    );

    const response = await request("/workflow-runs/run-events-missing/events?nodeId=private-node");

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.message).toBe("events missing");
  });

  // 节点输出应将 runId 和 nodeId 分别传递给同一组织 engine。
  test("节点输出按运行和节点读取", async () => {
    const getOutput = spyOn(getTeamEngine("org-round40"), "getOutput").mockResolvedValue({
      stdout: "completed",
      json: null,
      exit_code: 0,
    });

    const response = await request("/workflow-runs/run-output/nodes/node-output/output");

    expect(response.status).toBe(200);
    expect((await readJson(response)).data.stdout).toBe("completed");
    expect(getOutput).toHaveBeenCalledWith("run-output", "node-output");
  });

  // 节点输出的底层异常不能泄露引擎实现信息以外的响应结构。
  test("节点输出未知错误映射为 500", async () => {
    spyOn(getTeamEngine("org-round40"), "getOutput").mockRejectedValue(new Error("output store failed"));

    const response = await request("/workflow-runs/run-output-error/nodes/node/output");

    expect(response.status).toBe(500);
    expect((await readJson(response)).error.code).toBe("INTERNAL_ERROR");
  });

  // 待审批查询返回当前运行的审批项而不访问其他组织 engine。
  test("待审批列表读取当前组织运行", async () => {
    const current = spyOn(getTeamEngine("org-round40"), "getPendingApprovals").mockResolvedValue([
      { runId: "run-approval", nodeId: "approve", approvalToken: "token", expiresAt: "2026-08-20T00:00:00.000Z" },
    ]);
    const foreign = spyOn(getTeamEngine("org-foreign"), "getPendingApprovals").mockResolvedValue([]);

    const response = await request("/workflow-runs/run-approval/approvals");

    expect(response.status).toBe(200);
    expect((await readJson(response)).data).toHaveLength(1);
    expect(current).toHaveBeenCalledWith("run-approval");
    expect(foreign).not.toHaveBeenCalled();
  });

  // 审批缺少 token 时必须在进入业务引擎前由 schema 拒绝。
  test("审批缺少 token 返回 422", async () => {
    const approveNode = spyOn(getTeamEngine("org-round40"), "approveNode");

    const response = await request("/workflow-runs/run-approval/approve", post({ nodeId: "approve" }));

    expect(response.status).toBe(422);
    expect(approveNode).not.toHaveBeenCalled();
  });

  // 审批成功需要透传可选附加数据。
  test("审批传递 token 和附加数据", async () => {
    const approveNode = spyOn(getTeamEngine("org-round40"), "approveNode").mockResolvedValue(result());

    const response = await request(
      "/workflow-runs/run-approval/approve",
      post({ nodeId: "approve", token: "token-approval", data: { decision: "yes" } }),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: null });
    expect(approveNode).toHaveBeenCalledWith("run-approval", "approve", "token-approval", { decision: "yes" });
  });

  // 审批业务校验失败应映射为客户端可修复的 400。
  test("审批校验错误映射为 400", async () => {
    spyOn(getTeamEngine("org-round40"), "approveNode").mockRejectedValue(
      new WorkflowError("expired token", WorkflowErrorCode.VALIDATION_ERROR),
    );

    const response = await request(
      "/workflow-runs/run-approval/approve",
      post({ nodeId: "approve", token: "expired" }),
    );

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe(WorkflowErrorCode.VALIDATION_ERROR);
  });

  // 取消成功时应仅转交给认证组织的 engine。
  test("取消运行调用当前组织 engine", async () => {
    const current = spyOn(getTeamEngine("org-round40"), "cancel").mockResolvedValue();
    const foreign = spyOn(getTeamEngine("org-foreign"), "cancel").mockResolvedValue();

    const response = await request("/workflow-runs/run-cancel/cancel", post({}));

    expect(response.status).toBe(200);
    expect(current).toHaveBeenCalledWith("run-cancel");
    expect(foreign).not.toHaveBeenCalled();
  });

  // 取消找不到的运行必须映射为资源不存在。
  test("取消不存在运行映射为 404", async () => {
    spyOn(getTeamEngine("org-round40"), "cancel").mockRejectedValue(
      new WorkflowError("cannot cancel missing", WorkflowErrorCode.RUN_NOT_FOUND),
    );

    const response = await request("/workflow-runs/run-cancel-missing/cancel", post({}));

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.message).toBe("cannot cancel missing");
  });

  // 恢复必须带上认证用户，确保配额归属到实际触发者。
  test("恢复运行传递认证用户配额上下文", async () => {
    authenticate("org-recover", "user-recover");
    const recover = spyOn(getTeamEngine("org-recover"), "recover").mockResolvedValue(result("run-recovered"));

    const response = await request("/workflow-runs/run-recover/recover", post({ yaml: "name: recovered" }));

    expect(response.status).toBe(200);
    expect((await readJson(response)).data.runId).toBe("run-recovered");
    expect(recover).toHaveBeenCalledWith("run-recover", "name: recovered", { userId: "user-recover" });
  });

  // 恢复缺少 YAML 必须被请求 schema 拦截。
  test("恢复缺少 YAML 返回 422", async () => {
    const recover = spyOn(getTeamEngine("org-round40"), "recover");

    const response = await request("/workflow-runs/run-recover/recover", post({}));

    expect(response.status).toBe(422);
    expect(recover).not.toHaveBeenCalled();
  });

  // 恢复不存在快照应明确映射为 404。
  test("恢复不存在运行映射为 404", async () => {
    spyOn(getTeamEngine("org-round40"), "recover").mockRejectedValue(
      new WorkflowError("snapshot missing", WorkflowErrorCode.RUN_NOT_FOUND),
    );

    const response = await request("/workflow-runs/run-recover-missing/recover", post({ yaml: "name: missing" }));

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe(WorkflowErrorCode.RUN_NOT_FOUND);
  });

  // 重跑需要传递起始节点及当前用户配额上下文。
  test("重跑传递起始节点和认证用户", async () => {
    authenticate("org-rerun", "user-rerun");
    const rerunFrom = spyOn(getTeamEngine("org-rerun"), "rerunFrom").mockResolvedValue(result("run-rerun", "FAILED"));

    const response = await request(
      "/workflow-runs/run-source/rerun",
      post({ yaml: "name: rerun", fromNodeId: "deploy" }),
    );

    expect(response.status).toBe(200);
    expect((await readJson(response)).data.status).toBe("FAILED");
    expect(rerunFrom).toHaveBeenCalledWith("run-source", "name: rerun", "deploy", { userId: "user-rerun" });
  });

  // 重跑缺少起始节点时不得调用引擎。
  test("重跑缺少起始节点返回 422", async () => {
    const rerunFrom = spyOn(getTeamEngine("org-round40"), "rerunFrom");

    const response = await request("/workflow-runs/run-source/rerun", post({ yaml: "name: rerun" }));

    expect(response.status).toBe(422);
    expect(rerunFrom).not.toHaveBeenCalled();
  });

  // 重跑的业务校验错误应转换为 400 而非服务器异常。
  test("重跑校验错误映射为 400", async () => {
    spyOn(getTeamEngine("org-round40"), "rerunFrom").mockRejectedValue(
      new WorkflowError("invalid rerun node", WorkflowErrorCode.VALIDATION_ERROR),
    );

    const response = await request(
      "/workflow-runs/run-source/rerun",
      post({ yaml: "name: rerun", fromNodeId: "missing-node" }),
    );

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.message).toBe("invalid rerun node");
  });
});
