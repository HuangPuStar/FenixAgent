import { beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAllStubs, stubDb, stubEnvironmentRepo } from "../test-utils/helpers";

// Mock DB — relay uses getAgentConfigById which queries db (chain builder)
const _dbRows: Array<Record<string, unknown>> = [];
// Helper for tests to set db return values
function _setDbRows(rows: Array<Record<string, unknown>>) {
  _dbRows.length = 0;
  _dbRows.push(...rows);
}

beforeEach(() => {
  resetAllStubs();
  // 配置链式查询构建器 stub
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => _dbRows,
        }),
        leftJoin: () => ({
          where: () => _dbRows,
        }),
      }),
    }),
  });
});

function createMockWs(readyState = 1) {
  const messages: string[] = [];
  return {
    readyState,
    send: (data: string) => {
      messages.push(data);
    },
    close: mock(() => {}),
    _messages: messages,
  };
}

describe("handleRelayOpen — single machine relay path", () => {
  test("agent 未绑定 machine 返回错误并关闭 WS", async () => {
    stubEnvironmentRepo({
      getById: mock(async () => ({
        id: "env_001",
        agentConfigId: null,
      })),
    });

    const { handleRelayOpen } = await import("../transport/relay/relay-handler");
    const ws = createMockWs();

    await handleRelayOpen(ws as any, "relay_1", "env_001", "user_1");

    const msgs = ws._messages as string[];
    expect(msgs.length).toBeGreaterThan(0);
    const errorMsg = JSON.parse(msgs[0]);
    expect(errorMsg.type).toBe("error");
    expect(ws.close as ReturnType<typeof mock>).toHaveBeenCalled();
  });

  test("agentConfig 无 machineId 返回错误并关闭 WS", async () => {
    stubEnvironmentRepo({
      getById: mock(async () => ({
        id: "env_001",
        agentConfigId: "agc_001",
      })),
    });

    const { handleRelayOpen } = await import("../transport/relay/relay-handler");
    const ws = createMockWs();

    _setDbRows([{ id: "agc_001", machineId: null }]);

    await handleRelayOpen(ws as any, "relay_1", "env_001", "user_1");

    const msgs = ws._messages as string[];
    const errorMsg = JSON.parse(msgs[0]);
    expect(errorMsg.type).toBe("error");
    expect(ws.close as ReturnType<typeof mock>).toHaveBeenCalled();
  });

  test("machine 离线返回错误并关闭 WS", async () => {
    stubEnvironmentRepo({
      getById: mock(async () => ({
        id: "env_001",
        agentConfigId: "agc_001",
      })),
    });

    const { handleRelayOpen } = await import("../transport/relay/relay-handler");
    const ws = createMockWs();

    _setDbRows([{ id: "agc_001", machineId: "mach_nonexistent" }]);

    await handleRelayOpen(ws as any, "relay_1", "env_001", "user_1");

    const msgs = ws._messages as string[];
    const errorMsg = JSON.parse(msgs[0]);
    expect(errorMsg.type).toBe("error");
    expect(ws.close as ReturnType<typeof mock>).toHaveBeenCalled();
  });
});

describe("handleRelayClose", () => {
  test("handleRelayClose 不抛异常", async () => {
    const { handleRelayClose } = await import("../transport/relay/relay-handler");

    // 关闭不存在的 relay 不抛异常
    const ws = createMockWs();
    expect(() => handleRelayClose(ws as any, "nonexistent")).not.toThrow();
  });
});

describe("handleRelayMessage", () => {
  test("handleRelayMessage 不抛异常", async () => {
    const { handleRelayMessage } = await import("../transport/relay/relay-handler");

    // 向不存在的 relay 发消息不抛异常
    const ws = createMockWs();
    await handleRelayMessage(ws as any, "nonexistent", { type: "test" });
    expect(true).toBe(true);
  });
});

describe("兼容层函数导出验证", () => {
  test("sendToAgentWs 已导出且可调用", async () => {
    const { sendToAgentWs } = await import("../transport/relay");
    expect(typeof sendToAgentWs).toBe("function");
    const result = sendToAgentWs("env_nonexistent", { type: "test" });
    expect(result).toBe(false);
  });

  test("findRunningInstanceByEnvironment 已导出", async () => {
    const { findRunningInstanceByEnvironment } = await import("../transport/relay/relay-handler");
    expect(typeof findRunningInstanceByEnvironment).toBe("function");
  });

  test("spawnInstanceFromEnvironment 已导出", async () => {
    const { spawnInstanceFromEnvironment } = await import("../transport/relay/relay-handler");
    expect(typeof spawnInstanceFromEnvironment).toBe("function");
  });

  test("closeInstanceRelay 已导出", async () => {
    const { closeInstanceRelay } = await import("../transport/relay/relay-handler");
    expect(typeof closeInstanceRelay).toBe("function");
  });

  test("sendToInstanceRelay 已导出", async () => {
    const { sendToInstanceRelay } = await import("../transport/relay/relay-handler");
    expect(typeof sendToInstanceRelay).toBe("function");
  });
});
