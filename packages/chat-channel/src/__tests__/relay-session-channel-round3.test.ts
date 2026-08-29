// packages/chat-channel/src/__tests__/relay-session-channel-round3.test.ts
// Relay / SessionChannel 的内存边界测试：不启动 WebSocket、Redis 或 Agent 进程。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { YjsBroadcaster } from "../channel/broadcaster";
import { ConnectionRegistry } from "../channel/connection-registry";
import { createSharedRelay, createTestRpcReservationFactory } from "../channel/connection-test-helpers";
import {
  getRelayRpcState,
  type PendingRpc,
  type RelayMessage,
  reserveRelayRpc,
  type SharedRelay,
} from "../channel/connection-types";
import { RelayEventHandler } from "../channel/relay-event-handler";
import { SessionChannel, type SessionConnection } from "../channel/session-channel";
import type { ActionAck, ActionError } from "../channel/types";
import { getAgentStatus, getEntriesMap, getEntryOrder, getPeriTasksMap, getSessionInfo } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";

function message(value: Record<string, unknown>): RelayMessage {
  return value as unknown as RelayMessage;
}

function relay(rcsSessionId: string, sent: Record<string, unknown>[] = []): SharedRelay {
  return createSharedRelay({
    handle: {
      state: "open",
      send: (value) => {
        sent.push(value as unknown as Record<string, unknown>);
      },
      close() {},
    },
    rcsSessionId,
  });
}

function registerOwnedRpc(
  shared: SharedRelay,
  owner: { kind: "prompt" | "cancel"; turnId: string | null },
): PendingRpc {
  return reserveRelayRpc(shared, owner);
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

function entryText(ydoc: Y.Doc, entryId: string): string {
  const entry = getEntriesMap(ydoc).get(entryId);
  const blocks = entry?.get("blocks") as Y.Map<Y.Map<unknown>> | undefined;
  return (blocks?.get("text")?.get("text") as Y.Text | undefined)?.toString() ?? "";
}

function assistantText(ydoc: Y.Doc, turnId: string): string {
  return entryText(ydoc, `${turnId}:assistant`);
}

function callbackUserEntryIds(ydoc: Y.Doc): string[] {
  return getEntryOrder(ydoc)
    .toArray()
    .filter((entryId) => entryId.startsWith("callback_") && !entryId.endsWith(":assistant"));
}

type RelayConsumer = ReturnType<RelayEventHandler["createMessageHandler"]>;

async function projectCallback(consume: RelayConsumer, userText: string, assistantTextValue?: string): Promise<void> {
  await consume(
    message({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: userText } },
      },
    }),
  );
  if (assistantTextValue === undefined) return;
  await consume(
    message({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: assistantTextValue } },
      },
    }),
  );
  await Bun.sleep(5);
}

