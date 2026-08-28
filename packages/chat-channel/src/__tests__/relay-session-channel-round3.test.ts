// packages/chat-channel/src/__tests__/relay-session-channel-round3.test.ts
// Relay / SessionChannel 的内存边界测试：不启动 WebSocket、Redis 或 Agent 进程。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { YjsBroadcaster } from "../channel/broadcaster";
import { ConnectionRegistry } from "../channel/connection-registry";
import { type RelayMessage, type SharedRelay } from "../channel/connection-types";
import { RelayEventHandler } from "../channel/relay-event-handler";
import { SessionChannel, type SessionConnection } from "../channel/session-channel";
import type { ActionAck, ActionError } from "../channel/types";
import { getAgentStatus, getEntriesMap, getPeriTasksMap, getSessionInfo } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";

function message(value: Record<string, unknown>): RelayMessage {
  return value as unknown as RelayMessage;
}

function relay(rcsSessionId: string, sent: Record<string, unknown>[] = []): SharedRelay {
  return {
    handle: {
      state: "open",
      send: (value: Record<string, unknown>) => {
        sent.push(value);
      },
      close() {},
    },
    unsubscribe: null,
    refCount: 1,
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId,
    workspacePath: "/workspace",
    nextRpcId: 0,
    replayWindowUntil: null,
  };
}

async function setupRelay(rcsSessionId = "rcs-1"): Promise<{
  manager: DocManager;
  registry: ConnectionRegistry;
  handler: RelayEventHandler;
  sent: Record<string, unknown>[];
}> {
  const manager = new DocManager({ acpBatchWindowMs: 0 });
  await manager.openChat(rcsSessionId);
  await manager.openSession("user-1", "agent-1", rcsSessionId);
  const registry = new ConnectionRegistry();
  const sent: Record<string, unknown>[] = [];
  const handler = new RelayEventHandler({
    docManager: manager,
    registry,
    broadcaster: new YjsBroadcaster(registry),
    registerYjsDocListener() {},
    reportError() {},
    touchInstanceActivity() {},
    terminateLocalDeadInstance() {},
  });
  return { manager, registry, handler, sent };
}

function assistantText(ydoc: Y.Doc, turnId: string): string {
  const entry = getEntriesMap(ydoc).get(`${turnId}:assistant`);
  const blocks = entry?.get("blocks") as Y.Map<Y.Map<unknown>> | undefined;
  return (blocks?.get("text")?.get("text") as Y.Text | undefined)?.toString() ?? "";
}

function connection(overrides: Partial<SessionConnection> = {}): {
  value: SessionConnection;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  let rpcId = 0;
  return {
    value: {
      userId: "user-1",
      agentId: "agent-1",
      instanceId: "instance-1",
      rcsSessionId: "rcs-1",
      acpSessionId: "ses-1",
      agentStatusReceived: true,
      sessionLoaded: false,
      workspacePath: "/workspace",
      sendToRelay: (value) => sent.push(value),
      getNextRpcId: () => ++rpcId,
      ...overrides,
    },
    sent,
  };
}

function sinks(acks: ActionAck[], errors: ActionError[]) {
  return { sendAck: (ack: ActionAck) => acks.push(ack), sendError: (error: ActionError) => errors.push(error) };
}

