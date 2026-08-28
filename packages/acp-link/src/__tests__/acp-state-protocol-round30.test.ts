import { describe, expect, test } from "bun:test";
import { ACPProtocol } from "../client/protocol.js";
import { ACPState } from "../client/state.js";
import { WSTransport } from "../client/transport.js";
import {
  ACP_METHOD,
  createErrorResponse,
  createNotification,
  createRequest,
  createSuccessResponse,
  isJsonRpcMessage,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isTransportMessage,
  nextRpcId,
} from "../json-rpc.js";

function createBoundState(): { state: ACPState; protocol: ACPProtocol; transport: WSTransport; cleanup: () => void } {
  const state = new ACPState();
  const protocol = new ACPProtocol();
  const transport = new WSTransport();
  return { state, protocol, transport, cleanup: state.bind(transport, protocol) };
}

describe("JSON-RPC 内存协议构造与识别", () => {
  test("中文：请求保留方法、参数和递增标识", () => {
    const firstId = nextRpcId();
    const request = createRequest("session/new", { cwd: "/memory" });

    expect(request).toEqual({ jsonrpc: "2.0", id: firstId + 1, method: "session/new", params: { cwd: "/memory" } });
  });

  test("中文：请求缺省参数时使用空对象", () => {
    expect(createRequest("session/list").params).toEqual({});
  });

  test("中文：通知可不携带参数", () => {
    expect(createNotification("session/cancel")).toEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: undefined,
    });
  });

  test("中文：通知保留显式参数", () => {
    expect(createNotification("session/prompt", { text: "内存消息" }).params).toEqual({ text: "内存消息" });
  });

  test("中文：成功响应保留字符串标识", () => {
    expect(createSuccessResponse("request-1", { accepted: true })).toEqual({
      jsonrpc: "2.0",
      id: "request-1",
      result: { accepted: true },
    });
  });

  test("中文：错误响应保留空标识和错误码", () => {
    expect(createErrorResponse(null, -32600, "无效请求")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "无效请求" },
    });
  });

  test("中文：仅 version 为 2.0 的对象属于 JSON-RPC", () => {
    expect(isJsonRpcMessage({ jsonrpc: "2.0", method: "session/list" })).toBe(true);
    expect(isJsonRpcMessage({ jsonrpc: "1.0", method: "session/list" })).toBe(false);
  });

  test("中文：null 和原始值不是 JSON-RPC", () => {
    expect(isJsonRpcMessage(null)).toBe(false);
    expect(isJsonRpcMessage("消息")).toBe(false);
  });

  test("中文：携带标识和方法的是请求", () => {
    const message = { jsonrpc: "2.0" as const, id: 7, method: "session/list" };
    expect(isJsonRpcRequest(message)).toBe(true);
    expect(isJsonRpcNotification(message)).toBe(false);
  });

  test("中文：无标识的方法消息是通知", () => {
    const message = { jsonrpc: "2.0" as const, method: "session/update" };
    expect(isJsonRpcNotification(message)).toBe(true);
    expect(isJsonRpcRequest(message)).toBe(false);
  });

  test("中文：结果消息是响应", () => {
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 8, result: {} })).toBe(true);
  });

  test("中文：错误消息是响应", () => {
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 8, error: { code: -1, message: "失败" } })).toBe(true);
  });

  test("中文：缺少结果和错误的标识消息不是响应", () => {
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 8, method: "session/list" })).toBe(false);
  });

  test("中文：已知 transport 类型被识别", () => {
    expect(isTransportMessage({ type: "status" })).toBe(true);
    expect(isTransportMessage({ type: "keep_alive" })).toBe(true);
  });

  test("中文：未知或非对象消息不是 transport", () => {
    expect(isTransportMessage({ type: "future" })).toBe(false);
    expect(isTransportMessage(undefined)).toBe(false);
  });

  test("中文：ACP 方法常量保持协议名称", () => {
    expect(ACP_METHOD.SESSION_PROMPT).toBe("session/prompt");
    expect(ACP_METHOD.REQUEST_PERMISSION).toBe("requestPermission");
  });
});

