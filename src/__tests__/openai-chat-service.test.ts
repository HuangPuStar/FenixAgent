import { describe, expect, test } from "bun:test";
import { createAgentSession, startPromptTurn } from "../services/agent-chat-service";

function makeMockRelayHandle(overrides: Record<string, unknown> = {}) {
  return {
    state: "open" as const,
    send: () => {},
    close: async () => {},
    onMessage: () => () => {},
    ready: Promise.resolve(),
    ...overrides,
  };
}

describe("createAgentSession", () => {
  // 正常创建
  test("根据已有 relayHandle 创建 AgentSession", () => {
    const handle = makeMockRelayHandle();
    let _stopped = false;
    const session = createAgentSession({
      relayHandle: handle,
      instanceId: "inst-test",
      workspacePath: "/ws/test",
      stopInstance: async () => {
        _stopped = true;
      },
    });
    expect(session.instanceId).toBe("inst-test");
    expect(session.workspacePath).toBe("/ws/test");
    expect(session.relayHandle).toBe(handle);
  });

  // dispose 清理
  test("dispose 关闭 relay handle 并 stop 实例", async () => {
    let closed = false;
    let stopped = false;
    const handle = makeMockRelayHandle({
      close: async () => {
        closed = true;
      },
    });
    const session = createAgentSession({
      relayHandle: handle,
      instanceId: "inst-test",
      stopInstance: async () => {
        stopped = true;
      },
    });
    await session.dispose();
    expect(closed).toBe(true);
    expect(stopped).toBe(true);
  });
});

describe("startPromptTurn", () => {
  // 正常 session/new + prompt
  test("创建 session 并返回 PromptTurn", async () => {
    let handler: (msg: any) => void = () => {};
    const handle = makeMockRelayHandle({
      send: (_msg: any) => {
        const method = (_msg as any)?.method;
        if (method === "session/new") {
          setTimeout(() => {
            handler({ jsonrpc: "2.0", id: -1, result: { sessionId: "ses_test123" } });
          }, 5);
        }
      },
      onMessage: (h: any) => {
        handler = h;
        return () => {};
      },
    });

    const session = createAgentSession({
      relayHandle: handle,
      instanceId: "inst-test",
      stopInstance: async () => {},
    });

    const { turn } = await startPromptTurn({ session });
    expect(turn).toBeDefined();
    expect(turn.events).toBeDefined();
    expect(turn.prompt).toBeDefined();
  });

  // session/load
  test("session/load 时传入 sessionId", async () => {
    let handler: (msg: any) => void = () => {};
    let receivedMethod = "";
    const handle = makeMockRelayHandle({
      send: (_msg: any) => {
        receivedMethod = (_msg as any)?.method;
        if (receivedMethod === "session/load") {
          setTimeout(() => {
            handler({ jsonrpc: "2.0", id: -1, result: { sessionId: "ses_existing" } });
          }, 5);
        }
      },
      onMessage: (h: any) => {
        handler = h;
        return () => {};
      },
    });

    const session = createAgentSession({
      relayHandle: handle,
      instanceId: "inst-test",
      stopInstance: async () => {},
    });

    await startPromptTurn({ session, sessionId: "ses_existing" });
    expect(receivedMethod).toBe("session/load");
  });
});
