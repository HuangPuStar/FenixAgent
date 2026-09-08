import { describe, expect, test } from "bun:test";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { YjsBroadcaster } from "../channel/broadcaster";
import { ConnectionRegistry } from "../channel/connection-registry";
import type { WsConnection } from "../channel/connection-types";
import { Gateway, type GatewayDependencies } from "../channel/gateway";
import type { RelayEventHandler } from "../channel/relay-event-handler";
import type { SessionChannel, SessionConnection } from "../channel/session-channel";
import type { ActionAck, ActionError } from "../channel/types";
import { encodeYjsStateVectorFrame } from "../protocol/update-frame";
import { DocManager } from "../state/doc-manager";

class FakeWebSocket implements WsConnection {
  readonly sent: Array<string | Uint8Array> = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  readyState = 1;
  onSend: ((data: string | Uint8Array) => void) | undefined;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    this.onSend?.(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
}

class FakeRelay implements EngineRelayHandle {
  readonly state = "open" as const;
  readonly sent: EngineRelayMessage[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  onMessage(_listener: (message: EngineRelayMessage) => void): () => void {
    return () => undefined;
  }

  send(message: EngineRelayMessage): void {
    this.sent.push(message);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
  }
}

interface Harness {
  gateway: Gateway;
  registry: ConnectionRegistry;
  relay: FakeRelay;
  reports: Array<[string, unknown]>;
  logs: string[];
  attached: string[];
  detached: string[];
  actions: Record<string, unknown>[];
  disposed: string[];
}

function createHarness(overrides: Partial<GatewayDependencies> = {}): Harness {
  const registry = new ConnectionRegistry();
  const docManager = new DocManager({ acpBatchWindowMs: 0 });
  const broadcaster = new YjsBroadcaster(registry);
  const relay = new FakeRelay();
  const reports: Array<[string, unknown]> = [];
  const logs: string[] = [];
  const attached: string[] = [];
  const detached: string[] = [];
  const actions: Record<string, unknown>[] = [];
  const disposed: string[] = [];
  const sessionChannel = {
    async handleAction(
      _connection: SessionConnection,
      action: Record<string, unknown>,
      sinks: { sendAck: (ack: ActionAck) => void; sendError: (error: ActionError) => void },
    ): Promise<void> {
      actions.push(action);
      sinks.sendAck({
        type: "action_ack",
        commandId: typeof action.commandId === "string" ? action.commandId : "",
        status: "committed",
      });
    },
    disposeRcsSession(rcsSessionId: string): void {
      disposed.push(rcsSessionId);
    },
  } as unknown as SessionChannel;
  const relayEvents = {
    createMessageHandler: () => () => undefined,
    bindInstanceSession: () => undefined,
    openReplayWindow: () => undefined,
    convergeStuckPrompt: () => undefined,
  } as unknown as RelayEventHandler;
  const dependencies: GatewayDependencies = {
    registry,
    broadcaster,
    relayEvents,
    sessionChannel,
    getEnvironment: async () => ({ organizationId: "org-1", userId: "user-1" }),
    authorizeEnvironment: () => true,
    resolveWorkspacePath: () => "/workspace",
    ensureRunning: async () => "instance-1",
    connectAgentRelay: async () => relay,
    docManager,
    markRelayAttached: (instanceId) => attached.push(instanceId),
    markRelayDetached: (instanceId) => detached.push(instanceId),
    reportLog: (message) => logs.push(message),
    reportError: (message, error) => reports.push([message, error]),
    maxClients: () => 4,
    isMachineOffline: () => false,
    classifyPermanentSpawnFailure: () => null,
    ...overrides,
  };
  return { gateway: new Gateway(dependencies), registry, relay, reports, logs, attached, detached, actions, disposed };
}

async function open(
  harness: Harness,
  ws = new FakeWebSocket(),
  wsId = "ws-1",
  rcsSessionId = "rcs-1",
): Promise<FakeWebSocket> {
  ws.onSend = (data) => {
    if (typeof data !== "string") return;
    const message = JSON.parse(data) as { type?: string; docs?: Array<{ docName: string; generation: string }> };
    if (message.type !== "yjs:sync-request") return;
    for (const doc of message.docs ?? []) {
      queueMicrotask(() => {
        void harness.gateway.handleMessage(
          ws,
          wsId,
          encodeYjsStateVectorFrame(doc.docName, doc.generation, new Uint8Array()),
        );
      });
    }
  };
  await harness.gateway.handleOpen(ws, wsId, "user-1", "agent-1", { instanceUid: "instance-1", rcsSessionId });
  return ws;
}

function jsonMessages(ws: FakeWebSocket): Array<Record<string, unknown>> {
  return ws.sent
    .filter((data): data is string => typeof data === "string")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

describe("Gateway 内存协议、状态、错误、隔离与清理", () => {
  test("打开连接后完成同步、握手并登记共享 relay", async () => {
    const harness = createHarness();
    const ws = await open(harness);

    expect(harness.registry.getClient("ws-1")?.relayReady).toBe(true);
    expect(harness.relay.sent).toEqual([{ type: "connect" }]);
    expect(harness.attached).toEqual(["instance-1"]);
    expect(jsonMessages(ws).some((message) => message.type === "yjs:sync-request")).toBe(true);
  });

  test.each([
    ["环境不存在", { getEnvironment: async () => undefined }, 4004, "env not found"],
    ["环境未授权", { authorizeEnvironment: () => false }, 4003, "unauthorized"],
    [
      "环境查询异常",
      { getEnvironment: async () => Promise.reject(new Error("lookup")) },
      1011,
      "environment lookup failed",
    ],
    [
      "离线机器",
      { ensureRunning: async () => Promise.reject(new Error("offline")), isMachineOffline: () => true },
      4500,
      "machine offline",
    ],
    [
      "永久启动失败",
      {
        ensureRunning: async () => Promise.reject(new Error("denied")),
        classifyPermanentSpawnFailure: () => "quota_exceeded",
      },
      4502,
      "spawn rejected",
    ],
    ["临时启动失败", { ensureRunning: async () => Promise.reject(new Error("retry")) }, 1011, "spawn failed"],
    ["relay 连接失败", { connectAgentRelay: async () => Promise.reject(new Error("relay")) }, 1011, "relay failed"],
  ])("%s 时发送脱敏错误并关闭 pending 连接", async (_name, overrides, code, reason) => {
    const harness = createHarness(overrides);
    const ws = new FakeWebSocket();

    await harness.gateway.handleOpen(ws, "ws-error", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-error",
    });

    expect(ws.closed).toEqual([{ code, reason }]);
    expect(harness.registry.getClient("ws-error")).toBeUndefined();
    const expectedType =
      _name === "环境不存在"
        ? "CONTROL_PLANE.ENVIRONMENT_UNAVAILABLE"
        : _name === "环境未授权"
          ? "ACTION.FORBIDDEN"
          : _name === "离线机器"
            ? "CONTROL_PLANE.MACHINE_UNAVAILABLE"
            : _name === "环境查询异常"
              ? "INTERNAL.UNCLASSIFIED"
              : "CONTROL_PLANE.INSTANCE_START_FAILED";
    expect(jsonMessages(ws)[0]).toMatchObject({ type: "error", payload: { type: expectedType } });
    expect(JSON.stringify(jsonMessages(ws)[0])).not.toContain(reason);
  });

  test("超过连接配额时拒绝连接且不创建 relay", async () => {
    const harness = createHarness({ maxClients: () => 0 });
    const ws = new FakeWebSocket();

    await harness.gateway.handleOpen(ws, "ws-full", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-full",
    });

    expect(ws.closed).toEqual([{ code: 1013, reason: "too many connections" }]);
    expect(harness.relay.sent).toEqual([]);
  });

  test.each(
    Array.from({ length: 20 }, (_, index) => `command-${index + 1}`),
  )("就绪连接转发动作 %s 并返回确认", async (commandId) => {
    const harness = createHarness();
    const ws = await open(harness, new FakeWebSocket(), `ws-${commandId}`, `rcs-${commandId}`);

    await harness.gateway.handleMessage(
      ws,
      `ws-${commandId}`,
      JSON.stringify({ action: "future_action", commandId, payload: { index: commandId } }),
    );

    expect(harness.actions).toEqual([{ action: "future_action", commandId, payload: { index: commandId } }]);
    expect(jsonMessages(ws).at(-1)).toMatchObject({ type: "action_ack", commandId, status: "committed" });
    harness.gateway.handleClose(`ws-${commandId}`);
  });

  test.each(
    Array.from({ length: 20 }, (_, index) => `ping-${index + 1}`),
  )("文本 ping %s 只返回 pong 而不触发动作", async (wsId) => {
    const harness = createHarness();
    const ws = await open(harness, new FakeWebSocket(), wsId, `rcs-${wsId}`);

    await harness.gateway.handleMessage(ws, wsId, JSON.stringify({ type: "ping" }));

    expect(jsonMessages(ws).at(-1)).toEqual({ type: "pong" });
    expect(harness.actions).toEqual([]);
    harness.gateway.handleClose(wsId);
  });

  test.each(
    Array.from({ length: 20 }, (_, index) => `invalid-${index + 1}`),
  )("无效文本 %s 不转发且保持连接", async (wsId) => {
    const harness = createHarness();
    const ws = await open(harness, new FakeWebSocket(), wsId, `rcs-${wsId}`);

    await harness.gateway.handleMessage(ws, wsId, "{");
    await harness.gateway.handleMessage(ws, wsId, JSON.stringify({ type: "keep_alive" }));

    expect(harness.actions).toEqual([]);
    expect(ws.closed).toEqual([]);
    harness.gateway.handleClose(wsId);
  });

  test.each(
    Array.from({ length: 20 }, (_, index) => `session-${index + 1}`),
  )("状态向量 %s 不能跨 RCS 会话读取或完成同步", async (rcsSessionId) => {
    const harness = createHarness();
    const ws = await open(harness, new FakeWebSocket(), `ws-${rcsSessionId}`, rcsSessionId);
    const client = harness.registry.getClient(`ws-${rcsSessionId}`);
    const generation =
      harness.registry.getClient(`ws-${rcsSessionId}`)?.rcsSessionId === rcsSessionId
        ? await (async () => harness.registry.getClient(`ws-${rcsSessionId}`)?.rcsSessionId)()
        : "missing";

    await harness.gateway.handleMessage(
      ws,
      `ws-${rcsSessionId}`,
      encodeYjsStateVectorFrame(`chat:other-${rcsSessionId}`, generation, new Uint8Array()),
    );

    expect(client?.rcsSessionId).toBe(rcsSessionId);
    expect(ws.closed).toEqual([]);
    harness.gateway.handleClose(`ws-${rcsSessionId}`);
  });

  test.each(
    Array.from({ length: 20 }, (_, index) => `cleanup-${index + 1}`),
  )("最后一个客户端关闭 %s 时释放 relay、监听器和会话状态", async (rcsSessionId) => {
    const harness = createHarness();
    await open(harness, new FakeWebSocket(), `ws-${rcsSessionId}`, rcsSessionId);

    harness.gateway.handleClose(`ws-${rcsSessionId}`);

    expect(harness.registry.getShared("instance-1", "user-1", rcsSessionId)).toBeUndefined();
    expect(harness.relay.closed).toEqual([{ code: 1000, reason: "all yjs frontend clients disconnected" }]);
    expect(harness.disposed).toEqual([rcsSessionId]);
    expect(harness.detached).toEqual(["instance-1"]);
  });

  test("同一会话的两个客户端共享 relay，直到最后关闭才释放", async () => {
    const harness = createHarness();
    await open(harness, new FakeWebSocket(), "ws-a", "rcs-shared");
    await open(harness, new FakeWebSocket(), "ws-b", "rcs-shared");

    harness.gateway.handleClose("ws-a");
    expect(harness.relay.closed).toEqual([]);
    expect(harness.registry.getShared("instance-1", "user-1", "rcs-shared")?.refCount).toBe(1);

    harness.gateway.handleClose("ws-b");
    expect(harness.relay.closed).toEqual([{ code: 1000, reason: "all yjs frontend clients disconnected" }]);
  });
});
