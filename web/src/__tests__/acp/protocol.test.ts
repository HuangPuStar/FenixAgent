import { describe, test, expect, beforeEach } from "bun:test";
import { ACPProtocol } from "../../acp/protocol";

// ACPProtocol 无状态解析测试
describe("ACPProtocol", () => {
  let protocol: ACPProtocol;

  beforeEach(() => {
    protocol = new ACPProtocol();
  });

  // 测试 status connected 事件
  test("handleMessage — status connected", () => {
    let received: any = null;
    protocol.on("status", (payload) => { received = payload; });
    protocol.handleMessage(JSON.stringify({ type: "status", payload: { connected: true, capabilities: { loadSession: true } } }));
    expect(received).not.toBeNull();
    expect(received.connected).toBe(true);
    expect(received.capabilities.loadSession).toBe(true);
  });

  // 测试 error 事件
  test("handleMessage — error", () => {
    let received: any = null;
    protocol.on("error", (payload) => { received = payload; });
    protocol.handleMessage(JSON.stringify({ type: "error", payload: { message: "test error" } }));
    expect(received).not.toBeNull();
    expect(received.message).toBe("test error");
  });

  // 测试 session_created 事件
  test("handleMessage — session_created", () => {
    let received: any = null;
    protocol.on("session_created", (payload) => { received = payload; });
    protocol.handleMessage(JSON.stringify({ type: "session_created", payload: { sessionId: "ses_1" } }));
    expect(received).not.toBeNull();
    expect(received.sessionId).toBe("ses_1");
  });

  // 测试 session_list 事件
  test("handleMessage — session_list", () => {
    let received: any = null;
    protocol.on("session_list", (payload) => { received = payload; });
    const msg = { type: "session_list", payload: { sessions: [{ sessionId: "s1", cwd: "/tmp" }], nextCursor: null } };
    protocol.handleMessage(JSON.stringify(msg));
    expect(received).not.toBeNull();
    expect(received.sessions.length).toBe(1);
  });

  // 测试 session_update 事件拆分为 sessionId + update
  test("handleMessage — session_update", () => {
    let received: any = null;
    protocol.on("session_update", (payload) => { received = payload; });
    const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } };
    protocol.handleMessage(JSON.stringify({ type: "session_update", payload: { sessionId: "ses_1", update } }));
    expect(received).not.toBeNull();
    expect(received.sessionId).toBe("ses_1");
    expect(received.update.sessionUpdate).toBe("agent_message_chunk");
  });

  // 测试 model_changed 事件
  test("handleMessage — model_changed", () => {
    let received: any = null;
    protocol.on("model_changed", (payload) => { received = payload; });
    protocol.handleMessage(JSON.stringify({ type: "model_changed", payload: { modelId: "gpt-4" } }));
    expect(received).not.toBeNull();
    expect(received.modelId).toBe("gpt-4");
  });

  // 测试 pong 事件
  test("handleMessage — pong", () => {
    let called = false;
    protocol.on("pong", () => { called = true; });
    protocol.handleMessage(JSON.stringify({ type: "pong" }));
    expect(called).toBe(true);
  });

  // 测试 keep_alive 被过滤
  test("handleMessage — keep_alive is filtered", () => {
    let anyEvent = false;
    protocol.on("status", () => { anyEvent = true; });
    protocol.on("pong", () => { anyEvent = true; });
    protocol.handleMessage(JSON.stringify({ type: "keep_alive" }));
    expect(anyEvent).toBe(false);
  });

  // 测试无效 JSON 不抛错
  test("handleMessage — invalid JSON does not throw", () => {
    expect(() => protocol.handleMessage("not json")).not.toThrow();
  });

  // 测试未知消息类型不抛错
  test("handleMessage — unknown type does not throw", () => {
    expect(() => protocol.handleMessage(JSON.stringify({ type: "unknown_type" }))).not.toThrow();
  });
});
