// packages/acp-link/src/__tests__/acp-dispatcher-prompt.test.ts
// AcpDispatcher session/prompt 路由测试（与 session/cancel 对称，P2-4 同源问题）：
// - params.sessionId 透传：prompt RPC 携带目标会话时，connection.prompt 收到该
//   sessionId——多会话共享 relay 时连接级 state.sessionId 是单值，可能已被其他会话
//   的最后一次操作改写，不带 sessionId 的 prompt 会落到错误会话且不报错（前端
//   表现为当前 turn 永久 loading 的根因之一）；
// - 旧客户端不携带 sessionId 时 fallback 当前会话（state.sessionId，向后兼容）；
// - 无连接/无会话时回 -32000 No active session（与 create/load 一致）。

import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { AcpDispatcher, createAcpSessionState } from "../acp-dispatcher";

/** 构造只实现 prompt 的 fake ClientSideConnection（其余方法不参与本测试） */
function createFakeConnection(): {
  conn: acp.ClientSideConnection;
  promptParams: Array<Record<string, unknown>>;
} {
  const promptParams: Array<Record<string, unknown>> = [];
  const conn = {
    async prompt(params: Record<string, unknown>) {
      promptParams.push(params);
      return { turnId: "turn_1" };
    },
  } as unknown as acp.ClientSideConnection;
  return { conn, promptParams };
}

/** 构造 dispatcher，返回 send 捕获的 JSON-RPC 响应列表 */
function createDispatcher(
  conn: acp.ClientSideConnection | null,
  sessionId: string | null,
): {
  dispatcher: AcpDispatcher;
  responses: Array<Record<string, unknown>>;
} {
  const state = createAcpSessionState();
  state.connection = conn;
  state.sessionId = sessionId;
  const responses: Array<Record<string, unknown>> = [];
  const dispatcher = new AcpDispatcher(state, {
    send: (message) => responses.push(message as Record<string, unknown>),
  });
  return { dispatcher, responses };
}

describe("AcpDispatcher session/prompt", () => {
  // prompt RPC 携带 params.sessionId 时透传给 connection.prompt——多会话共享 relay 时
  // 必须按 RPC 中的目标会话精确路由（连接级当前会话可能已被其他会话改写）
  test("prompt 透传 params.sessionId 到 connection.prompt", async () => {
    const { conn, promptParams } = createFakeConnection();
    const { dispatcher, responses } = createDispatcher(conn, "ses-current");

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { content: [{ type: "text", text: "hello" }], sessionId: "ses-target" },
    });

    expect(promptParams).toEqual([{ sessionId: "ses-target", prompt: [{ type: "text", text: "hello" }] }]);
    expect(responses[0]).toMatchObject({ id: 1, result: { turnId: "turn_1" } });
  });

  // 向后兼容：旧客户端 prompt 不携带 sessionId 时 fallback 当前会话（state.sessionId）
  test("prompt 无 sessionId 时 fallback 当前会话", async () => {
    const { conn, promptParams } = createFakeConnection();
    const { dispatcher } = createDispatcher(conn, "ses-current");

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { content: [{ type: "text", text: "hi" }] },
    });

    expect(promptParams).toEqual([{ sessionId: "ses-current", prompt: [{ type: "text", text: "hi" }] }]);
  });

  // 无连接或会话未建立时回 -32000 No active session，不抛错
  test("无连接时 prompt 回 No active session 不抛错", async () => {
    const { dispatcher, responses } = createDispatcher(null, null);

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { content: [{ type: "text", text: "hi" }] },
    });

    expect(responses[0]).toMatchObject({ id: 3, error: { code: -32000 } });
  });

  // SDK 的 RequestError 是 stdio JSON-RPC error 的结构化表示；dispatcher 不得将
  // Peri implementation-defined code/data 降级成通用 -32603。
  test("prompt 原样转发 Peri RequestError", async () => {
    const conn = {
      async prompt() {
        throw new RequestError(-32000, "LLM HTTP 429: rate limit exceeded", {
          kind: "llm_http",
          status: 429,
        });
      },
    } as unknown as acp.ClientSideConnection;
    const { dispatcher, responses } = createDispatcher(conn, "ses-current");

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { content: [{ type: "text", text: "hi" }] },
    });

    expect(responses).toEqual([
      {
        jsonrpc: "2.0",
        id: 4,
        error: {
          code: -32000,
          message: "LLM HTTP 429: rate limit exceeded",
          data: { kind: "llm_http", status: 429 },
        },
      },
    ]);
  });
});