describe("ACPProtocol 内存消息路由", () => {
  test("中文：status 消息派发连接能力", () => {
    const protocol = new ACPProtocol();
    let connected = false;
    protocol.on("status", (payload) => {
      connected = payload.connected;
    });
    protocol.handleMessage(JSON.stringify({ type: "status", payload: { connected: true } }));
    expect(connected).toBe(true);
  });

  test("中文：error 消息派发原始错误文本", () => {
    const protocol = new ACPProtocol();
    let message = "";
    protocol.on("error", (payload) => {
      message = payload.message;
    });
    protocol.handleMessage(JSON.stringify({ type: "error", payload: { message: "内存错误" } }));
    expect(message).toBe("内存错误");
  });

  test("中文：pong 消息只派发一次", () => {
    const protocol = new ACPProtocol();
    let calls = 0;
    protocol.on("pong", () => {
      calls += 1;
    });
    protocol.handleMessage(JSON.stringify({ type: "pong" }));
    expect(calls).toBe(1);
  });

  test("中文：keep alive 不污染协议事件", () => {
    const protocol = new ACPProtocol();
    let calls = 0;
    protocol.on("pong", () => {
      calls += 1;
    });
    protocol.handleMessage(JSON.stringify({ type: "keep_alive" }));
    expect(calls).toBe(0);
  });

  test("中文：Yjs 更新绕过 JSON-RPC 并保留数据", () => {
    const protocol = new ACPProtocol();
    let data = "";
    protocol.on("yjs_update", (payload) => {
      data = `${payload.docName}:${payload.data}`;
    });
    protocol.handleMessage(JSON.stringify({ type: "yjs:update", docName: "chat", data: "AA==" }));
    expect(data).toBe("chat:AA==");
  });

  test("中文：成功响应派发标识和结果", () => {
    const protocol = new ACPProtocol();
    let result: unknown;
    protocol.on("rpc_response", (payload) => {
      result = payload.result;
    });
    protocol.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: "r1", result: { ok: true } }));
    expect(result).toEqual({ ok: true });
  });

  test("中文：错误响应作为结果派发以便等待方收敛", () => {
    const protocol = new ACPProtocol();
    let result: unknown;
    protocol.on("rpc_response", (payload) => {
      result = payload.result;
    });
    protocol.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -1, message: "拒绝" } }));
    expect(result).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -1, message: "拒绝" } });
  });

  test("中文：session update 通知保留会话和更新", () => {
    const protocol = new ACPProtocol();
    let sessionId = "";
    protocol.on("session_update", (payload) => {
      sessionId = payload.sessionId;
    });
    protocol.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: {} } }),
    );
    expect(sessionId).toBe("s1");
  });

  test("中文：带标识的权限请求也派发权限事件", () => {
    const protocol = new ACPProtocol();
    let requestId = "";
    protocol.on("permission_request", (payload) => {
      requestId = payload.requestId;
    });
    protocol.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "requestPermission",
        params: { requestId: "p1", sessionId: "s1", options: [], toolCall: { toolCallId: "t1" } },
      }),
    );
    expect(requestId).toBe("p1");
  });

  test("中文：旧权限请求同样派发权限事件", () => {
    const protocol = new ACPProtocol();
    let requestId = "";
    protocol.on("permission_request", (payload) => {
      requestId = payload.requestId;
    });
    protocol.handleMessage(JSON.stringify({ type: "permission_request", payload: { requestId: "legacy" } }));
    expect(requestId).toBe("legacy");
  });

  test("中文：交互问题消息保留问题标识", () => {
    const protocol = new ACPProtocol();
    let questionId = "";
    protocol.on("interactive_question", (payload) => {
      questionId = payload.questionId;
    });
    protocol.handleMessage(JSON.stringify({ type: "interactive_question", payload: { questionId: "q1" } }));
    expect(questionId).toBe("q1");
  });

  test("中文：模型变更通知派发模型标识", () => {
    const protocol = new ACPProtocol();
    let modelId = "";
    protocol.on("model_changed", (payload) => {
      modelId = payload.modelId;
    });
    protocol.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "session/modelChanged", params: { modelId: "m1" } }),
    );
    expect(modelId).toBe("m1");
  });

  test("中文：模式变更通知派发模式标识", () => {
    const protocol = new ACPProtocol();
    let modeId = "";
    protocol.on("mode_changed", (payload) => {
      modeId = payload.modeId;
    });
    protocol.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "session/modeChanged", params: { modeId: "plan" } }),
    );
    expect(modeId).toBe("plan");
  });

  test("中文：未知消息不会派发已知事件", () => {
    const protocol = new ACPProtocol();
    let calls = 0;
    protocol.on("status", () => {
      calls += 1;
    });
    protocol.handleMessage(JSON.stringify({ type: "unrecognized", payload: {} }));
    expect(calls).toBe(0);
  });

  test("中文：非法 JSON 不会抛出异常", () => {
    const protocol = new ACPProtocol();
    expect(() => protocol.handleMessage("{")).not.toThrow();
  });
});

