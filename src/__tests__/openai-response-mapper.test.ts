import { describe, expect, test } from "bun:test";
import { buildOpenAIError, mapToNonStreamingResponse } from "../services/openai-response-mapper";

describe("mapToNonStreamingResponse", () => {
  // agent_thought_chunk → reasoning_content
  test("将 agent_thought_chunk 映射到 reasoning_content", () => {
    const events = [
      {
        type: "session_data",
        payload: {
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "让我想想..." } } },
        },
      },
      { type: "session_data", payload: { jsonrpc: "2.0", result: { stopReason: "end_turn" } } },
    ] as any;
    const res = mapToNonStreamingResponse(events, "agent-123");
    expect(res.choices[0].message.reasoning_content).toBe("让我想想...");
    expect(res.choices[0].finish_reason).toBe("end_turn");
  });

  // agent_message_chunk → content
  test("将 agent_message_chunk 映射到 content", () => {
    const events = [
      {
        type: "session_data",
        payload: {
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "您好！" } } },
        },
      },
      { type: "session_data", payload: { jsonrpc: "2.0", result: { stopReason: "end_turn" } } },
    ] as any;
    const res = mapToNonStreamingResponse(events, "agent-123");
    expect(res.choices[0].message.content).toBe("您好！");
  });

  // tool_call → 简化 XML 在 content 中
  test("将 tool_call 映射为简化 XML", () => {
    const events = [
      {
        type: "session_data",
        payload: {
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "get_weather" } },
        },
      },
      {
        type: "session_data",
        payload: {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "get_weather", status: "completed" },
          },
        },
      },
      {
        type: "session_data",
        payload: {
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "今天晴天" } } },
        },
      },
      { type: "session_data", payload: { jsonrpc: "2.0", result: { stopReason: "end_turn" } } },
    ] as any;
    const res = mapToNonStreamingResponse(events, "agent-123");
    expect(res.choices[0].message.content).toContain('<tool_call name="get_weather" />');
    expect(res.choices[0].message.content).toContain('<tool_result name="get_weather" />');
    expect(res.choices[0].message.content).toContain("今天晴天");
  });

  // 无 agent_thought_chunk 时 reasoning_content 不出现
  test("无 thinking 时 reasoning_content 不出现在响应中", () => {
    const events = [
      {
        type: "session_data",
        payload: {
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "直接回答" } } },
        },
      },
      { type: "session_data", payload: { jsonrpc: "2.0", result: { stopReason: "end_turn" } } },
    ] as any;
    const res = mapToNonStreamingResponse(events, "agent-123");
    expect(res.choices[0].message.reasoning_content).toBeUndefined();
  });

  // plan → reasoning_content
  test("将 plan 事件映射到 reasoning_content", () => {
    const events = [
      {
        type: "session_data",
        payload: {
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "plan", entries: [{ content: "Step 1", status: "pending" }] } },
        },
      },
      {
        type: "session_data",
        payload: {
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } } },
        },
      },
      { type: "session_data", payload: { jsonrpc: "2.0", result: { stopReason: "end_turn" } } },
    ] as any;
    const res = mapToNonStreamingResponse(events, "agent-123");
    expect(res.choices[0].message.reasoning_content).toContain("Step 1");
  });
});

describe("buildOpenAIError", () => {
  // 401 错误
  test("构建 401 认证错误", () => {
    const res = buildOpenAIError(401, "Invalid API key", "authentication_error");
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe("authentication_error");
  });

  // 404 错误
  test("构建 404 未找到错误", () => {
    const res = buildOpenAIError(404, "Agent not found", "invalid_request_error");
    expect(res.status).toBe(404);
  });

  // 500 错误
  test("构建 500 服务器错误", () => {
    const res = buildOpenAIError(500, "Internal error", "server_error");
    expect(res.status).toBe(500);
  });
});
