import { expect, test } from "bun:test";
import {
  ConnectionRegistry,
  DocManager,
  Gateway,
  RelayEventHandler,
  SessionChannel,
  YjsBroadcaster,
} from "@fenix/chat-channel/server";
import { createInMemoryAgentRelay } from "./fixtures/in-memory-agent-relay";

/** 标准 ACP 仅以 prompt RPC result 结束回复，不依赖 Peri 扩展通知。 */
async function fixture() {
  const relay = await createInMemoryAgentRelay((message) => {
    const rpc = message as unknown as { id: number; method?: string; params?: { sessionId: string } };
    if (rpc.method === "session/load")
      queueMicrotask(() => relay.emit({ jsonrpc: "2.0", id: rpc.id, result: { sessionId: rpc.params?.sessionId } }));
  });
  const registry = new ConnectionRegistry();
  const docManager = new DocManager({ acpBatchWindowMs: 0 });
  const broadcaster = new YjsBroadcaster(registry);
  const errors: unknown[] = [];
  const reportError = (_message: string, error: unknown) => errors.push(error);
  const channel = new SessionChannel({
    docManager,
    reportError,
    replaceProjection() {},
    syncSessionId(connection, sessionId) {
      registry.forEachByRcsSession(connection.rcsSessionId, (entry) => {
        entry.acpSessionId = sessionId;
        entry.sessionLoaded = true;
      });
    },
  });
  const events = new RelayEventHandler({
    registry,
    broadcaster,
    docManager,
    reportError,
    registerYjsDocListener() {},
    touchInstanceActivity() {},
    invalidateRuntimeSession: (id) => channel.invalidateRuntimeSession(id),
  });
  const gateway = new Gateway({
    registry,
    docManager,
    broadcaster,
    relayEvents: events,
    sessionChannel: channel,
    getEnvironment: async () => ({ userId: "user" }),
    authorizeEnvironment: () => true,
    resolveWorkspacePath: () => "/workspace",
    ensureRunning: async () => "relay-boundary",
    connectAgentRelay: relay.connect,
    getRuntimeIdentity: () => "test:1",
    markRelayAttached() {},
    markRelayDetached() {},
    reportError,
    reportLog() {},
    maxClients: () => 5,
    isMachineOffline: () => false,
    classifyPermanentSpawnFailure: () => null,
  });
  const ws = { readyState: 1, send() {}, close() {} };
  const open = () =>
    gateway.handleOpen(ws, "page", "user", "agent", {
      instanceUid: "relay-boundary",
      rcsSessionId: "rcs-test",
      syncOnly: true,
    });
  const action = (action: string, extra = {}) =>
    gateway.handleMessage(
      ws,
      "page",
      JSON.stringify({
        action,
        commandId: `${channel.getCommandEpoch()}.${crypto.randomUUID()}`,
        sessionId: "ses-test",
        ...extra,
      }),
    );
  return {
    relay,
    events,
    registry,
    gateway,
    docManager,
    open,
    action,
    errors,
    status: () => docManager.getSessionYdoc("rcs-test")!.getMap("root").toJSON().session.activeTurnStatus,
    async dispose() {
      gateway.handleClose("page");
      await docManager.closeAll();
      await relay.core.stopInstance("relay-boundary");
    },
  };
}