describe("ACPState 内存状态、隔离与释放", () => {
  test("中文：初始状态没有会话和能力", () => {
    const { state, cleanup } = createBoundState();
    expect(state.sessionId).toBeNull();
    expect(state.agentCapabilities).toBeNull();
    cleanup();
  });

  test("中文：连接中状态向订阅者同步", () => {
    const { state, transport, cleanup } = createBoundState();
    transport.emit("state", { state: "connecting" });
    expect(state.connectionState).toBe("connecting");
    cleanup();
  });

  test("中文：连接成功状态向订阅者同步", () => {
    const { state, transport, cleanup } = createBoundState();
    transport.emit("state", { state: "connected" });
    expect(state.connectionState).toBe("connected");
    cleanup();
  });

  test("中文：远程节点不可用映射为专用错误", () => {
    const { state, transport, cleanup } = createBoundState();
    let error = "";
    state.on("connectionStateChange", (payload) => {
      error = payload.error ?? "";
    });
    transport.emit("state", { state: "error", detail: new CloseEvent("close", { code: 4500 }) });
    expect(error).toBe("machine_unavailable");
    cleanup();
  });

  test("中文：登录过期映射为本地化错误", () => {
    const { state, transport, cleanup } = createBoundState();
    let error = "";
    state.on("connectionStateChange", (payload) => {
      error = payload.error ?? "";
    });
    transport.emit("state", { state: "error", detail: new CloseEvent("close", { code: 4001 }) });
    expect(error).toBe("登录已过期");
    cleanup();
  });

  test("中文：普通关闭错误保留关闭原因", () => {
    const { state, transport, cleanup } = createBoundState();
    let error = "";
    state.on("connectionStateChange", (payload) => {
      error = payload.error ?? "";
    });
    transport.emit("state", { state: "error", detail: new CloseEvent("close", { code: 4000, reason: "已关闭" }) });
    expect(error).toBe("已关闭");
    cleanup();
  });

  test("中文：连接错误缺少原因时提供默认提示", () => {
    const { state, transport, cleanup } = createBoundState();
    let error = "";
    state.on("connectionStateChange", (payload) => {
      error = payload.error ?? "";
    });
    transport.emit("state", { state: "error" });
    expect(error).toBe("连接已断开，请刷新页面重试");
    cleanup();
  });

  test("中文：已连接 status 写入加载会话能力", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.handleMessage(
      JSON.stringify({ type: "status", payload: { connected: true, capabilities: { loadSession: true } } }),
    );
    expect(state.supportsLoadSession).toBe(true);
    expect(state.supportsSessionHistory).toBe(true);
    cleanup();
  });

  test("中文：未连接 status 不覆盖既有能力", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.handleMessage(
      JSON.stringify({ type: "status", payload: { connected: true, capabilities: { loadSession: true } } }),
    );
    protocol.handleMessage(JSON.stringify({ type: "status", payload: { connected: false } }));
    expect(state.supportsLoadSession).toBe(true);
    cleanup();
  });

  test("中文：创建会话写入标识与图片能力", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("session_created", { sessionId: "s1", promptCapabilities: { image: true } });
    expect(state.sessionId).toBe("s1");
    expect(state.supportsImages).toBe(true);
    cleanup();
  });

  test("中文：加载会话替换会话标识", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("session_loaded", { sessionId: "loaded" });
    expect(state.sessionId).toBe("loaded");
    cleanup();
  });

  test("中文：恢复会话替换会话标识", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("session_resumed", { sessionId: "resumed" });
    expect(state.sessionId).toBe("resumed");
    cleanup();
  });

  test("中文：可用模型开启模型选择", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("session_created", {
      sessionId: "s1",
      models: { availableModels: [{ modelId: "m1", name: "模型一" }], currentModelId: "m1" },
    });
    expect(state.supportsModelSelection).toBe(true);
    cleanup();
  });

  test("中文：空模型列表不支持模型选择", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("session_created", { sessionId: "s1", models: { availableModels: [], currentModelId: "" } });
    expect(state.supportsModelSelection).toBe(false);
    cleanup();
  });

  test("中文：合法模型变更更新当前模型", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("session_created", {
      sessionId: "s1",
      models: {
        availableModels: [
          { modelId: "m1", name: "模型一" },
          { modelId: "m2", name: "模型二" },
        ],
        currentModelId: "m1",
      },
    });
    protocol.emit("model_changed", { modelId: "m2" });
    expect(state.modelState?.currentModelId).toBe("m2");
    cleanup();
  });

  test("中文：未知模型不会修改当前模型", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("session_created", {
      sessionId: "s1",
      models: { availableModels: [{ modelId: "m1", name: "模型一" }], currentModelId: "m1" },
    });
    protocol.emit("model_changed", { modelId: "unknown" });
    expect(state.modelState?.currentModelId).toBe("m1");
    cleanup();
  });

  test("中文：合法模式变更更新当前模式", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("session_created", {
      sessionId: "s1",
      modes: {
        availableModes: [
          { id: "plan", name: "计划" },
          { id: "code", name: "编码" },
        ],
        currentModeId: "plan",
      },
    });
    protocol.emit("mode_changed", { modeId: "code" });
    expect(state.modeState?.currentModeId).toBe("code");
    cleanup();
  });

  test("中文：未知模式不会修改当前模式", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("session_created", {
      sessionId: "s1",
      modes: { availableModes: [{ id: "plan", name: "计划" }], currentModeId: "plan" },
    });
    protocol.emit("mode_changed", { modeId: "unknown" });
    expect(state.modeState?.currentModeId).toBe("plan");
    cleanup();
  });

  test("中文：命令更新替换而非累加旧命令", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "help", description: "帮助" }],
          },
        },
      }),
    );
    expect(state.availableCommands.map((command) => command.name)).toEqual(["help"]);
    cleanup();
  });

  test("中文：非命令更新不改变命令列表", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } },
      }),
    );
    expect(state.availableCommands).toEqual([]);
    cleanup();
  });

  test("中文：断开连接释放会话状态", () => {
    const { state, protocol, transport, cleanup } = createBoundState();
    protocol.emit("session_created", { sessionId: "s1", promptCapabilities: { image: true } });
    transport.emit("state", { state: "disconnected" });
    expect(state.sessionId).toBeNull();
    expect(state.supportsImages).toBe(false);
    cleanup();
  });

  test("中文：reset 释放模型、模式和命令", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("session_created", {
      sessionId: "s1",
      models: { availableModels: [{ modelId: "m1", name: "模型一" }], currentModelId: "m1" },
      modes: { availableModes: [{ id: "plan", name: "计划" }], currentModeId: "plan" },
    });
    state.reset();
    expect(state.modelState).toBeNull();
    expect(state.modeState).toBeNull();
    expect(state.availableCommands).toEqual([]);
    cleanup();
  });

  test("中文：cleanup 后协议事件不会泄漏到旧状态", () => {
    const { state, protocol, cleanup } = createBoundState();
    cleanup();
    protocol.emit("session_created", { sessionId: "after-cleanup" });
    expect(state.sessionId).toBeNull();
  });

  test("中文：cleanup 后传输事件不会泄漏到旧状态", () => {
    const { state, transport, cleanup } = createBoundState();
    cleanup();
    transport.emit("state", { state: "connected" });
    expect(state.connectionState).toBe("disconnected");
  });

  test("中文：两个状态实例之间保持会话隔离", () => {
    const first = createBoundState();
    const second = createBoundState();
    first.protocol.emit("session_created", { sessionId: "first" });
    expect(first.state.sessionId).toBe("first");
    expect(second.state.sessionId).toBeNull();
    first.cleanup();
    second.cleanup();
  });

  test("中文：状态变更事件包含新会话标识", () => {
    const { state, protocol, cleanup } = createBoundState();
    let sessionId: string | null = null;
    state.on("sessionIdChange", (value) => {
      sessionId = value;
    });
    protocol.emit("session_created", { sessionId: "event-session" });
    expect(sessionId).toBe("event-session");
    cleanup();
  });

  test("中文：重置事件把会话标识通知为 null", () => {
    const { state, protocol, cleanup } = createBoundState();
    let sessionId = "not-reset";
    state.on("sessionIdChange", (value) => {
      sessionId = value ?? "null";
    });
    protocol.emit("session_created", { sessionId: "s1" });
    state.reset();
    expect(sessionId).toBe("null");
    cleanup();
  });

  test("中文：resume 能力开启会话历史", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("status", { connected: true, capabilities: { sessionCapabilities: { resume: {} } } });
    expect(state.supportsResumeSession).toBe(true);
    expect(state.supportsSessionHistory).toBe(true);
    cleanup();
  });

  test("中文：list 能力可被独立识别", () => {
    const { state, protocol, cleanup } = createBoundState();
    protocol.emit("status", { connected: true, capabilities: { sessionCapabilities: { list: {} } } });
    expect(state.supportsSessionList).toBe(true);
    expect(state.supportsResumeSession).toBe(false);
    cleanup();
  });
});
