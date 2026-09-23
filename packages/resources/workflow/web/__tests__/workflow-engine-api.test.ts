// web/__tests__/workflow-engine-api.test.ts
// 本包 `web/api/` 客户端的契约用例：请求映射（引擎动作分发）与响应形状（定义 / 自定义工具查询）。
//
// 同处一个文件：两者都是 `request()` 的薄封装，夹具（全局 fetch 替身 + 动态 import）与断言口径一致。
// 用例走真实 `request()`，不替身域模块——这样钉住的才是「响应形状 → 域模块返回值」这条链路本身。

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

describe("custom tools API client 的响应形状", () => {
  /** 用给定响应体替换全局 fetch（同样记进 `fetchCalls`，URL 与请求头口径与上方用例一致）。 */
  function respondWith(body: unknown, status = 200) {
    globalThis.fetch = mock((url: string, init: RequestInit) => {
      fetchCalls.push([url, init]);
      return Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
      );
    }) as unknown as typeof fetch;
  }

  // 列表端点返回成功但缺 data 时，`request()` 会把整个信封当 data 透出；域模块必须收敛成数组，
  // 否则消费方 `for (const t of tools)` 会在渲染期抛 TypeError（编辑器整页崩，而不只是少一个分区）。
  test("成功但缺 data：收敛成空列表，不透出信封", async () => {
    const { customToolsApi } = await import("../api/workflow-defs");
    respondWith({ success: true });

    expect(await customToolsApi.list()).toEqual({ success: true, data: [] });
    expect(fetchCalls[0]?.[0]).toBe("/web/workflow-custom-tools");
  });

  // 形状正常的成功响应必须原样透出工具列表，不能被形状兜底吃掉。
  test("成功且 data 为数组：原样透出工具列表", async () => {
    const { customToolsApi } = await import("../api/workflow-defs");
    const tools = [{ name: "slurm", description: "提交作业", inputs: {}, produces: [] }];
    respondWith({ success: true, data: tools });

    expect(await customToolsApi.list()).toEqual({ success: true, data: tools });
  });

  // 失败仍必须表达成 `{ success: false }` 交给消费方 `unwrap()` 抛错：「失败映射成 empty」是在途项 25
  // 点名的缺陷形态，形状兜底只允许作用于成功分支。
  test("业务失败：保持 { success: false }，不兜成空列表", async () => {
    const { customToolsApi } = await import("../api/workflow-defs");
    respondWith({ success: false, error: { code: "FORBIDDEN", message: "无权限查看 custom 工具" } }, 403);

    const result = await customToolsApi.list();

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe("FORBIDDEN");
  });
});
