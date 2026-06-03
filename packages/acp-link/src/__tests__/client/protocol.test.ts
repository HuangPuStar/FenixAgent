import { beforeEach, describe, expect, test } from "bun:test";
import { ACPProtocol } from "../../client/protocol.js";

// ACPProtocol JSON-RPC 解析测试
describe("ACPProtocol", () => {
  let protocol: ACPProtocol;

  beforeEach(() => {
    protocol = new ACPProtocol();
  });

  // 测试传输层 status connected 事件
  test("handleMessage — transport status connected", () => {
    let received: any = null;
    protocol.on("status", (payload) => {
      received = payload;
    });
    protocol.handleMessage(
      JSON.stringify({ type: "status", payload: { connected: true, capabilities: { loadSession: true } } }),
    );
    expect(received).not.toBeNull();
    expect(received.connected).toBe(true);
    expect(received.capabilities.loadSession).toBe(true);
  });

  // 测试传输层 error 事件
  test("handleMessage — transport error", () => {
    let received: any = null;
    protocol.on("error", (payload) => {
      received = payload;
    });
    protocol.handleMessage(JSON.stringify({ type: "error", payload: { message: "test error" } }));
    expect(received).not.toBeNull();
    expect(received.message).toBe("test error");
  });

  // 测试传输层 pong 事件
  test("handleMessage — transport pong", () => {
    let called = false;
    protocol.on("pong", () => {
      called = true;
    });
    protocol.handleMessage(JSON.stringify({ type: "pong" }));
    expect(called).toBe(true);
  });

  // 测试 JSON-RPC 成功响应派发 rpc_response 事件
  test("handleMessage — JSON-RPC success response emits rpc_response", () => {
    let received: any = null;
    protocol.on("rpc_response", (payload) => {
      received = payload;
    });
    protocol.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "ses_1" } }));
    expect(received).not.toBeNull();
    expect(received.id).toBe(1);
    expect((received.result as { sessionId: string }).sessionId).toBe("ses_1");
  });

  // 测试 JSON-RPC 错误响应派发 rpc_response 事件
  test("handleMessage — JSON-RPC error response emits rpc_response", () => {
    let received: any = null;
    protocol.on("rpc_response", (payload) => {
      received = payload;
    });
    protocol.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Internal error" } }),
    );
    expect(received).not.toBeNull();
    expect(received.id).toBe(2);
    expect((received.result as { error: { message: string } }).error.message).toBe("Internal error");
  });

  // 测试 JSON-RPC session/update 通知
  test("handleMessage — JSON-RPC session/update notification", () => {
    let received: any = null;
    protocol.on("session_update", (payload) => {
      received = payload;
    });
    const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } };
    protocol.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "ses_1", update } }),
    );
    expect(received).not.toBeNull();
    expect(received.sessionId).toBe("ses_1");
    expect(received.update.sessionUpdate).toBe("agent_message_chunk");
  });

  // 测试 JSON-RPC session/modelChanged 通知
  test("handleMessage — JSON-RPC session/modelChanged notification", () => {
    let received: any = null;
    protocol.on("model_changed", (payload) => {
      received = payload;
    });
    protocol.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "session/modelChanged", params: { modelId: "gpt-4" } }),
    );
    expect(received).not.toBeNull();
    expect(received.modelId).toBe("gpt-4");
  });

  // 测试 JSON-RPC session/modeChanged 通知
  test("handleMessage — JSON-RPC session/modeChanged notification", () => {
    let received: any = null;
    protocol.on("mode_changed", (payload) => {
      received = payload;
    });
    protocol.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "session/modeChanged", params: { modeId: "code" } }),
    );
    expect(received).not.toBeNull();
    expect(received.modeId).toBe("code");
  });

  // 测试 JSON-RPC requestPermission 通知
  test("handleMessage — JSON-RPC requestPermission notification", () => {
    let received: any = null;
    protocol.on("permission_request", (payload) => {
      received = payload;
    });
    protocol.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "requestPermission",
        params: { requestId: "req_1", sessionId: "ses_1", options: [], toolCall: { toolCallId: "tc_1" } },
      }),
    );
    expect(received).not.toBeNull();
    expect(received.requestId).toBe("req_1");
  });

  // 测试 keep_alive 被过滤
  test("handleMessage — keep_alive is filtered", () => {
    let anyEvent = false;
    protocol.on("status", () => {
      anyEvent = true;
    });
    protocol.on("rpc_response", () => {
      anyEvent = true;
    });
    protocol.handleMessage(JSON.stringify({ type: "keep_alive" }));
    expect(anyEvent).toBe(false);
  });

  // 测试无效 JSON 不抛错
  test("handleMessage — invalid JSON does not throw", () => {
    expect(() => protocol.handleMessage("not json")).not.toThrow();
  });

  // 测试未知 JSON-RPC 通知不抛错
  test("handleMessage — unknown JSON-RPC notification does not throw", () => {
    expect(() =>
      protocol.handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "unknown/method", params: {} })),
    ).not.toThrow();
  });
});
