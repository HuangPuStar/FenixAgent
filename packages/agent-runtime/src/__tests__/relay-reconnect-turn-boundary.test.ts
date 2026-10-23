import { expect, test } from "bun:test";
import {
  ConnectionRegistry,
  DocManager,
  Gateway,
  getSessionInfo,
  RelayEventHandler,
  SessionChannel,
  type WsConnection,
  YjsBroadcaster,
} from "@fenix/chat-channel/server";
import { createInMemoryAgentRelay } from "./fixtures/in-memory-agent-relay";

// 回复中刷新保留旧请求归属，迟到的旧终态仍不能终结切换后的新会话。
test("reconnected Gateway survives a delayed previous lease result and accepts the real new answer", async () => {
  const relay = await createInMemoryAgentRelay((message) => {
    const rpc = message as unknown as { type?: string; id: number; method: string; params: { sessionId: string } };
    if (rpc.type === "connect")
      relay.emit({ type: "status", payload: { connected: true, capabilities: { loadSession: true } } });
    if (rpc.method === "session/load")
      queueMicrotask(() => relay.emit({ jsonrpc: "2.0", id: rpc.id, result: { sessionId: rpc.params.sessionId } }));
  });
  const registry = new ConnectionRegistry();
  const docManager = new DocManager();
  const broadcaster = new YjsBroadcaster(registry);
  const diagnostics: unknown[] = [];
  const reportError = (context: string, error: unknown) => {
    diagnostics.push({ context, error });
  };
  const relayEvents = new RelayEventHandler({
    registry,
    broadcaster,
    docManager,
    registerYjsDocListener() {},
    reportError,
    touchInstanceActivity() {},
  });
  const sessionChannel = new SessionChannel({ docManager, replaceProjection() {}, syncSessionId() {}, reportError });
  const gateway = new Gateway({
    registry,
    broadcaster,
    docManager,
    relayEvents,
    sessionChannel,
    getEnvironment: async () => ({ organizationId: "org", userId: "user" }),
    authorizeEnvironment: () => true,
    resolveWorkspacePath: () => "/workspace",
    ensureRunning: async () => "relay-boundary",
    connectAgentRelay: relay.connect,
    markRelayAttached() {},
    markRelayDetached() {},
    reportLog() {},
    reportError,
    maxClients: () => 5,
    isMachineOffline: () => false,
    classifyPermanentSpawnFailure: () => null,
  });
  const frames: Array<string | Uint8Array> = [];
  const ws: WsConnection = {
    readyState: 1,
    send(frame) {
      frames.push(frame);
    },
    close() {},
  };
  const open = (id: string) =>
    gateway.handleOpen(ws, id, "user", "agent", {
      instanceUid: "relay-boundary",
      rcsSessionId: "rcs-rpc",
      syncOnly: true,
    });
  const action = (id: string, commandId: string, sessionId: string, type: string) =>
    gateway.handleMessage(
      ws,
      id,
      JSON.stringify({
        action: type,
        commandId: `${sessionChannel.getCommandEpoch()}.${crypto.randomUUID()}`,
        sessionId,
        content: [{ type: "text", text: commandId }],
      }),
    );
  const prompts = () =>
    (relay.sent as unknown as Array<{ id: number; method: string }>).filter(
      (frame) => frame.method === "session/prompt",
    );
  try {
    await open("old");
    await action("old", "load-old", "ses-old", "load_session");
    await action("old", "prompt-old", "ses-old", "send_prompt");
    expect(prompts()).toHaveLength(1);
    const oldWireId = prompts()[0]!.id;
    const oldLocalId = [...registry.getShared("relay-boundary", "user", "rcs-rpc")!.pendingPromptIds!][0]!;
    gateway.handleClose("old");
    expect(registry.getShared("relay-boundary", "user", "rcs-rpc")!.pendingPromptIds?.has(oldLocalId)).toBe(true);
    expect(relay.physical.state).toBe("open");
    await open("new");
    await action("new", "load-new", "ses-new", "load_session");
    await action("new", "prompt-new", "ses-new", "send_prompt");
    expect(prompts()).toHaveLength(2);
    const shared = registry.getShared("relay-boundary", "user", "rcs-rpc")!;
    expect(shared.pendingPromptIds?.size).toBe(2);
    const newLocalId = [...shared.pendingPromptIds!].find((id) => id !== oldLocalId)!;
    const newWireId = prompts()[1]!.id;
    expect(newWireId).not.toBe(oldWireId);
    const session = getSessionInfo(docManager.getSessionYdoc("rcs-rpc")!);
    const turnId = session.get("activeTurnId");
    relay.emit({ jsonrpc: "2.0", id: oldWireId, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.get("activeTurnId")).toBe(turnId);
    expect(session.get("activeTurnStatus")).not.toBe("completed");
    expect(shared.pendingPromptIds).toEqual(new Set([newLocalId]));
    relay.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-new",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "real new answer" } },
      },
    });
    relay.emit({ jsonrpc: "2.0", id: newWireId, result: { stopReason: "end_turn" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.get("activeTurnStatus")).toBe("completed");
    expect(JSON.stringify(docManager.getChatYdoc("rcs-rpc")!.toJSON())).toContain("real new answer");
    expect(shared.pendingPromptIds?.size).toBe(0);
    expect(relay.connections()).toBe(1);
    expect(diagnostics).toEqual([]);
  } finally {
    gateway.handleClose("old");
    gateway.handleClose("new");
    await docManager.closeAll();
    await relay.core.stopInstance("relay-boundary");
  }
});
