import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpDispatcher, createAcpSessionState } from "../acp-dispatcher";

interface CapturedMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  type?: string;
  payload?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function createDispatcher(options?: {
  connection?: acp.ClientSideConnection | null;
  sessionId?: string | null;
  onControlResponse?: (requestId: string, approved: boolean, extra?: Record<string, unknown>) => void;
  onPermissionOutcome?: (
    requestId: string,
    outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string },
  ) => boolean;
}): { dispatcher: AcpDispatcher; state: ReturnType<typeof createAcpSessionState>; sent: CapturedMessage[] } {
  const state = createAcpSessionState();
  state.connection = options?.connection ?? null;
  state.sessionId = options?.sessionId ?? null;
  const sent: CapturedMessage[] = [];
  const dispatcher = new AcpDispatcher(state, {
    send: (message) => sent.push(message as CapturedMessage),
    onControlResponse: options?.onControlResponse,
    onPermissionOutcome: options?.onPermissionOutcome,
  });
  return { dispatcher, state, sent };
}

describe("AcpDispatcher 协议适配", () => {
  // session/update 的 session_info_update 必须缓存标题，同时将原始通知转发给 relay，避免本地标题与远端事件分叉
  test("缓存会话标题并原样转发 session/update 通知", async () => {
    const { dispatcher, state, sent } = createDispatcher();
    const params = {
      sessionId: "ses_1",
      update: { sessionUpdate: "session_info_update", title: "重命名后的会话" },
    };

    await dispatcher.handleMessage({ jsonrpc: "2.0", method: "session/update", params });

    expect(state.titleOverrides.get("ses_1")).toBe("重命名后的会话");
    expect(sent).toEqual([{ jsonrpc: "2.0", method: "session/update", params }]);
  });

  // connect、ping、disconnect 是无状态 JSON-RPC 外的 transport 帧；断连后必须清空当前连接与会话，避免后续请求误投旧会话
  test("处理连接状态、心跳和断连隔离", async () => {
    const connection = {} as unknown as acp.ClientSideConnection;
    const { dispatcher, state, sent } = createDispatcher({ connection, sessionId: "ses_1" });
    state.agentCapabilities = { loadSession: true };

    await dispatcher.handleMessage({ type: "connect" });
    await dispatcher.handleMessage({ type: "ping" });
    await dispatcher.handleMessage({ type: "disconnect" });

    expect(sent).toEqual([
      {
        type: "status",
        payload: { connected: true, agentInfo: { name: "remote-agent" }, capabilities: { loadSession: true } },
      },
      { type: "pong" },
      { type: "status", payload: { connected: false } },
    ]);
    expect(state.connection).toBeNull();
    expect(state.sessionId).toBeNull();
  });

  // permission JSON-RPC 响应只把 allow/allow_* 视为授权，且同一结果同时交给 Claude 与通用 ACP 权限路径
  test("将 allow 权限响应映射为已授权的双路径结果", async () => {
    const controlResponses: Array<{ requestId: string; approved: boolean; extra?: Record<string, unknown> }> = [];
    const permissionOutcomes: Array<{ requestId: string; outcome: { outcome: string; optionId?: string } }> = [];
    const { dispatcher } = createDispatcher({
      onControlResponse: (requestId, approved, extra) => controlResponses.push({ requestId, approved, extra }),
      onPermissionOutcome: (requestId, outcome) => {
        permissionOutcomes.push({ requestId, outcome });
        return true;
      },
    });
    const result = { outcome: { outcome: "selected", optionId: "allow_once" } };

    await dispatcher.handleMessage({ jsonrpc: "2.0", id: "perm_1", result });

    expect(controlResponses).toEqual([{ requestId: "perm_1", approved: true, extra: result }]);
    expect(permissionOutcomes).toEqual([
      { requestId: "perm_1", outcome: { outcome: "selected", optionId: "allow_once" } },
    ]);
  });

  // 拒绝、取消及非 perm_ 响应不得被误判为授权或触发权限回调，防止无关 JSON-RPC 响应跨协议污染权限状态
  test("隔离拒绝和非权限 JSON-RPC 响应", async () => {
    const controlResponses: Array<{ requestId: string; approved: boolean }> = [];
    const permissionOutcomes: string[] = [];
    const { dispatcher } = createDispatcher({
      onControlResponse: (requestId, approved) => controlResponses.push({ requestId, approved }),
      onPermissionOutcome: (requestId) => {
        permissionOutcomes.push(requestId);
        return true;
      },
    });

    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: "perm_2",
      result: { outcome: { outcome: "selected", optionId: "reject" } },
    });
    await dispatcher.handleMessage({ jsonrpc: "2.0", id: "request_3", result: { outcome: { outcome: "selected" } } });

    expect(controlResponses).toEqual([{ requestId: "perm_2", approved: false }]);
    expect(permissionOutcomes).toEqual(["perm_2"]);
  });

  // 未支持的方法必须转为标准 -32601 响应，不得抛出异常中断同一 relay 上其他会话的消息分发
  test("隔离未知 RPC 方法并返回 -32601", async () => {
    const { dispatcher, sent } = createDispatcher();

    await dispatcher.handleMessage({ jsonrpc: "2.0", id: 9, method: "session/unsupported", params: {} });

    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 9, error: { code: -32601, message: "Method not found: session/unsupported" } },
    ]);
  });
});
