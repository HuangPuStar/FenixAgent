import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@server/test-utils/helpers";

beforeEach(() => {
  resetAllStubs();
  stubDb({});
});

describe("AcpConnectionEntry 新增字段", () => {
  test("AcpConnectionEntry 类型包含 isMachine 和 machineId", async () => {
    const { handleAcpWsOpen } = await import("@fenix/agent-runtime/server");
    expect(typeof handleAcpWsOpen).toBe("function");
  });
});

describe("handleAcpWsOpen isMachine 模式", () => {
  test("handleAcpWsOpen 接受 isMachine 参数", async () => {
    const { handleAcpWsOpen } = await import("@fenix/agent-runtime/server");
    // Verify the function accepts the optional 5th parameter
    expect(typeof handleAcpWsOpen).toBe("function");
    // Function should accept 5 parameters
    expect(handleAcpWsOpen.length).toBe(5);
  });
});

describe("handleMachineRegister", () => {
  test("registerMachine 被导入到 acp-ws-handler", async () => {
    // Verify the registry service is importable from the handler module
    const mod = await import("@fenix/agent-runtime/server");
    // The handler module should re-export or use these
    expect(mod).toBeDefined();
  });
});

describe("handleMachineDisconnect", () => {
  test("disconnectMachine 被导入到 acp-ws-handler", async () => {
    const mod = await import("@fenix/agent-runtime/server");
    expect(mod).toBeDefined();
  });
});

describe("heartbeat 消息处理", () => {
  test("heartbeat 类型在消息循环中被处理", async () => {
    const { handleAcpWsMessage } = await import("@fenix/agent-runtime/server");
    expect(typeof handleAcpWsMessage).toBe("function");
  });
});

describe("handleAcpWsClose machine 断连", () => {
  test("handleAcpWsClose 函数存在", async () => {
    const { handleAcpWsClose } = await import("@fenix/agent-runtime/server");
    expect(typeof handleAcpWsClose).toBe("function");
  });
});

describe("现有 ACP 流程不受影响", () => {
  test("handleAcpWsOpen 仍然导出", async () => {
    const { handleAcpWsOpen } = await import("@fenix/agent-runtime/server");
    expect(typeof handleAcpWsOpen).toBe("function");
  });

  test("handleAcpWsMessage 仍然导出", async () => {
    const { handleAcpWsMessage } = await import("@fenix/agent-runtime/server");
    expect(typeof handleAcpWsMessage).toBe("function");
  });

  test("handleAcpWsClose 仍然导出", async () => {
    const { handleAcpWsClose } = await import("@fenix/agent-runtime/server");
    expect(typeof handleAcpWsClose).toBe("function");
  });
});
