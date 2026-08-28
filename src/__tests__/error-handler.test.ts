// errorPlugin 对编排域错误的 HTTP 映射测试（断裂点 6 回归）

import { describe, expect, test } from "bun:test";
import { createCoreRuntimeError } from "@fenix/core";
import {
  AgentNodeUnavailableError,
  ConcurrencyExceededError,
  MachineOfflineError,
  OrchestrationError,
} from "@fenix/orchestration";
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
    })
    .get("/core-node-offline", () => {
      throw createCoreRuntimeError("NODE_OFFLINE", "Core node is offline: mach_sec", { nodeId: "mach_sec" });
    })
    .get("/concurrency-exceeded", () => {
      // agent-controller 实际抛出时 message 拼接 envId（见 packages/orchestration/src/
      // agent-controller/index.ts），验证 errorPlugin 必须用通用模板替换
      throw new ConcurrencyExceededError("Environment 'env_sec' reached max concurrency (1)");
    })
    .get("/unknown-error", () => {
      // CoreRuntimeError 500 等未知错误的泄漏口：message 携带 machineId，
      // 兜底分支必须固定通用文案
      throw new Error("Core node is offline: machine-42");
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

  // CoreRuntimeError NODE_OFFLINE 必须映射 503 且脱敏：ensureNode 检查通过后、
  // core launch 前断连的竞态窗口内错误码不能漂移回 500，message 不得含
  // nodeId/machineId（A-P1.2 防御层）
  test("CoreRuntimeError NODE_OFFLINE 映射 503 并脱敏", async () => {
    const response = await app.handle(new Request("http://localhost/core-node-offline"));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.type).toBe("AGENT_NODE_UNAVAILABLE");
    expect(body.error.message).not.toContain("mach_sec");
  });

  // A-P1.1：编排域错误 message 可能携带 envId（ConcurrencyExceededError 在
  // agent-controller 抛出时拼接环境 ID），errorPlugin 必须用通用模板替换，
  // 不得把内部资源标识写进响应体
  test("ConcurrencyExceededError 映射 409 且 message 脱敏", async () => {
    const response = await app.handle(new Request("http://localhost/concurrency-exceeded"));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.type).toBe("CONCURRENCY_EXCEEDED");
    expect(body.error.message).toBe("Concurrency limit exceeded");
    expect(JSON.stringify(body)).not.toContain("env_sec");
  });

  // A-P1.1：未知错误兜底（CoreRuntimeError 500 等）message 固定通用文案，
  // 不得泄漏 nodeId/machineId（"Core node is offline: machine-42" 只入服务端日志）
  test("未知错误兜底返回 500 且 message 脱敏", async () => {
    const response = await app.handle(new Request("http://localhost/unknown-error"));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.type).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("machine-42");
  });
});
