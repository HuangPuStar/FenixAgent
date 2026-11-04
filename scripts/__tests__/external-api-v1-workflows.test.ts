import { expect, test } from "bun:test";
import type { WorkflowTestConfig, WorkflowV2TestConfig } from "../lib/external-api-v1/config";
import { ManualRunner } from "../lib/external-api-v1/runner";
import {
  runWorkflowScenario,
  runWorkflowV2Scenario,
  validateWorkflowConfig,
  validateWorkflowV2Config,
} from "../lib/external-api-v1/workflows";

// 两类工作流只使用自己的配置，并保持参数、同步执行和逐接口暂停行为。
test.each(["workflow", "workflow-v2 对象", "workflow-v2 JSON"])("%s 不依赖 Agent 配置", async (kind) => {
  const requests: { path: string; method: string; body: unknown; authorization: string | null }[] = [];
  const events: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      events.push("request");
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        body: await request.json(),
        authorization: request.headers.get("authorization"),
      });
      return Response.json({
        success: true,
        data:
          kind === "workflow"
            ? { runId: "run-existing", status: "SUCCESS" }
            : { executeId: "exec-existing", data: '{"output":"test"}', token: 0, cost: "0", debugUrl: null },
      });
    },
  });
  const connection = { baseUrl: server.url.origin, apiKey: "workflow-key", timeoutMs: 1000 };
  const runner = new ManualRunner(connection, {
    write: () => {},
    pause: async () => {
      events.push("pause");
    },
  });
  try {
    if (kind === "workflow") {
      const config: WorkflowTestConfig = { ...connection, workflowId: "existing workflow", inputs: { count: 0 } };
      validateWorkflowConfig(config);
      await runWorkflowScenario(config, runner);
      expect(requests).toEqual([
        {
          path: "/api/v1/workflows/existing%20workflow/execute",
          method: "POST",
          authorization: "Bearer workflow-key",
          body: { inputs: { count: 0 }, mode: "sync", timeout: 300 },
        },
      ]);
    } else {
      const config: WorkflowV2TestConfig = {
        ...connection,
        workflowId: "existing-platform-uuid",
        parameters: kind.endsWith("JSON") ? '{"count":0}' : { count: 0 },
      };
      validateWorkflowV2Config(config);
      await runWorkflowV2Scenario(config, runner);
      expect(requests).toEqual([
        {
          path: "/api/v1/workflow-v2/workflows/existing-platform-uuid/run",
          method: "POST",
          authorization: "Bearer workflow-key",
          body: { parameters: kind.endsWith("JSON") ? '{"count":0}' : { count: 0 }, isAsync: false },
        },
      ]);
    }
    expect(events).toEqual(["request", "pause"]);
    expect(runner.operations.size).toBe(1);
  } finally {
    server.stop(true);
  }
});

// 未填写 ID 时只提示本类别的配置，不发送执行请求。
test.each(["", "EDIT_WORKFLOW_ID"])("缺少工作流 ID %j 时独立跳过", async (workflowId) => {
  const lines: string[] = [];
  const connection = { baseUrl: "http://127.0.0.1:1", apiKey: "workflow-key", timeoutMs: 100 };
  const runner = new ManualRunner(connection, { write: (line) => lines.push(line), pause: async () => {} });
  await runWorkflowScenario({ ...connection, workflowId, inputs: {} }, runner);
  await runWorkflowV2Scenario({ ...connection, workflowId, parameters: {} }, runner);
  expect(lines.some((line) => line.includes("WORKFLOW_CONFIG.workflowId"))).toBe(true);
  expect(lines.some((line) => line.includes("WORKFLOW_V2_CONFIG.workflowId"))).toBe(true);
  expect(runner.operations.size).toBe(0);
});

// 业务失败或返回字段不完整不能被独立入口误判为通过。
test.each(["workflow", "workflow-v2"])("%s 拒绝无效执行结果并暂停", async (kind) => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ success: true, data: { runId: "failed", status: "FAILED" } }),
  });
  const connection = { baseUrl: server.url.origin, apiKey: "workflow-key", timeoutMs: 1000 };
  let pauses = 0;
  const runner = new ManualRunner(connection, {
    write: () => {},
    pause: async () => {
      pauses++;
    },
  });
  try {
    const result =
      kind === "workflow"
        ? runWorkflowScenario({ ...connection, workflowId: "existing", inputs: {} }, runner)
        : runWorkflowV2Scenario({ ...connection, workflowId: "existing", parameters: {} }, runner);
    await expect(result).rejects.toThrow();
    expect(pauses).toBe(1);
    expect(runner.operations.size).toBe(0);
  } finally {
    server.stop(true);
  }
});
