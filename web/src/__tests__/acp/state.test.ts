import { describe, test, expect, beforeEach } from "bun:test";
import { ACPState } from "../../acp/state";
import { WSTransport } from "../../acp/transport";
import { ACPProtocol } from "../../acp/protocol";

// ACPState 状态管理测试
describe("ACPState", () => {
  let state: ACPState;
  let transport: WSTransport;
  let protocol: ACPProtocol;

  beforeEach(() => {
    state = new ACPState();
    transport = new WSTransport();
    protocol = new ACPProtocol();
    state.bind(transport, protocol);
  });

  // 测试初始状态
  test("initial state", () => {
    expect(state.connectionState).toBe("disconnected");
    expect(state.sessionId).toBeNull();
    expect(state.agentCapabilities).toBeNull();
    expect(state.modelState).toBeNull();
    expect(state.availableCommands).toEqual([]);
    expect(state.supportsImages).toBe(false);
    expect(state.supportsModelSelection).toBe(false);
  });

  // 测试 transport connected → connectionState 变更
  test("transport state event updates connectionState", () => {
    const events: any[] = [];
    state.on("connectionStateChange", (e) => events.push(e));

    // 手动 emit transport state（模拟连接成功）
    (transport as any).setState("connected");
    expect(state.connectionState).toBe("connected");
    expect(events.length).toBe(1);
    expect(events[0].state).toBe("connected");
  });

  // 测试 protocol status → capabilities 更新
  test("protocol status connected → updates capabilities", () => {
    const caps = { loadSession: true, sessionCapabilities: { resume: {} } };
    protocol.emit("status", { connected: true, capabilities: caps });

    expect(state.agentCapabilities).toEqual(caps);
    expect(state.supportsLoadSession).toBe(true);
    expect(state.supportsResumeSession).toBe(true);
  });

  // 测试 protocol session_created → sessionId + modelState 更新
  test("protocol session_created → updates sessionId and modelState", () => {
    const models = { availableModels: [{ modelId: "gpt-4", name: "GPT-4" }], currentModelId: "gpt-4" };
    protocol.emit("session_created", { sessionId: "ses_1", models });

    expect(state.sessionId).toBe("ses_1");
    expect(state.modelState).toEqual(models);
    expect(state.supportsModelSelection).toBe(true);
  });

  // 测试 protocol session_loaded
  test("protocol session_loaded → updates sessionId", () => {
    protocol.emit("session_loaded", { sessionId: "ses_2", promptCapabilities: { image: true } });

    expect(state.sessionId).toBe("ses_2");
    expect(state.supportsImages).toBe(true);
  });

  // 测试 protocol session_update available_commands
  test("protocol session_update available_commands → updates availableCommands", () => {
    const cmds = [{ name: "help", description: "Show help" }];
    const update = { sessionUpdate: "available_commands_update", availableCommands: cmds };
    protocol.emit("session_update", { sessionId: "ses_1", update });

    expect(state.availableCommands).toEqual(cmds);
  });

  // 测试 protocol model_changed
  test("protocol model_changed → updates currentModelId in modelState", () => {
    // 先设置 modelState
    const models = { availableModels: [{ modelId: "gpt-4", name: "GPT-4" }], currentModelId: "gpt-4" };
    protocol.emit("session_created", { sessionId: "ses_1", models });

    // 再触发 model_changed
    protocol.emit("model_changed", { modelId: "claude-3" });

    expect(state.modelState?.currentModelId).toBe("claude-3");
  });

  // 测试 reset 清空所有状态
  test("reset — clears all state and emits events", () => {
    // 先设置一些状态
    const models = { availableModels: [{ modelId: "gpt-4", name: "GPT-4" }], currentModelId: "gpt-4" };
    protocol.emit("session_created", { sessionId: "ses_1", models });

    // Reset
    state.reset();

    expect(state.sessionId).toBeNull();
    expect(state.agentCapabilities).toBeNull();
    expect(state.modelState).toBeNull();
    expect(state.availableCommands).toEqual([]);
    expect(state.connectionState).toBe("disconnected");
  });

  // 测试 auth failure (code 4001) 检测
  test("transport error with code 4001 → auth failure error message", () => {
    const events: any[] = [];
    state.on("connectionStateChange", (e) => events.push(e));

    // 模拟 auth failure close event
    const fakeCloseEvent = { code: 4001, reason: "Unauthorized" } as CloseEvent;
    (transport as any).setState("error", fakeCloseEvent);

    expect(events[events.length - 1].error).toBe("登录已过期");
  });

  // 测试 bind 返回 cleanup 函数
  test("bind returns cleanup function", () => {
    const state2 = new ACPState();
    const cleanup = state2.bind(transport, protocol);

    // 触发事件，state2 应该收到
    protocol.emit("session_created", { sessionId: "ses_test" });
    expect(state2.sessionId).toBe("ses_test");

    // Cleanup 后不应再收到
    cleanup();
    protocol.emit("session_created", { sessionId: "ses_other" });
    expect(state2.sessionId).toBe("ses_test"); // 未变
  });

  // 测试 derived getter: supportsSessionHistory
  test("supportsSessionHistory — true when load or resume supported", () => {
    expect(state.supportsSessionHistory).toBe(false);

    protocol.emit("status", { connected: true, capabilities: { loadSession: true } });
    expect(state.supportsSessionHistory).toBe(true);
  });
});
