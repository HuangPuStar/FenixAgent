import { expect, test } from "bun:test";
import {
  ConnectionRegistry,
  DocManager,
  Gateway,
  RelayEventHandler,
  SessionChannel,
  type WsConnection,
  YjsBroadcaster,
} from "@fenix/chat-channel/server";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import { createInMemoryAgentRelay } from "./fixtures/in-memory-agent-relay";

// 真实 Gateway 归零重连仅恢复服务端绑定，不依赖 load、prompt 或队列快照也必须继续接收输出与权限请求。
test("Gateway reconnect restores its trusted relay session without targeted RPCs or snapshot capabilities", async () => {
  const relay = await createInMemoryAgentRelay((message) => {
    const rpc = message as unknown as { type?: string; id: number; method: string; params: { sessionId: string } };
    if (rpc.type === "connect") relay.emit({ type: "status", payload: { connected: true, capabilities: {} } });
    if (rpc.method === "session/load")
      queueMicrotask(() => relay.emit({ jsonrpc: "2.0", id: rpc.id, result: { sessionId: rpc.params.sessionId } }));
    if (rpc.method === "session/new")
      queueMicrotask(() => relay.emit({ jsonrpc: "2.0", id: rpc.id, result: { sessionId: "ses-created" } }));
  });
  const registry = new ConnectionRegistry();
  const docManager = new DocManager();
  const broadcaster = new YjsBroadcaster(registry);
  const inbound: Record<string, unknown>[] = [];
  const diagnostics: unknown[] = [];
  const reportError = (message: string, error: unknown) => diagnostics.push({ message, error });
  const relayEvents = new RelayEventHandler({
    registry,
    broadcaster,
    docManager,
    registerYjsDocListener() {},
    reportError,
    touchInstanceActivity(_instanceId, raw) {
      inbound.push(raw);
    },
  });
  const gateway = new Gateway({
    registry,
    broadcaster,
    docManager,
    relayEvents,
    sessionChannel: new SessionChannel({ docManager, replaceProjection() {}, syncSessionId() {}, reportError }),
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
  const ws: WsConnection = { readyState: 1, send() {}, close() {} };
  const open = (id: string) =>
    gateway.handleOpen(ws, id, "user", "agent", {
      instanceUid: "relay-boundary",
      rcsSessionId: "rcs-restored",
      acpSessionId: "ses-untrusted-locator",
      syncOnly: true,
    });
  const permission = (sessionId: string, id: string) => ({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: { sessionId, options: [] },
  });
  const update = (sessionId: string, text: string) => ({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
  try {
    await open("old");
    await gateway.handleMessage(
      ws,
      "old",
      JSON.stringify({ action: "load_session", commandId: "load", sessionId: "ses-bound" }),
    );
    await gateway.handleMessage(
      ws,
      "old",
      JSON.stringify({
        action: "send_prompt",
        commandId: "prompt",
        sessionId: "ses-bound",
        content: [{ type: "text", text: "question" }],
      }),
    );
    expect(
      (relay.sent as unknown as Array<{ method?: string }>).filter((frame) => frame.method === "session/prompt"),
    ).toHaveLength(1);
    gateway.handleClose("old");
    expect(relay.listeners.size).toBe(0);
    const beforeReconnect = relay.sent.length;
    await open("new");
    await open("second-tab");
    expect(registry.getClient("new")!.acpSessionId).toBe("ses-bound");
    const reconnectFrames = relay.sent.slice(beforeReconnect) as unknown as Array<{
      method?: string;
      params?: { sessionId?: string };
    }>;
    expect(reconnectFrames.every((frame) => !frame.params?.sessionId)).toBe(true);
    expect(reconnectFrames.some((frame) => frame.method === "session/input/snapshot")).toBe(false);
    inbound.length = 0;
    const chunk = update("ses-bound", "continued after reconnect");
    const request = permission("ses-bound", "permission-original");
    relay.emit(chunk);
    relay.emit({ type: "jsonrpc", payload: request });
    relay.emit(update("ses-other", "foreign output"));
    relay.emit(permission("ses-other", "foreign-permission"));
    relay.emit(update("ses-untrusted-locator", "untrusted locator output"));
    expect(inbound).toEqual([chunk, { type: "jsonrpc", payload: request }]);
    const answer = { jsonrpc: "2.0", id: "permission-original", result: { outcome: { outcome: "cancelled" } } };
    registry.getClient("new")!.relayHandle.send(answer as unknown as EngineRelayMessage);
    expect(relay.sent.at(-1)).toEqual(answer as unknown as EngineRelayMessage);
    gateway.handleClose("new");
    expect(relay.listeners.size).toBe(1);
    const secondChunk = update("ses-bound", " survives one tab closing");
    relay.emit(secondChunk);
    expect(inbound.at(-1)).toEqual(secondChunk);
    // 控制事件刷新微批次后验证真实投影，避免以回调数量代替用户可见输出。
    docManager.processNormalizedEvent("rcs-restored", { type: "plan", update: { entries: [] }, content: null });
    const projected = JSON.stringify(docManager.getChatYdoc("rcs-restored")!.toJSON());
    expect(projected).toContain("continued after reconnect survives one tab closing");
    expect(projected).not.toContain("foreign output");
    // 随后的真实 load/new 确认必须替换共享绑定，历史推断目标的 chunk 与 permission 均不可再入站。
    for (const [action, sessionId, previous] of [
      ["load_session", "ses-next", "ses-bound"],
      ["create_session", "ses-created", "ses-next"],
    ]) {
      await gateway.handleMessage(ws, "second-tab", JSON.stringify({ action, commandId: action, sessionId }));
      expect(registry.getClient("second-tab")!.acpSessionId).toBe(sessionId);
      inbound.length = 0;
      relay.emit(update(previous!, "retired session output"));
      relay.emit(permission(previous!, "retired permission"));
      expect(inbound).toEqual([]);
      const currentPermission = permission(sessionId!, "permission-current");
      relay.emit(currentPermission);
      expect(inbound).toEqual([currentPermission]);
    }
    expect(relay.connections()).toBe(1);
    expect(diagnostics).toEqual([]);
  } finally {
    gateway.handleClose("old");
    gateway.handleClose("new");
    gateway.handleClose("second-tab");
    await docManager.closeAll();
    await relay.core.stopInstance("relay-boundary");
  }
});
