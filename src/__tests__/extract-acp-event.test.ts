// src/__tests__/extract-acp-event.test.ts
import { expect, test } from "bun:test";
import { extractAcpEvent } from "../transport/relay/relay-handler";

// 原始引擎格式：type=agent_message_chunk
test("extracts raw engine type", () => {
  const raw = { type: "agent_message_chunk", payload: { type: "text", text: "hello" } };
  const result = extractAcpEvent(raw, "agent_message_chunk");
  expect(result.type).toBe("agent_message_chunk");
  expect(result.payload?.text).toBe("hello");
});

// JSON-RPC session/update 通知格式
test("extracts JSON-RPC session/update notification", () => {
  const raw = {
    type: "session_data",
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses_1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } },
      },
    },
  };
  const result = extractAcpEvent(raw, "session_data");
  expect(result.type).toBe("agent_thought_chunk");
  expect(result.payload?.sessionUpdate).toBe("agent_thought_chunk");
});

// session_data 包裹的非 JSON-RPC prompt_complete 事件——这是本次修复的关键场景
test("extracts nested event type from session_data payload", () => {
  const raw = {
    type: "session_data",
    session_id: "ses_abc",
    payload: { type: "prompt_complete", payload: { stopReason: "end_turn", usage: { totalTokens: 100 } } },
  };
  const result = extractAcpEvent(raw, "session_data");
  expect(result.type).toBe("prompt_complete");
  expect(result.payload?.stopReason).toBe("end_turn");
});

// session_data 包裹的 session_list 事件——不应被 JSON-RPC 路径误匹配
test("extracts nested session_list from session_data payload", () => {
  const raw = {
    type: "session_data",
    session_id: "relay_1",
    payload: { type: "session_list", payload: { sessions: [{ sessionId: "ses_1", title: "Test" }] } },
  };
  const result = extractAcpEvent(raw, "session_data");
  expect(result.type).toBe("session_list");
  expect(Array.isArray(result.payload?.sessions)).toBe(true);
});

// JSON-RPC 响应（有 result 无 method）不应被 session_data 嵌套提取
test("JSON-RPC response in session_data is NOT extracted as nested event", () => {
  const raw = {
    type: "session_data",
    session_id: "relay_1",
    payload: { jsonrpc: "2.0", id: 1, result: { sessionId: "ses_new", models: {} } },
  };
  const result = extractAcpEvent(raw, "session_data");
  // jsonrpc 在 payload 中，但 extractJsonRpc 能找到它，只是 rpc.method !== "session/update"
  // 所以走不到 JSON-RPC 提取分支；result 中没有 stopReason，不会触发 step 1.5
  expect(result.type).toBe("session_data");
});

// JSON-RPC 响应中包含 stopReason（prompt 完成）→ 应提取为 prompt_complete
test("JSON-RPC response with stopReason extracted as prompt_complete", () => {
  const raw = {
    type: "session_data",
    session_id: "ses_1",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      result: { stopReason: "end_turn", usage: { totalTokens: 150 }, content: [] },
    },
  };
  const result = extractAcpEvent(raw, "session_data");
  expect(result.type).toBe("prompt_complete");
  expect(result.payload?.stopReason).toBe("end_turn");
  const payload = result.payload as { stopReason: string; usage?: { totalTokens: number } };
  expect(payload.usage?.totalTokens).toBe(150);
});

// session_error 保持原样
test("session_error msgType passes through", () => {
  const raw = {
    type: "session_error",
    session_id: "ses_1",
    error: "Something went wrong",
  };
  const result = extractAcpEvent(raw, "session_error");
  expect(result.type).toBe("session_error");
  expect(result.payload?.error).toBe("Something went wrong");
});

// 未知 msgType 回退到 "unknown"
test("unknown msgType falls back to 'unknown'", () => {
  const raw = { type: "weird_event", payload: { x: 1 } };
  const result = extractAcpEvent(raw, undefined);
  expect(result.type).toBe("unknown");
});
