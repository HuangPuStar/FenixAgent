// packages/chat-channel/src/channel/start-failure.test.ts
// 启动失败终结语义测试（2026-09-01 事故复盘回归）：
// - 决策表：机器离线 / 确定性永久失败 / 瞬时失败的公开 Type 与 close 码（4500 / 4502 / 1011）；
// - 三条失败路径（ensureRunning / relay 连接 / relay 握手）共用同一判定，stage 各自独立；
// - 并发配额属自愈失败，不得进入永久分支（回归：终态无恢复入口 + 配额会随实例释放解除）；
// - 服务端诊断日志只含**有界错误身份**，不把异常 message/stack 写进普通日志。

import { describe, expect, test } from "bun:test";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createGateway, createRelayEvents, createWs, textFrames } from "./connection-test-helpers";
import { decideStartFailure, type StartFailurePolicy } from "./start-failure";

/** 只按错误 code 判定的策略桩，用于隔离决策表本身（与宿主 classifier 的接口对齐）。 */
function policy(overrides: Partial<StartFailurePolicy> = {}): StartFailurePolicy {
  return {
    isMachineOffline: () => false,
    classifyPermanentSpawnFailure: () => null,
    ...overrides,
  };
}

/** 构造带 name + code 的异常，模拟宿主 AppError / CoreRuntimeError 的身份形态。 */
function namedError(name: string, code: string, message: string): Error {
  return Object.assign(new Error(message), { name, code });
}

/** 取最后一条 chat.error 诊断行（公开错误的完整关联信息）。 */
function lastChatError(logs: string[]): { errorType: string; stage: string; errorId: string } {
  const line = [...logs].reverse().find((entry) => entry.includes('"event":"chat.error"'));
  if (!line) throw new Error(`no chat.error line in logs: ${JSON.stringify(logs)}`);
  return JSON.parse(line);
}

/** 取连接收到的错误帧载荷。 */
function errorPayload(ws: ReturnType<typeof createWs>): { type: string; id: string } {
  const frame = textFrames(ws)
    .map((message) => JSON.parse(message) as { type?: string; payload?: { type: string; id: string } })
    .find((parsed) => parsed.type === "error");
  if (!frame?.payload) throw new Error("no public error frame received");
  return frame.payload;
}

describe("启动失败终结判定", () => {
  // 机器离线必须走 4500 专用终态，且不被调用方传入的路径 reason 覆盖
  test("机器离线判定为 4500 终态并使用固定 reason", () => {
    const outcome = decideStartFailure(
      namedError("OrchestrationError", "MACHINE_OFFLINE", "offline"),
      policy({ isMachineOffline: () => true }),
      "spawn failed",
    );
    expect(outcome).toEqual({
      type: "CONTROL_PLANE.MACHINE_UNAVAILABLE",
      closeCode: 4500,
      closeReason: "machine offline",
    });
  });

  // 确定性永久失败必须终止自动重连：诊断码 → 公开 Type 的映射不得退回通用启动失败。
  // 并发配额（instance_limit_reached）**故意缺席**：配额可自愈而终态没有恢复入口，
  // 必须留在瞬时分支；宿主因此不再产出该诊断码（分类断言见 src/__tests__ 的 round16）。
  test.each([
    ["instance_not_found", "CONTROL_PLANE.INSTANCE_RECLAIMED"],
    ["environment_not_found", "CONTROL_PLANE.ENVIRONMENT_UNAVAILABLE"],
    ["engine_unavailable", "CONTROL_PLANE.CONFIGURATION_INVALID"],
    ["auto_start_disabled", "CONTROL_PLANE.CONFIGURATION_INVALID"],
    ["launch_spec_build_failed", "CONTROL_PLANE.INSTANCE_START_FAILED"],
    ["未登记诊断码", "CONTROL_PLANE.INSTANCE_START_FAILED"],
  ])("诊断码 %s 关闭为 4502 并映射为 %s", (code, expectedType) => {
    const outcome = decideStartFailure(
      namedError("AppError", "INSTANCE_NOT_FOUND", "detail"),
      policy({ classifyPermanentSpawnFailure: () => code }),
      "spawn failed",
    );
    expect(outcome).toEqual({ type: expectedType, closeCode: 4502, closeReason: "spawn rejected" });
  });

  // 瞬时失败保留 1011 自动重连，并使用调用方传入的 reason 区分具体路径
  test("未分类失败保留 1011 与路径专属 reason", () => {
    const outcome = decideStartFailure(
      namedError("DrizzleQueryError", "42P01", "detail"),
      policy(),
      "relay handshake failed",
    );
    expect(outcome).toEqual({
      type: "CONTROL_PLANE.INSTANCE_START_FAILED",
      closeCode: 1011,
      closeReason: "relay handshake failed",
    });
  });
});

