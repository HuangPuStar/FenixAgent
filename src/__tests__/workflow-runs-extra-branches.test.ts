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

function post(body: Record<string, unknown>): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function authenticate(organizationId = "org-workflow-runs-extra", userId = "user-workflow-runs-extra") {
  setTestAuth({
    user: { id: userId, email: `${userId}@test.invalid`, name: "工作流补充测试用户" },
    authContext: { organizationId, userId, role: "owner" },
  });
  setTestOrgContext({ organizationId, userId, role: "owner" });
}

describe("workflow-runs 路由额外业务分支", () => {
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

  // 干运行缺少 YAML 或 workflowId 时必须返回可修复的业务校验错误，避免误执行空工作流。
  test("干运行缺少工作流定义返回 400", async () => {
    const dryRun = spyOn(getTeamEngine("org-workflow-runs-extra"), "dryRun");

    const response = await request("/workflow-runs/dry", post({}));

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "yaml or workflowId is required" },
    });
    expect(dryRun).not.toHaveBeenCalled();
  });

  // 干运行引擎的 YAML 校验失败应映射为 400，而不是把用户输入错误当成服务故障。
  test("干运行 WorkflowError 校验失败映射为 400", async () => {
    spyOn(getTeamEngine("org-workflow-runs-extra"), "dryRun").mockImplementation(() => {
      throw new WorkflowError("invalid workflow yaml", WorkflowErrorCode.VALIDATION_ERROR);
    });

    const response = await request("/workflow-runs/dry", post({ yaml: "name: [" }));

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: WorkflowErrorCode.VALIDATION_ERROR, message: "invalid workflow yaml" },
    });
  });

  // 启动引擎报告不存在的运行来源时必须返回 404，保持资源边界且不暴露内部异常。
  test("启动 WorkflowError RUN_NOT_FOUND 映射为 404", async () => {
    spyOn(getTeamEngine("org-workflow-runs-extra"), "runAsync").mockImplementation(() => {
      throw new WorkflowError("source workflow missing", WorkflowErrorCode.RUN_NOT_FOUND);
    });

    const response = await request("/workflow-runs", post({ yaml: "name: demo" }));

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: WorkflowErrorCode.RUN_NOT_FOUND, message: "source workflow missing" },
    });
  });

  // 未认证的干运行请求必须在进入引擎前被拦截，防止匿名用户探测工作流校验能力。
  test("未认证干运行返回 401 且不调用引擎", async () => {
    const dryRun = spyOn(getTeamEngine("org-workflow-runs-extra"), "dryRun");
    resetTestAuth();
    setTestOrgContext(null);
    stubAuthApi({ getSession: async () => null });

    const response = await request("/workflow-runs/dry", post({ yaml: "name: demo" }));

    expect(response.status).toBe(401);
    expect(dryRun).not.toHaveBeenCalled();
  });
});
