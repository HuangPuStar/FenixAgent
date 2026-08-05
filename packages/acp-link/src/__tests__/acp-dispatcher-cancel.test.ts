// packages/acp-link/src/__tests__/acp-dispatcher-cancel.test.ts
// AcpDispatcher session/cancel 路由测试（P2-4）：
// - params.sessionId 透传：cancel RPC 携带目标会话时，connection.cancel 收到该 sessionId，
//   adapter 注册表据此精确中断对应 session 的 query（多会话并发不串键）；
// - 旧客户端不携带 sessionId 时 fallback 当前会话（state.sessionId，向后兼容）；
// - 无连接/无会话时回 { cancelled: false }（断点 3 前端超时兜底依赖此响应形状）。

import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpDispatcher, createAcpSessionState } from "../acp-dispatcher";

/** 构造只实现 cancel 的 fake ClientSideConnection（其余方法不参与本测试） */
function createFakeConnection(): {
  conn: acp.ClientSideConnection;
  cancelParams: Array<Record<string, unknown>>;
} {
  const cancelParams: Array<Record<string, unknown>> = [];
  const conn = {
    async cancel(params: Record<string, unknown>) {
      cancelParams.push(params);
    },
  } as unknown as acp.ClientSideConnection;
  return { conn, cancelParams };
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

describe("AcpDispatcher session/cancel", () => {
  // P2-4：cancel RPC 携带 params.sessionId 时透传给 connection.cancel——多会话并发下
  // 必须按 RPC 中的目标会话精确路由（adapter 注册表按 sessionId 定位）
  test("cancel 透传 params.sessionId 到 connection.cancel", async () => {
    const { conn, cancelParams } = createFakeConnection();
    const { dispatcher, responses } = createDispatcher(conn, "ses-current");

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/cancel",
      params: { sessionId: "ses-target" },
    });

    expect(cancelParams).toEqual([{ sessionId: "ses-target" }]);
    expect(responses[0]).toMatchObject({ id: 1, result: { cancelled: true } });
  });

  // P2-4 向后兼容：旧客户端 cancel 不携带 sessionId 时 fallback 当前会话（state.sessionId）
  test("cancel 无 sessionId 时 fallback 当前会话", async () => {
    const { conn, cancelParams } = createFakeConnection();
    const { dispatcher } = createDispatcher(conn, "ses-current");

    await dispatcher.handleMessage({ jsonrpc: "2.0", id: 2, method: "session/cancel", params: {} });

    expect(cancelParams).toEqual([{ sessionId: "ses-current" }]);
  });

  // 无连接或会话未建立时回 { cancelled: false } 不抛错（断点 3 前端超时兜底依赖此响应形状）
  test("无连接时 cancel 回 cancelled:false 不抛错", async () => {
    const { dispatcher, responses } = createDispatcher(null, null);

    await dispatcher.handleMessage({ jsonrpc: "2.0", id: 3, method: "session/cancel", params: {} });

    expect(responses[0]).toMatchObject({ id: 3, result: { cancelled: false } });
  });
});