// 回复在刷新间隙完成也必须被主服务接收，释放租约后再次进入仍可恢复完整终态。
test.each([true, false])("refresh keeps standard ACP completion when reconnected first: %s", async (reconnectFirst) => {
  const h = await fixture();
  try {
    await h.open();
    await h.action("load_session");
    await h.action("send_prompt", { content: [{ type: "text", text: "question" }] });
    const prompt = h.relay.sent.find(
      (message) => (message as unknown as { method?: string }).method === "session/prompt",
    ) as unknown as { id: number };
    const original = h.docManager.getChatYdoc("rcs-test");
    h.gateway.handleClose("page");
    expect(h.registry.getShared("relay-boundary", "user", "rcs-test")).toBeDefined();
    if (reconnectFirst) {
      await h.open();
      await h.action("load_session");
    }
    h.relay.emit({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await Bun.sleep(0);
    expect(h.status()).toBe("completed");
    if (reconnectFirst) h.gateway.handleClose("page");
    expect(h.registry.getShared("relay-boundary", "user", "rcs-test")).toBeUndefined();
    await h.open();
    await h.action("load_session");
    expect(h.docManager.getChatYdoc("rcs-test")).toBe(original);
    expect(h.status()).toBe("completed");
    expect(
      h.relay.sent.filter((message) => (message as unknown as { method?: string }).method === "session/load"),
    ).toHaveLength(1);
    expect(h.errors).toEqual([]);
  } finally {
    await h.dispose();
  }
});

// 持久缓存残留的 running 状态不代表当前 relay 真有任务，关闭页面必须正常释放。
test("stale projected running turn cannot retain an idle relay", async () => {
  const h = await fixture();
  try {
    await h.open();
    await h.action("load_session");
    await h.docManager.registerUserMessage("rcs-test", "stale cached question");
    h.gateway.handleClose("page");
    expect(h.registry.getShared("relay-boundary", "user", "rcs-test")).toBeUndefined();
  } finally {
    await h.dispose();
  }
});

// 即时 prompt ACK 和 steer 自动开启的新轮次都必须保留 relay，直到真正的终态到达。
test.each([false, true])("live turn remains owned after prompt receipt, steer: %s", async (steer) => {
  const h = await fixture();
  try {
    await h.open();
    await h.action("load_session");
    await h.action("send_prompt", { content: [{ type: "text", text: "question" }] });
    const prompt = h.relay.sent.find(
      (message) => (message as unknown as { method?: string }).method === "session/prompt",
    ) as unknown as { id: number };
    if (steer) {
      h.relay.emit({
        jsonrpc: "2.0",
        method: "peri/agent_event",
        params: {
          sessionId: "ses-test",
          event_json: JSON.stringify({
            type: "user_input_delivered",
            value: {
              generation: "generation-1",
              input_id: "input-1",
              content: "follow up",
            },
          }),
        },
      });
    }
    h.relay.emit({ jsonrpc: "2.0", id: prompt.id, result: steer ? { stopReason: "cancelled" } : {} });
    await Bun.sleep(0);
    const shared = h.registry.getShared("relay-boundary", "user", "rcs-test")!;
    expect(shared.pendingPromptIds?.size).toBe(0);
    expect(h.status()).not.toBe("completed");
    h.gateway.handleClose("page");
    expect(h.registry.getShared("relay-boundary", "user", "rcs-test")).toBe(shared);
    h.relay.emit({
      jsonrpc: "2.0",
      method: "peri/agent_event_done",
      params: { sessionId: "ses-test", stopReason: "end_turn" },
    });
    await Bun.sleep(0);
    expect(h.status()).toBe("completed");
    expect(h.registry.getShared("relay-boundary", "user", "rcs-test")).toBeUndefined();
  } finally {
    await h.dispose();
  }
});

// 无页面时子进程断开必须释放在途租约并废弃确认，重新进入要加载会话。
test("Agent disconnect between pages invalidates the retained runtime confirmation", async () => {
  const h = await fixture();
  try {
    await h.open();
    await h.action("load_session");
    h.gateway.handleClose("page");
    h.relay.emit({ type: "status", payload: { connected: false } });
    await h.open();
    await h.action("load_session");
    expect(
      h.relay.sent.filter((message) => (message as unknown as { method?: string }).method === "session/load"),
    ).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});

// 实例强制关闭必须释放无人观看的回复连接，不能只遍历页面客户端。
test.each(["instance", "shutdown"])("retained prompt lease is released during %s cleanup", async (cleanup) => {
  const h = await fixture();
  try {
    await h.open();
    await h.action("load_session");
    await h.action("send_prompt", { content: [{ type: "text", text: "question" }] });
    h.gateway.handleClose("page");
    if (cleanup === "instance") h.registry.closeClientsByInstance("relay-boundary");
    else h.registry.closeAll();
    expect(h.registry.getShared("relay-boundary", "user", "rcs-test")).toBeUndefined();
    expect(h.relay.listeners.size).toBe(1); // 仅运行实例拥有的连续性观察器仍在。
  } finally {
    await h.dispose();
  }
});

// 旧 relay 的迟到断连不能中断后继连接或删除其已确认的会话。
test.each(["status", "relay_closed"])("stale %s cannot invalidate the successor session", async (type) => {
  const h = await fixture();
  try {
    await h.open();
    await h.action("load_session");
    const current = h.registry.getShared("relay-boundary", "user", "rcs-test")!;
    const old = { ...current };
    await h.events.createMessageHandler(old)({ type, payload: { connected: false } });
    h.gateway.handleClose("page");
    await h.open();
    await h.action("load_session");
    expect(
      h.relay.sent.filter((message) => (message as unknown as { method?: string }).method === "session/load"),
    ).toHaveLength(1);
    expect(h.errors).toEqual([]);
  } finally {
    await h.dispose();
  }
});

// 重连切换投影后，收口观察器必须改绑到新 Doc，强制回收时不能留下无人租约。
test("retained relay follows projection replacement before realtime reclamation", async () => {
  const h = await fixture();
  try {
    await h.open();
    await h.action("load_session");
    await h.action("send_prompt", { content: [{ type: "text", text: "first" }] });
    h.gateway.handleClose("page");
    await h.open();
    await h.action("load_session", { sessionId: "ses-next" });
    await h.action("send_prompt", { sessionId: "ses-next", content: [{ type: "text", text: "second" }] });
    h.gateway.handleClose("page");
    expect(h.registry.getShared("relay-boundary", "user", "rcs-test")).toBeDefined();
    await h.docManager.closeAll();
    expect(h.registry.getShared("relay-boundary", "user", "rcs-test")).toBeUndefined();
  } finally {
    await h.dispose();
  }
});
