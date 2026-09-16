import { beforeEach, describe, expect, mock, test } from "bun:test";

const fetchCalls: Array<[string, RequestInit]> = [];

beforeEach(() => {
  fetchCalls.length = 0;
  globalThis.fetch = mock((url: string, init: RequestInit) => {
    fetchCalls.push([url, init]);
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, data: null }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
});

function expectRequest(index: number, url: string, method: string, body?: unknown) {
  const [actualUrl, init] = fetchCalls[index] ?? [];
  expect(actualUrl).toBe(url);
  expect(init?.method).toBe(method);
  expect(body === undefined ? init?.body : JSON.parse(init?.body as string)).toEqual(body);
}

describe("workflow engine API client", () => {
  // 工作流启动、审批与恢复请求必须将运行 ID 编码并保留后端所需 JSON 字段。
  test("maps workflow mutations to encoded REST endpoints", async () => {
    const { workflowEngineApi } = await import("../api/workflow-engine");

    await workflowEngineApi.run("name: demo", { region: "cn" }, "workflow-1");
    await workflowEngineApi.dryRun("name: demo");
    await workflowEngineApi.cancel("run/a");
    await workflowEngineApi.approve("run/a", "node/b", "approval-token", { comment: "ok" });
    await workflowEngineApi.recover("run/a", "name: recovered");
    await workflowEngineApi.rerunFrom("run/a", "name: rerun", "node/b", "workflow-1");

    expectRequest(0, "/web/workflow-runs", "POST", {
      yaml: "name: demo",
      params: { region: "cn" },
      workflowId: "workflow-1",
    });
    expectRequest(1, "/web/workflow-runs/dry", "POST", { yaml: "name: demo" });
    expectRequest(2, "/web/workflow-runs/run%2Fa/cancel", "POST", {});
    expectRequest(3, "/web/workflow-runs/run%2Fa/approve", "POST", {
      nodeId: "node/b",
      token: "approval-token",
      data: { comment: "ok" },
    });
    expectRequest(4, "/web/workflow-runs/run%2Fa/recover", "POST", { yaml: "name: recovered" });
    expectRequest(5, "/web/workflow-runs/run%2Fa/rerun", "POST", {
      yaml: "name: rerun",
      fromNodeId: "node/b",
      workflowId: "workflow-1",
    });
  });

  // 状态读取、事件筛选与分页列表应只在提供可选参数时附加相应 query。
  test("maps workflow reads and optional query parameters", async () => {
    const { workflowEngineApi } = await import("../api/workflow-engine");

    await workflowEngineApi.getRunStatus("run/a");
    await workflowEngineApi.getEvents("run/a");
    await workflowEngineApi.getEvents("run/a", "node/b");
    await workflowEngineApi.getOutput("run/a", "node/b");
    await workflowEngineApi.getPendingApprovals("run/a");
    await workflowEngineApi.listRuns({ page: 2, pageSize: 20, status: "RUNNING", q: "nightly" });

    expectRequest(0, "/web/workflow-runs/run%2Fa", "GET");
    expectRequest(1, "/web/workflow-runs/run%2Fa/events", "GET");
    expectRequest(2, "/web/workflow-runs/run%2Fa/events?nodeId=node%2Fb", "GET");
    expectRequest(3, "/web/workflow-runs/run%2Fa/nodes/node%2Fb/output", "GET");
    expectRequest(4, "/web/workflow-runs/run%2Fa/approvals", "GET");
    expectRequest(5, "/web/workflow-runs?page=2&pageSize=20&status=RUNNING&q=nightly", "GET");
  });
});