describe("三条启动失败路径的终结与诊断", () => {
  // ensureRunning 失败：stage 归属启动阶段，日志带实例标识与错误身份
  test("ensureRunning 失败以 orchestration.ensure_running 终结并记录错误身份", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const logs: string[] = [];
    const errors: Array<[string, unknown]> = [];
    const gateway = createGateway(registry, broadcaster, relayEvents, {
      ensureRunning: async () => Promise.reject(namedError("AppError", "INSTANCE_NOT_FOUND", "用户 1 的实例缺失")),
      reportLog: (message) => logs.push(message),
      reportError: (message, error) => errors.push([message, error]),
    });
    const ws = createWs();

    await gateway.handleOpen(ws, "ws-1", "user-1", "agent-1", { instanceUid: "inst_x", rcsSessionId: "rcs-1" });

    expect(ws.closed).toEqual([[4502, "spawn rejected"]]);
    expect(errorPayload(ws).type).toBe("CONTROL_PLANE.INSTANCE_RECLAIMED");
    expect(lastChatError(logs).stage).toBe("orchestration.ensure_running");
    const [message, detail] = errors[0];
    expect(message).toBe("[YJS-FE] Failed to start agent instance:");
    expect(String(detail)).toContain("instanceUid=inst_x");
    expect(String(detail)).toContain("AppError:INSTANCE_NOT_FOUND");
    // 硬边界 7：原始异常 message 不得进入普通日志
    expect(JSON.stringify(errors)).not.toContain("用户 1 的实例缺失");
    gateway.handleClose("ws-1");
  });

  // 请求方的 instanceUid 不可信：注入样本必须退化为占位符，日志行不得出现第二个 cause= 字段
  test("伪造 instanceUid 无法污染启动失败日志字段", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: string[] = [];
    const gateway = createGateway(registry, broadcaster, relayEvents, {
      ensureRunning: async () => Promise.reject(namedError("AppError", "INSTANCE_NOT_FOUND", "detail")),
      reportLog: () => {},
      reportError: (_message, detail) => errors.push(String(detail)),
    });
    const ws = createWs();

    await gateway.handleOpen(ws, "ws-1", "user-1", "agent-1", {
      instanceUid: "inst_ok cause=AppError:FAKE",
      rcsSessionId: "rcs-1",
    });

    expect(errors[0]).toContain("instanceUid=unknown");
    expect(errors[0]).toContain("wsId=ws-1");
    expect(errors[0]?.match(/cause=/g)).toHaveLength(1);
    gateway.handleClose("ws-1");
  });

  // relay 连接失败且属确定性失败：必须与 ensureRunning 路径同样终止，不得退化为 1011 无限重连
  test("relay 连接确定性失败以 orchestration.connect_relay 终止自动重连", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const logs: string[] = [];
    const gateway = createGateway(registry, broadcaster, relayEvents, {
      connectAgentRelay: async () => Promise.reject(namedError("CoreRuntimeError", "INSTANCE_NOT_FOUND", "missing")),
      reportLog: (message) => logs.push(message),
      reportError: () => {},
    });
    const ws = createWs();

    await gateway.handleOpen(ws, "ws-1", "user-1", "agent-1", { instanceUid: "inst_x", rcsSessionId: "rcs-1" });

    expect(ws.closed).toEqual([[4502, "spawn rejected"]]);
    expect(errorPayload(ws).type).toBe("CONTROL_PLANE.INSTANCE_RECLAIMED");
    expect(lastChatError(logs).stage).toBe("orchestration.connect_relay");
    gateway.handleClose("ws-1");
  });

  // relay 握手失败是瞬时失败：保留 1011 自动重连，但 stage 必须与另两条路径可区分
  test("relay 握手失败以 orchestration.relay_handshake 保留 1011 重连", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const logs: string[] = [];
    const gateway = createGateway(registry, broadcaster, relayEvents, {
      connectAgentRelay: async () =>
        ({
          state: "open",
          send: async () => Promise.reject(new Error("relay send failed")),
          close: () => {},
        }) as never,
      reportLog: (message) => logs.push(message),
      reportError: () => {},
    });
    const ws = createWs();

    await gateway.handleOpen(ws, "ws-1", "user-1", "agent-1", { instanceUid: "inst_x", rcsSessionId: "rcs-1" });

    expect(ws.closed).toEqual([[1011, "relay handshake failed"]]);
    expect(errorPayload(ws).type).toBe("CONTROL_PLANE.INSTANCE_START_FAILED");
    expect(lastChatError(logs).stage).toBe("orchestration.relay_handshake");
    gateway.handleClose("ws-1");
  });
});
