import { describe, expect, test } from "bun:test";
import { SessionManager } from "../client/session-manager";

interface SessionListItem {
  sessionId: string;
  title?: string;
}

interface SessionEvent {
  relayId: string;
  event: string;
  payload: unknown;
}

function createManagerWithSessionList(listSessions: () => Promise<{ sessions: SessionListItem[] }>): {
  manager: SessionManager;
  events: SessionEvent[];
} {
  const manager = new SessionManager("unused-agent");
  const events: SessionEvent[] = [];
  manager.on("session_data", (relayId: string, payload: unknown) => {
    events.push({ relayId, event: "session_data", payload });
  });
  manager.on("session_error", (relayId: string, payload: unknown) => {
    events.push({ relayId, event: "session_error", payload });
  });
  Reflect.set(manager, "sharedConnection", { listSessions });
  return { manager, events };
}

describe("SessionManager session/list 协议", () => {
  // 成功列出会话时，仅保留可显示标题并将结果投递给发起该请求的 relay。
  test("session/list 过滤无效标题并保持 relay 会话隔离", async () => {
    const { manager, events } = createManagerWithSessionList(async () => ({
      sessions: [
        { sessionId: "ses-visible", title: "保留的会话" },
        { sessionId: "ses-new", title: " New Session 1 " },
        { sessionId: "ses-empty", title: "   " },
      ],
    }));

    await manager.sendData("relay-a", { jsonrpc: "2.0", id: 1, method: "session/list" });
    await manager.sendData("relay-b", { jsonrpc: "2.0", id: 2, method: "session/list" });

    expect(events).toEqual([
      {
        relayId: "relay-a",
        event: "session_data",
        payload: {
          jsonrpc: "2.0",
          id: 1,
          result: { sessions: [{ sessionId: "ses-visible", title: "保留的会话" }] },
        },
      },
      {
        relayId: "relay-b",
        event: "session_data",
        payload: {
          jsonrpc: "2.0",
          id: 2,
          result: { sessions: [{ sessionId: "ses-visible", title: "保留的会话" }] },
        },
      },
    ]);
  });

  // 未支持的 JSON-RPC 方法必须返回标准 Method not found 错误，而非抛出异常。
  test("未知 JSON-RPC 方法返回 -32601 错误", async () => {
    const { manager, events } = createManagerWithSessionList(async () => ({ sessions: [] }));

    await manager.sendData("relay-invalid", { jsonrpc: "2.0", id: "bad-1", method: "session/unknown" });

    expect(events).toEqual([
      {
        relayId: "relay-invalid",
        event: "session_data",
        payload: {
          jsonrpc: "2.0",
          id: "bad-1",
          error: { code: -32601, message: "Method not found: session/unknown" },
        },
      },
    ]);
  });

  // Agent 查询失败时只向当前 relay 报错，避免将一个会话的失败泄漏给其他会话。
  test("session/list 查询失败仅向发起 relay 发送错误", async () => {
    const { manager, events } = createManagerWithSessionList(async () => {
      throw new Error("agent unavailable");
    });

    await manager.sendData("relay-failed", { jsonrpc: "2.0", id: 3, method: "session/list" });

    expect(events).toEqual([
      {
        relayId: "relay-failed",
        event: "session_data",
        payload: {
          jsonrpc: "2.0",
          id: 3,
          error: { code: -32603, message: "Error: agent unavailable" },
        },
      },
    ]);
  });
});
