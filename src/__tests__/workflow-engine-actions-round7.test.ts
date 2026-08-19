import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { WorkflowError, WorkflowErrorCode } from "@fenix/workflow-engine";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { getTeamEngine } from "../services/workflow";
import { resetAllStubs, stubAuthApi } from "../test-utils/helpers";

const route = (await import("../routes/web/workflow-engine")).default;

function request(body: Record<string, unknown>) {
  return route.handle(
    new Request("http://localhost/workflow-engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function setAuthenticatedOrg(organizationId = "org-engine-1", userId = "user-engine-1") {
  setTestAuth({
    user: { id: userId, email: `${userId}@test.com`, name: "Workflow Tester" },
    authContext: { organizationId, userId, role: "owner" },
  });
  setTestOrgContext({ organizationId, userId, role: "owner" });
}

describe("POST /web/workflow-engine action 分发", () => {
  beforeEach(() => {
    resetAllStubs();
    setAuthenticatedOrg();
  });

  afterEach(() => {
    mock.restore();
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  // run 必须把当前认证用户传给 engine，确保实例配额按触发者而非请求体归属。
  test("run 使用直接 YAML 启动并传递当前用户", async () => {
    const engine = getTeamEngine("org-engine-1");
    const runAsync = spyOn(engine, "runAsync").mockReturnValue({
      runId: "run-started",
      result: Promise.resolve({ status: "SUCCESS", spawnedInstanceIds: [] }),
    });

    const response = await request({ action: "run", yaml: "name: direct" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { runId: "run-started", status: "RUNNING" } });
    expect(runAsync).toHaveBeenCalledWith("name: direct", undefined, { userId: "user-engine-1" });
  });

  // run 未提供 YAML 或可访问工作流时必须返回明确校验错误，且不得创建运行。
  test("run 缺少 YAML 和 workflowId 返回 400", async () => {
    const runAsync = spyOn(getTeamEngine("org-engine-1"), "runAsync");

    const response = await request({ action: "run" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "yaml or workflowId is required" },
    });
    expect(runAsync).not.toHaveBeenCalled();
  });

  // dryRun 需返回 engine 给出的完整执行计划，供前端在不执行任务时预览依赖关系。
  test("dryRun 返回校验结果和执行计划", async () => {
    const engine = getTeamEngine("org-engine-1");
    const dryRun = spyOn(engine, "dryRun").mockReturnValue({
      valid: true,
      issues: [],
      executionPlan: { topologicalOrder: ["start", "end"], parallelGroups: [["start"], ["end"]] },
    });

    const response = await request({ action: "dryRun", yaml: "name: preview" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        valid: true,
        issues: [],
        executionPlan: { topologicalOrder: ["start", "end"], parallelGroups: [["start"], ["end"]] },
      },
    });
    expect(dryRun).toHaveBeenCalledWith("name: preview");
  });

  // dryRun 没有可解析的定义时必须在调用 engine 前失败，避免把空工作流当作有效计划。
  test("dryRun 缺少 YAML 和 workflowId 返回 400", async () => {
    const dryRun = spyOn(getTeamEngine("org-engine-1"), "dryRun");

    const response = await request({ action: "dryRun" });

    expect(response.status).toBe(400);
    expect(dryRun).not.toHaveBeenCalled();
  });

  // cancel 成功时应直接转交 runId，保持引擎的取消幂等语义。
  test("cancel 将运行 ID 转交给当前组织 engine", async () => {
    const cancel = spyOn(getTeamEngine("org-engine-1"), "cancel").mockResolvedValue();

    const response = await request({ action: "cancel", runId: "run-cancel" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
    expect(cancel).toHaveBeenCalledWith("run-cancel");
  });

  // 引擎报告不存在运行时必须映射为 404，不能泄露内部异常为 500。
  test("cancel 的 RUN_NOT_FOUND 映射为 404", async () => {
    spyOn(getTeamEngine("org-engine-1"), "cancel").mockRejectedValue(
      new WorkflowError("run not found", WorkflowErrorCode.RUN_NOT_FOUND),
    );

    const response = await request({ action: "cancel", runId: "run-missing" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: WorkflowErrorCode.RUN_NOT_FOUND, message: "run not found" },
    });
  });

  // 引擎的业务校验失败必须保持为客户端可修正的 400。
  test("cancel 的 VALIDATION_ERROR 映射为 400", async () => {
    spyOn(getTeamEngine("org-engine-1"), "cancel").mockRejectedValue(
      new WorkflowError("invalid transition", WorkflowErrorCode.VALIDATION_ERROR),
    );

    const response = await request({ action: "cancel", runId: "run-invalid" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: WorkflowErrorCode.VALIDATION_ERROR, message: "invalid transition" },
    });
  });

  // 未知异常必须统一映射为 500，避免将未处理 rejection 留给请求生命周期。
  test("cancel 的未知错误映射为 500", async () => {
    spyOn(getTeamEngine("org-engine-1"), "cancel").mockRejectedValue(new Error("storage unavailable"));

    const response = await request({ action: "cancel", runId: "run-broken" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "storage unavailable" },
    });
  });

  // approve 必须保留审批 token 与附加数据，确保挂起节点能恢复到原始审批上下文。
  test("approve 转交 token 和附加数据", async () => {
    const approveNode = spyOn(getTeamEngine("org-engine-1"), "approveNode").mockResolvedValue({
      spawnedInstanceIds: [],
    });

    const response = await request({
      action: "approve",
      runId: "run-approval",
      nodeId: "node-review",
      token: "approval-token",
      data: { approvedBy: "owner" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
    expect(approveNode).toHaveBeenCalledWith("run-approval", "node-review", "approval-token", { approvedBy: "owner" });
  });

  // 状态为空表示当前组织没有该运行快照，应返回稳定的 null 而非错误。
  test("getRunStatus 在快照不存在时返回 null", async () => {
    const getRunStatus = spyOn(getTeamEngine("org-engine-1"), "getRunStatus").mockResolvedValue(null);

    const response = await request({ action: "getRunStatus", runId: "run-absent" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
    expect(getRunStatus).toHaveBeenCalledWith("run-absent");
  });

  // 事件查询必须将可选 nodeId 透传，使引擎可以在组织隔离的存储中精确过滤。
  test("getEvents 将 nodeId 传给当前组织 engine", async () => {
    const getEvents = spyOn(getTeamEngine("org-engine-1"), "getEvents").mockResolvedValue([]);

    const response = await request({ action: "getEvents", runId: "run-events", nodeId: "node-private" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: [] });
    expect(getEvents).toHaveBeenCalledWith("run-events", { nodeId: "node-private" });
  });

  // 节点尚未输出时应返回 null，前端可据此展示等待状态而不是把它误判为路由失败。
  test("getOutput 在节点无输出时返回 null", async () => {
    const getOutput = spyOn(getTeamEngine("org-engine-1"), "getOutput").mockResolvedValue(null);

    const response = await request({ action: "getOutput", runId: "run-output", nodeId: "node-pending" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
    expect(getOutput).toHaveBeenCalledWith("run-output", "node-pending");
  });

  // 没有挂起节点时待审批列表必须保持为空数组，避免前端处理 undefined。
  test("getPendingApprovals 返回空审批列表", async () => {
    const getPendingApprovals = spyOn(getTeamEngine("org-engine-1"), "getPendingApprovals").mockResolvedValue([]);

    const response = await request({ action: "getPendingApprovals", runId: "run-finished" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: [] });
    expect(getPendingApprovals).toHaveBeenCalledWith("run-finished");
  });

  // recover 必须使用当前认证用户作为配额归属，禁止由历史运行的所有者决定恢复配额。
  test("recover 使用当前认证用户恢复运行", async () => {
    const recover = spyOn(getTeamEngine("org-engine-1"), "recover").mockResolvedValue({
      runId: "run-recovered",
      status: "RUNNING",
      summary: {
        run_id: "run-recovered",
        workflow_name: "restored",
        status: "RUNNING",
        started_at: "2026-08-19T00:00:00.000Z",
        node_summary: { total: 1, completed: 0, failed: 0, running: 1 },
      },
    });

    const response = await request({ action: "recover", runId: "run-old", yaml: "name: restore" });

    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    expect(recover).toHaveBeenCalledWith("run-old", "name: restore", { userId: "user-engine-1" });
  });

  // 同一个 runId 在不同组织必须路由到不同 engine，避免跨租户读取或操作运行状态。
  test("getRunStatus 按认证组织隔离 engine", async () => {
    const first = getTeamEngine("org-engine-1");
    const second = getTeamEngine("org-engine-2");
    const firstStatus = spyOn(first, "getRunStatus").mockResolvedValue(null);
    const secondStatus = spyOn(second, "getRunStatus").mockResolvedValue(null);

    const firstResponse = await request({ action: "getRunStatus", runId: "run-shared" });
    setAuthenticatedOrg("org-engine-2", "user-engine-2");
    const secondResponse = await request({ action: "getRunStatus", runId: "run-shared" });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstStatus).toHaveBeenCalledWith("run-shared");
    expect(secondStatus).toHaveBeenCalledWith("run-shared");
  });

  // 请求体遗漏 action 所需字段必须由 schema 在 engine 调用前拒绝。
  test("approve 缺少 token 返回 422 且不调用 engine", async () => {
    const approveNode = spyOn(getTeamEngine("org-engine-1"), "approveNode");

    const response = await request({ action: "approve", runId: "run-approval", nodeId: "node-review" });

    expect(response.status).toBe(422);
    expect(approveNode).not.toHaveBeenCalled();
  });

  // 未认证请求必须由认证插件阻断，避免匿名访问任一组织的 engine。
  test("未认证 getPendingApprovals 返回 401 且不调用 engine", async () => {
    const getPendingApprovals = spyOn(getTeamEngine("org-engine-1"), "getPendingApprovals");
    resetTestAuth();
    setTestOrgContext(null);
    stubAuthApi({ getSession: async () => null });

    const response = await request({ action: "getPendingApprovals", runId: "run-private" });

    expect(response.status).toBe(401);
    expect(getPendingApprovals).not.toHaveBeenCalled();
  });
});
