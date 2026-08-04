// errorPlugin 对编排域错误的 HTTP 映射测试（断裂点 6 回归）

import { describe, expect, test } from "bun:test";
import { AgentNodeUnavailableError, MachineOfflineError, OrchestrationError } from "@fenix/orchestration";
import Elysia from "elysia";
import { errorPlugin } from "../plugins/error-handler";

describe("errorPlugin 编排域错误映射", () => {
  const app = new Elysia()
    .use(errorPlugin)
    .get("/agent-node-unavailable", () => {
      throw new AgentNodeUnavailableError();
    })
    .get("/machine-offline", () => {
      throw new MachineOfflineError();
    })
    .get("/unmapped", () => {
      throw new OrchestrationError("unmapped orchestration failure", "UNMAPPED_ORCH_ERROR");
    });

  // 断裂点 6：AGENT_NODE_UNAVAILABLE（cc8fdf6c 后机器离线错误）必须映射 503 且保留
  // error.type，调用方（前端 / workflow）据此判断机器离线，而不是落成 500 内部错误。
  test("AgentNodeUnavailableError 映射 503 并保留 error.type", async () => {
    const response = await app.handle(new Request("http://localhost/agent-node-unavailable"));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.type).toBe("AGENT_NODE_UNAVAILABLE");
  });

  // 旧错误码 MACHINE_OFFLINE 的 503 映射必须保留（回归：0dcb2e2d 前调用方依赖的语义）
  test("MachineOfflineError 保持 503 映射", async () => {
    const response = await app.handle(new Request("http://localhost/machine-offline"));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.type).toBe("MACHINE_OFFLINE");
  });

  // 未在 ORCHESTRATION_STATUS_MAP 登记的编排域错误应保守落 500，
  // 不得静默变成其他状态码掩盖故障（errorPlugin 显式映射的设计意图）。
  test("未映射编排域错误保守返回 500", async () => {
    const response = await app.handle(new Request("http://localhost/unmapped"));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.type).toBe("UNMAPPED_ORCH_ERROR");
  });
});