describe("relay 与会话频道的内存边界", () => {
  // 原始 JSON-RPC session/update 文本必须写入当前 RCS 的活动 turn，而非 ACP session 标识对应的任意 Doc。
  test("projects raw session/update text only into its bound RCS document", async () => {
    const { manager, registry, handler, sent } = await setupRelay();
    manager.registerUserMessage("rcs-1", "question");
    registry.addClient("client-1", {
      ws: { readyState: 1, send() {}, close() {} },
      userId: "user-1",
      agentId: "agent-1",
      relayHandle: relay("rcs-1").handle,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-1",
      acpSessionId: "ses-1",
      workspacePath: "/workspace",
      openTime: 0,
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: false,
      sessionLoaded: false,
    });
    const shared = relay("rcs-1", sent);

    await handler.createMessageHandler(shared)(
      message({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "raw" } },
        },
      }),
    );
    await Bun.sleep(5);

    const turnId = getSessionInfo(manager.getSessionYdoc("rcs-1")!).get("activeTurnId") as string;
    expect(assistantText(manager.getChatYdoc("rcs-1")!, turnId)).toBe("raw");
    expect(sent).toEqual([]);
  });

  // Peri registry 的真实 unstable_event 信封必须穿过 relay 并写入 Session Doc，且不依赖活动 turn。
  test("projects Peri background registry events into the bound Session document", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");

    await handler.createMessageHandler(shared)(
      message({
        jsonrpc: "2.0",
        method: "peri/unstable_event",
        params: {
          sessionId: "ses-1",
          event: "bg-task-started",
          data: {
            task_id: "shell-1",
            kind: "shell",
            summary: "run tests",
            started_at: "2026-08-28T12:00:00+00:00",
          },
        },
      }),
    );

    const tasks = getPeriTasksMap(manager.getSessionYdoc("rcs-1")!);
    expect(tasks.get("shell-1")?.get("status")).toBe("running");
    expect(tasks.get("shell-1")?.get("taskSubtype")).toBe("shell");
    expect(tasks.get("shell-1")?.get("title")).toBe("run tests");
  });

  // 包裹 JSON-RPC 帧与原始帧必须共享同一翻译路径；状态就绪只向该 RCS 自动请求一次列表。
  test("accepts wrapped update frames and isolates ready status side effects", async () => {
    const { manager, registry, handler, sent } = await setupRelay();
    await manager.openChat("rcs-2");
    await manager.openSession("user-1", "agent-1", "rcs-2");
    manager.registerUserMessage("rcs-1", "question");
    registry.addClient("client-1", {
      ws: { readyState: 1, send() {}, close() {} },
      userId: "user-1",
      agentId: "agent-1",
      relayHandle: relay("rcs-1").handle,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-1",
      acpSessionId: "ses-1",
      workspacePath: "/workspace",
      openTime: 0,
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: false,
      sessionLoaded: false,
    });
    const shared = relay("rcs-1", sent);

    await handler.createMessageHandler(shared)(
      message({
        type: "session_data",
        payload: {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "ses-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrapped" } },
          },
        },
      }),
    );
    await handler.createMessageHandler(shared)(
      message({ type: "status", payload: { connected: true, capabilities: { loadSession: true } } }),
    );
    await handler.createMessageHandler(shared)(
      message({ type: "status", payload: { connected: true, capabilities: { loadSession: true } } }),
    );
    await Bun.sleep(5);

    const turnId = getSessionInfo(manager.getSessionYdoc("rcs-1")!).get("activeTurnId") as string;
    expect(assistantText(manager.getChatYdoc("rcs-1")!, turnId)).toBe("wrapped");
    expect(getEntriesMap(manager.getChatYdoc("rcs-2")!).size).toBe(0);
    expect(getAgentStatus(manager.getSessionYdoc("rcs-1")!).get("status")).toBe("ready");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("session/list");
  });

  // 无效 sessionUpdate 与无 id 的 result 不得生成投影；保活帧不改变业务入站时间，但未知事件仍会留下活跃信号。
  test("ignores unknown events and idless results without treating keepalive as activity", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");
    shared.lastInboundAt = 42;
    const consume = handler.createMessageHandler(shared);

    await consume(message({ type: "ping" }));
    expect(shared.lastInboundAt).toBe(42);
    await consume(message({ jsonrpc: "2.0", result: { stopReason: "end_turn" } }));
    await consume(
      message({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "not_supported" } } }),
    );

    expect(shared.lastInboundAt).toBeGreaterThan(42);
    expect(getEntriesMap(manager.getChatYdoc("rcs-1")!).size).toBe(0);
  });

  // relay_closed 必须关闭当前客户端并销毁旧 RCS Doc；后继实例接管后则保留其新投影。
  test("cleans closed relay resources but preserves a session taken over during reconnect", async () => {
    const { manager, registry, handler } = await setupRelay();
    const closed: Array<[number | undefined, string | undefined]> = [];
    registry.addClient("client-1", {
      ws: { readyState: 1, send() {}, close: (code, reason) => closed.push([code, reason]) },
      userId: "user-1",
      agentId: "agent-1",
      relayHandle: relay("rcs-1").handle,
      keepalive: 0 as unknown as ReturnType<typeof setInterval>,
      instanceId: "instance-1",
      rcsSessionId: "rcs-1",
      acpSessionId: null,
      workspacePath: "/workspace",
      openTime: 0,
      pendingMessages: [],
      relayReady: true,
      agentStatusReceived: false,
      sessionLoaded: false,
    });
    handler.bindInstanceSession("instance-1", "rcs-1");
    await handler.createMessageHandler(relay("rcs-1"))(message({ type: "relay_closed" }));
    expect(closed).toEqual([[1011, "relay handle closed"]]);
    expect(manager.getChatYdoc("rcs-1")).toBeUndefined();

    await manager.openChat("rcs-1");
    await manager.openSession("user-1", "agent-1", "rcs-1");
    handler.bindInstanceSession("instance-1", "rcs-1");
    handler.bindInstanceSession("instance-2", "rcs-1");
    await handler.createMessageHandler(relay("rcs-1"))(message({ type: "relay_closed" }));
    expect(manager.getChatYdoc("rcs-1")).toBeDefined();
  });

  // dispose 仅释放频道去重和连接绑定；同一内存投影可被新连接重新绑定并继续转发。
  test("rebinds channel actions after disposal without reusing stale dedup state", async () => {
    const manager = new DocManager();
    await manager.openChat("rcs-1");
    await manager.openSession("user-1", "agent-1", "rcs-1");
    const channel = new SessionChannel({
      docManager: manager,
      replaceProjection() {},
      syncSessionId() {},
      reportError() {},
    });
    const first = connection();
    const acks: ActionAck[] = [];
    const errors: ActionError[] = [];
    await channel.handleAction(
      first.value,
      { action: "list_sessions", commandId: "before-close" },
      sinks(acks, errors),
    );
    channel.disposeRcsSession("rcs-1");
    await channel.handleAction(first.value, { action: "list_sessions", commandId: "after-close" }, sinks(acks, errors));
    const reconnect = connection({ agentStatusReceived: true });
    await channel.handleAction(
      reconnect.value,
      { action: "list_sessions", commandId: "after-reconnect" },
      sinks(acks, errors),
    );

    expect(first.sent).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(reconnect.sent).toHaveLength(1);
    expect(reconnect.sent[0]?.method).toBe("session/list");
  });
});