function connection(overrides: Partial<SessionConnection> = {}): {
  value: SessionConnection;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  const reserveRpc = createTestRpcReservationFactory();
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
      sendToRelay: (value) => {
        sent.push(value);
      },
      reserveRpc,
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

  // 当前 prompt 的 SDK user 回显被临时投影为 callback 时，匹配该 prompt 的终态必须同时收敛并释放 callback；
  // 下一轮无 turnId assistant 增量应回到当前活动 turn，不能继续写入上一条 callback assistant。
  test("releases the prompt-owned callback before routing the next turn delta", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");
    const consume = handler.createMessageHandler(shared);
    const firstTurnId = manager.registerUserMessage("rcs-1", "first question");
    const prompt = registerOwnedRpc(shared, { kind: "prompt", turnId: firstTurnId });

    await projectCallback(consume, "first question", "first answer");

    const chat = manager.getChatYdoc("rcs-1")!;
    const [callbackEntryId] = callbackUserEntryIds(chat);
    expect(callbackEntryId).toBeDefined();

    await consume(message({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } }));
    expect(getEntriesMap(chat).get(`${callbackEntryId}:assistant`)?.get("status")).toBe("completed");
    expect(shared.callbackAssistant).toBeNull();

    const secondTurnId = manager.registerUserMessage("rcs-1", "second question");
    await consume(
      message({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second answer" } },
        },
      }),
    );
    await Bun.sleep(5);

    expect(entryText(chat, `${callbackEntryId}:assistant`)).toBe("first answer");
    expect(assistantText(chat, secondTurnId)).toBe("second answer");
    expect(getEntryOrder(chat).toArray().indexOf(`${secondTurnId}:assistant`)).toBeGreaterThan(
      getEntryOrder(chat).toArray().indexOf(`${secondTurnId}:user`),
    );
  });

  // 旧 prompt 的迟到终态只可收敛归属于旧 turn 的 callback；新 turn 已创建的 callback 必须保持可写。
  test("does not release a newer callback when an old prompt terminal arrives late", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");
    const consume = handler.createMessageHandler(shared);
    const firstTurnId = manager.registerUserMessage("rcs-1", "first question");

    await projectCallback(consume, "first callback");
    manager.registerUserMessage("rcs-1", "second question");
    await projectCallback(consume, "second callback");

    const chat = manager.getChatYdoc("rcs-1")!;
    const callbackIds = callbackUserEntryIds(chat);
    const newerCallbackEntryId = callbackIds.at(-1);
    expect(callbackIds).toHaveLength(2);
    expect(newerCallbackEntryId).toBeDefined();

    const prompt = registerOwnedRpc(shared, { kind: "prompt", turnId: firstTurnId });
    await consume(message({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } }));
    await consume(
      message({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new callback answer" } },
        },
      }),
    );
    await Bun.sleep(5);

    expect(entryText(chat, `${newerCallbackEntryId}:assistant`)).toBe("new callback answer");
    expect(getEntriesMap(chat).get(`${newerCallbackEntryId}:assistant`)?.get("status")).toBe("streaming");
  });

  // JSON-RPC prompt error 通过 rpcId 恢复 turn 归属后，必须同时收敛该 turn 的 callback assistant。
  test("prompt error finalizes only its owned callback", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");
    const consume = handler.createMessageHandler(shared);
    const turnId = manager.registerUserMessage("rcs-1", "question");
    const prompt = registerOwnedRpc(shared, { kind: "prompt", turnId });

    await projectCallback(consume, "callback", "partial");
    const chat = manager.getChatYdoc("rcs-1")!;
    const callbackEntryId = callbackUserEntryIds(chat)[0]!;

    await consume(message({ jsonrpc: "2.0", id: prompt.id, error: { code: -32000, message: "private" } }));

    expect(getEntriesMap(chat).get(`${callbackEntryId}:assistant`)?.get("status")).toBe("error");
    expect(shared.callbackAssistant).toBeNull();
  });

  // prompt 静默超时携带登记的 turn 归属时，也必须收敛对应 callback，不能永久停留 streaming。
  test("prompt timeout finalizes only its owned callback", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");
    const consume = handler.createMessageHandler(shared);
    const turnId = manager.registerUserMessage("rcs-1", "question");
    const prompt = registerOwnedRpc(shared, { kind: "prompt", turnId });

    await projectCallback(consume, "callback", "partial");
    const chat = manager.getChatYdoc("rcs-1")!;
    const callbackEntryId = callbackUserEntryIds(chat)[0]!;

    handler.convergeStuckPrompt(shared, prompt);

    expect(getEntriesMap(chat).get(`${callbackEntryId}:assistant`)?.get("status")).toBe("error");
    expect(shared.callbackAssistant).toBeNull();
  });

  // cancel ACK 必须按请求发出时登记的 turnId 收敛主消息及其 callback。
  test("cancel confirmation finalizes only its owned turn and callback", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");
    const consume = handler.createMessageHandler(shared);
    const turnId = manager.registerUserMessage("rcs-1", "question");
    const cancel = registerOwnedRpc(shared, { kind: "cancel", turnId });

    await projectCallback(consume, "callback", "partial");
    const chat = manager.getChatYdoc("rcs-1")!;
    const callbackEntryId = callbackUserEntryIds(chat)[0]!;

    await consume(message({ jsonrpc: "2.0", id: cancel.id, result: { cancelled: true } }));

    expect(getSessionInfo(manager.getSessionYdoc("rcs-1")!).get("activeTurnStatus")).toBe("cancelled");
    expect(getEntriesMap(chat).get(`${callbackEntryId}:assistant`)?.get("status")).toBe("cancelled");
    expect(shared.callbackAssistant).toBeNull();
    expect(getRelayRpcState(shared).pendingRpcRequests.size).toBe(0);
  });

  // 未登记的 cancel ACK 没有可信 turn 所有权，必须完全忽略，不能回退到响应到达时的活动 turn。
  test("unregistered cancel confirmation does not mutate the active turn or callback", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");
    const consume = handler.createMessageHandler(shared);
    const turnId = manager.registerUserMessage("rcs-1", "question");

    await projectCallback(consume, "callback", "partial");
    const chat = manager.getChatYdoc("rcs-1")!;
    const callbackEntryId = callbackUserEntryIds(chat)[0]!;

    await consume(message({ jsonrpc: "2.0", id: 99, result: { cancelled: true } }));

    const sessionInfo = getSessionInfo(manager.getSessionYdoc("rcs-1")!);
    expect(sessionInfo.get("activeTurnId")).toBe(turnId);
    expect(sessionInfo.get("activeTurnStatus")).toBe("accepting");
    expect(getEntriesMap(chat).get(`${callbackEntryId}:assistant`)?.get("status")).toBe("streaming");
    expect(shared.callbackAssistant?.entryId).toBe(callbackEntryId);
  });

  // 旧 turn 的 cancel ACK 迟到时只能尝试收敛旧 turn；新 turn 与新 callback 必须保持可写。
  test("late cancel confirmation does not mutate a newer turn or callback", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");
    const consume = handler.createMessageHandler(shared);
    const firstTurnId = manager.registerUserMessage("rcs-1", "first question");
    const secondTurnId = manager.registerUserMessage("rcs-1", "second question");
    const cancel = registerOwnedRpc(shared, { kind: "cancel", turnId: firstTurnId });

    await projectCallback(consume, "second callback", "partial");
    const chat = manager.getChatYdoc("rcs-1")!;
    const callbackEntryId = callbackUserEntryIds(chat)[0]!;

    await consume(message({ jsonrpc: "2.0", id: cancel.id, result: { cancelled: true } }));

    const sessionInfo = getSessionInfo(manager.getSessionYdoc("rcs-1")!);
    expect(sessionInfo.get("activeTurnId")).toBe(secondTurnId);
    expect(sessionInfo.get("activeTurnStatus")).toBe("accepting");
    expect(getEntriesMap(chat).get(`${callbackEntryId}:assistant`)?.get("status")).toBe("streaming");
    expect(shared.callbackAssistant?.entryId).toBe(callbackEntryId);
    expect(getRelayRpcState(shared).pendingRpcRequests.size).toBe(0);
  });

  // cancelled:false 仅表示 Agent 未接受取消；必须消费请求登记但不能制造任何 turn 终态。
  test("failed cancel acknowledgement consumes ownership without terminalizing the turn", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");
    const consume = handler.createMessageHandler(shared);
    const turnId = manager.registerUserMessage("rcs-1", "question");
    const cancel = registerOwnedRpc(shared, { kind: "cancel", turnId });

    await consume(message({ jsonrpc: "2.0", id: cancel.id, result: { cancelled: false } }));

    const sessionInfo = getSessionInfo(manager.getSessionYdoc("rcs-1")!);
    expect(sessionInfo.get("activeTurnId")).toBe(turnId);
    expect(sessionInfo.get("activeTurnStatus")).toBe("accepting");
    expect(getRelayRpcState(shared).pendingRpcRequests.size).toBe(0);
  });

  // 未登记的 prompt result 同样没有可信 turn 所有权，不能按当前 active turn 猜测归属。
  test("unregistered prompt result does not terminalize the active turn", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");
    const consume = handler.createMessageHandler(shared);
    const turnId = manager.registerUserMessage("rcs-1", "question");

    await consume(message({ jsonrpc: "2.0", id: 99, result: { stopReason: "end_turn" } }));

    const sessionInfo = getSessionInfo(manager.getSessionYdoc("rcs-1")!);
    expect(sessionInfo.get("activeTurnId")).toBe(turnId);
    expect(sessionInfo.get("activeTurnStatus")).toBe("accepting");
  });

  // Agent 断连是全局中断信号，必须同时终结活动 turn 与当前 callback，不能留下 streaming 孤儿。
  test("agent disconnect interrupts the active turn and finalizes its callback", async () => {
    const { manager, handler } = await setupRelay();
    const shared = relay("rcs-1");
    const consume = handler.createMessageHandler(shared);
    manager.registerUserMessage("rcs-1", "question");

    await projectCallback(consume, "callback", "partial");
    const chat = manager.getChatYdoc("rcs-1")!;
    const callbackEntryId = callbackUserEntryIds(chat)[0]!;

    await consume(message({ type: "status", payload: { connected: false } }));

    expect(getSessionInfo(manager.getSessionYdoc("rcs-1")!).get("activeTurnStatus")).toBe("interrupted");
    expect(getEntriesMap(chat).get(`${callbackEntryId}:assistant`)?.get("status")).toBe("cancelled");
    expect(shared.callbackAssistant).toBeNull();
  });

  // Peri registry 的真实 unstable_event 信封必须穿过 relay并写入 Session Doc，且不依赖活动 turn。
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
