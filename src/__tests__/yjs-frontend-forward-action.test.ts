import { describe, expect, test } from "bun:test";
import { DocManager } from "@fenix/acp-server";
import { flushPendingYjsActions, forwardYjsAction } from "../transport/relay/yjs-frontend";
import {
  SessionTransition,
  type SessionTransitionDependencies,
  type SessionTransitionEntry,
} from "../transport/relay/yjs-frontend/session-transition";

let testRpcId = 0;

function createEntry(): SessionTransitionEntry {
  return {
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    acpSessionId: "session-1",
    agentStatusReceived: true,
    lastClientKeepalive: Date.now(),
    sessionLoaded: false,
  };
}

function createTransition(events: string[], overrides: Partial<SessionTransitionDependencies> = {}): SessionTransition {
  const dependencies: SessionTransitionDependencies = {
    docManager: {
      openSession: async () => undefined,
      clearSessionDocContent: () => {},
      hasSessionDocContent: () => false,
      processACP: (_rcsSessionId: string, event: any) => {
        events.push(event.type);
      },
    } as unknown as DocManager,
    prepareClearSessionSnapshot: async () => {},
    syncSessionId: () => {},
    reportError: () => {},
    ...overrides,
  };

  return new SessionTransition(dependencies);
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void } {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("forwardYjsAction", () => {
  // cancel 必须等待异步 relay send 成功后才清除 loading。
  test("waits for relay send before clearing loading", async () => {
    const events: string[] = [];
    const sendResult = deferred();
    const forwarded = forwardYjsAction(
      createEntry(),
      { action: "cancel" },
      {
        workspacePath: null,
        send: () => sendResult.promise,
        transition: createTransition(events),
        sendError: () => {},
        getNextRpcId: () => ++testRpcId,
        reportError: () => {},
      },
    );

    await Promise.resolve();
    expect(events).not.toContain("agent_message_complete");

    sendResult.resolve();
    await forwarded;

    expect(events).toEqual(["agent_message_complete"]);
  });

  // 异步 relay send 拒绝时不能清除 loading，且前端必须收到既有连接错误帧。
  test("keeps loading and sends an error when relay send rejects", async () => {
    const events: string[] = [];
    const sendResult = deferred();
    const errors: unknown[] = [];
    const forwarded = forwardYjsAction(
      createEntry(),
      { action: "cancel" },
      {
        workspacePath: null,
        send: () => sendResult.promise,
        transition: createTransition(events),
        sendError: (error) => errors.push(error),
        getNextRpcId: () => ++testRpcId,
        reportError: () => {},
      },
    );

    sendResult.reject(new Error("relay unavailable"));
    await forwarded;

    expect(events).not.toContain("agent_message_complete");
    expect(errors).toEqual([{ type: "error", payload: { message: "Agent connection error" } }]);
  });

  // load_session 的克隆快照准备失败必须在转发边界受控处理，保留旧 session 并不发送 relay RPC。
  test("handles load snapshot preparation failures before relay forwarding", async () => {
    const errors: unknown[] = [];
    const logs: Array<{ message: string; error: unknown }> = [];
    let sendCalls = 0;
    let clearCalls = 0;
    const connection = createEntry();
    const transition = createTransition([], {
      docManager: {
        openSession: async () => undefined,
        clearSessionDocContent: () => {
          clearCalls += 1;
        },
        hasSessionDocContent: () => false,
        processACP: () => {},
      } as unknown as DocManager,
      prepareClearSessionSnapshot: async () => {
        throw new Error("Redis unavailable");
      },
    });

    await forwardYjsAction(
      connection,
      { action: "load_session", sessionId: "session-2" },
      {
        workspacePath: null,
        send: () => {
          sendCalls += 1;
        },
        transition,
        sendError: (error) => errors.push(error),
        getNextRpcId: () => ++testRpcId,
        reportError: (message, error) => logs.push({ message, error }),
      },
    );

    expect(connection.acpSessionId).toBe("session-1");
    expect(clearCalls).toBe(0);
    expect(sendCalls).toBe(0);
    expect(errors).toEqual([{ type: "error", payload: { message: "Agent connection error" } }]);
    expect(logs).toHaveLength(1);
  });

  // 同步 relay send 也应在完成后才清除 loading。
  test("clears loading after a synchronous relay send", async () => {
    const events: string[] = [];

    await forwardYjsAction(
      createEntry(),
      { action: "cancel" },
      {
        workspacePath: null,
        send: () => {},
        transition: createTransition(events),
        sendError: () => {},
        getNextRpcId: () => ++testRpcId,
        reportError: () => {},
      },
    );

    expect(events).toEqual(["agent_message_complete"]);
  });

  // setup 缓冲 action 必须复用 forwardYjsAction：准备失败发错误帧、跳过 relay，并继续后续 action。
  test("flushes buffered actions through forward semantics", async () => {
    const errors: unknown[] = [];
    const logs: Array<{ message: string; error: unknown }> = [];
    const sent: Array<Record<string, unknown>> = [];
    const transition = {
      beforeForward: async (_entry: SessionTransitionEntry, action: Record<string, unknown>) => {
        if (action.action === "load_session") throw new Error("Redis unavailable");
        return true;
      },
      afterForward: () => {},
    };

    await flushPendingYjsActions(
      createEntry(),
      [
        "{invalid",
        JSON.stringify({ action: "list_sessions" }),
        JSON.stringify({ action: "load_session", sessionId: "session-2" }),
        JSON.stringify({ action: "cancel" }),
      ],
      {
        workspacePath: "/workspace",
        send: (message) => {
          sent.push(message);
        },
        transition,
        sendError: (error) => {
          errors.push(error);
        },
        getNextRpcId: () => ++testRpcId,
        reportError: (message, error) => {
          logs.push({ message, error });
        },
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "session/cancel" });
    expect(errors).toEqual([{ type: "error", payload: { message: "Agent connection error" } }]);
    expect(logs).toHaveLength(2);
  });
});
