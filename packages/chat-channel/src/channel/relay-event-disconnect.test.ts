import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { DocManager } from "../state/doc-manager";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createBoundDocs, createClient, createRelayEvents, createWs, textFrames } from "./connection-test-helpers";
import type { RelayMessage } from "./connection-types";
import { relayOn } from "./relay-event-test-helpers";

describe("RelayEventHandler relay_closed cleanup", () => {
  // 本地实例的 relay 意外关闭：触发实例级清理（注入），并以同一公开错误通知日志、Y.Doc 与客户端；
  // 随后关闭 1011（允许自动重连）、销毁 Chat/Session Doc 与广播订阅。
  test("relay_closed disposes realtime resources and notifies every client of the RCS session", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc, sessionDoc } = await createBoundDocs("rcs-1");
    // 预写时间线内容，验证销毁后不残留
    chatDoc.getMap("root").set("schemaVersion", 1);
    sessionDoc.getMap("root").set("schemaVersion", 1);
    const unregistered: string[] = [];
    const origUnregister = broadcaster.unregisterYjsDocListener.bind(broadcaster);
    broadcaster.unregisterYjsDocListener = (docName) => {
      unregistered.push(docName);
      origUnregister(docName);
    };
    broadcaster.registerYjsDocListener(chatDoc, "chat:rcs-1");
    broadcaster.registerYjsDocListener(sessionDoc, "session:rcs-1");
    const logs: string[] = [];
    const processed: Array<{ type: string; publicError?: unknown }> = [];
    const originalProcess = docManager.processNormalizedEvent.bind(docManager);
    docManager.processNormalizedEvent = (rcsSessionId, event) => {
      processed.push({ type: event.type, publicError: event.update.publicError });
      return originalProcess(rcsSessionId, event);
    };
    const handler = createRelayEvents(registry, broadcaster, [], {
      docManager,
      log: (message) => logs.push(message),
    });
    const ws1 = createWs();
    const ws2 = createWs();
    registry.addClient("ws-1", createClient({ ws: ws1 }));
    registry.addClient("ws-2", createClient({ ws: ws2 }));

    await handler.createMessageHandler(relayOn("rcs-1"))({
      type: "relay_closed",
      payload: { code: "relay_disconnected" },
    } as unknown as RelayMessage);

    const frame = JSON.parse(textFrames(ws1)[0] ?? "{}") as {
      type: string;
      payload: { type: string; id: string; message: string };
    };
    expect(frame).toMatchObject({
      type: "error",
      payload: { type: "AGENT_RUNTIME.DISCONNECTED", message: "The Agent disconnected." },
    });
    for (const ws of [ws1, ws2]) {
      expect(JSON.parse(textFrames(ws)[0] ?? "{}")).toEqual(frame);
      expect(ws.closed).toEqual([[1011, "relay handle closed"]]);
    }
    expect(processed).toContainEqual({ type: "turn_failed", publicError: frame.payload });
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      event: "chat.error",
      errorId: frame.payload.id,
      errorType: frame.payload.type,
      stage: "relay.connection_closed",
    });
    expect(unregistered).toContain("chat:rcs-1");
    expect(unregistered).toContain("session:rcs-1");
    // 热缓存删除：内存中不再有 Chat / Session Doc
    expect(docManager.getChatYdoc("rcs-1")).toBeUndefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeUndefined();
  });

  // relay_closed 只负责释放本节点实时资源，运行实体的死亡由带身份的连接工厂归并。
  test("relay_closed still disposes local realtime resources when the host skips instance cleanup", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], {
      docManager,
    });
    registry.addClient("ws-1", createClient());

    await handler.createMessageHandler(relayOn("rcs-1"))({
      type: "relay_closed",
      payload: { code: "relay_disconnected" },
    } as unknown as RelayMessage);

    expect(docManager.getChatYdoc("rcs-1")).toBeUndefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeUndefined();
  });

  // 新实例创建全新实时投影：relay_closed 销毁后再次 openChat/openSession 返回全新
  // 空 Doc（含旧时间线的 snapshot 不会被加载），且旧事件对已销毁 binding 直接丢弃。
  test("reopening after relay_closed creates a fresh projection without loading the old Y.Doc", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const docManager = new DocManager();
    const chatDoc = (await docManager.openChat("rcs-1")).ydoc;
    const sessionDoc = (await docManager.openSession("user-1", "agent-1", "rcs-1")).ydoc;
    // 模拟旧实例产物已存在时间线内容（权威依据 entryOrder / entries）
    chatDoc.getMap("root").set("projectionVersion", 7);
    sessionDoc.getMap("root").set("schemaVersion", 1);
    const handler = createRelayEvents(registry, broadcaster, [], {
      docManager,
    });

    // 实例断链 → 销毁热缓存
    await handler.createMessageHandler(relayOn("rcs-1"))({
      type: "relay_closed",
    } as unknown as RelayMessage);
    expect(docManager.getChatYdoc("rcs-1")).toBeUndefined();

    // 旧实例的晚到 ACP 帧：binding 已删除 → 丢弃，不重建 Doc（不产生任何投影）
    docManager.processNormalizedEvent("rcs-1", {
      type: "message_delta",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } },
      content: { type: "text", text: "late" },
    });

    // 新连接（新实例）重新打开：全新 Doc，不加载旧内容
    // （projectionVersion 为 createChatDoc 的初始值 1，而非旧实例的 7；entries 为空）
    const reopened = await docManager.openChat("rcs-1");
    expect(reopened.ydoc.getMap("root").get("projectionVersion")).toBe(1);
    expect((reopened.ydoc.getMap("root").get("entries") as Y.Map<unknown>).size).toBe(0);
  });
});

describe("RelayEventHandler agent process recovery", () => {
  // Agent 子进程死亡只广播 connected:false；首次必须以 1011 关闭客户端触发重连，
  // 由新 connect 重启子进程，且不得销毁实时 Doc（断链语义一：保留 Doc 供重连）。
  test("connected:false closes clients with 1011 once and keeps realtime docs", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws }));

    await handler.createMessageHandler(relayOn("rcs-1"))({
      type: "status",
      payload: { connected: false },
    } as unknown as RelayMessage);

    expect(ws.closed).toEqual([[1011, "agent restarting"]]);
    expect(docManager.getChatYdoc("rcs-1")).toBeDefined();
    expect(docManager.getSessionYdoc("rcs-1")).toBeDefined();
  });

  // 窗口内再次死亡说明重启无法收敛：第二次下发 INSTANCE_START_FAILED 并以 4502
  // 终态关闭，停止自动重连，避免无限重连放大故障。两次死亡来自不同进程必须分别计数。
  test("disconnect from a new agent process within the window terminates with 4502 and a public error", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws }));
    const send = handler.createMessageHandler(relayOn("rcs-1"));

    await send({ type: "status", payload: { connected: false, agentPid: 100 } } as unknown as RelayMessage);
    await send({ type: "status", payload: { connected: false, agentPid: 200 } } as unknown as RelayMessage);

    expect(ws.closed).toEqual([
      [1011, "agent restarting"],
      [4502, "agent unavailable"],
    ]);
    const frame = JSON.parse(textFrames(ws)[0] ?? "{}") as {
      type: string;
      payload: { type: string };
    };
    expect(frame).toMatchObject({
      type: "error",
      payload: { type: "CONTROL_PLANE.INSTANCE_START_FAILED" },
    });
  });

  // 同一进程的死亡会由流 EOF 与子进程 exit 各广播一次：按 agentPid 去重后只消费一次
  // 恢复额度，不得把正在重连的客户端以 4502 判死。
  test("duplicate connected:false from the same agent process consumes the budget only once", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws }));
    const send = handler.createMessageHandler(relayOn("rcs-1"));

    await send({ type: "status", payload: { connected: false, agentPid: 100 } } as unknown as RelayMessage);
    await send({ type: "status", payload: { connected: false, agentPid: 100 } } as unknown as RelayMessage);

    expect(ws.closed).toEqual([[1011, "agent restarting"]]);
    expect(textFrames(ws)).toHaveLength(0);
  });

  // 无人连接时进程死亡不消耗恢复额度：否则下一次真正需要自愈时会被直接判为终态 4502。
  test("disconnect without a registered client does not consume the recovery budget", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const send = handler.createMessageHandler(relayOn("rcs-1"));

    await send({ type: "status", payload: { connected: false, agentPid: 100 } } as unknown as RelayMessage);

    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws }));
    await send({ type: "status", payload: { connected: false, agentPid: 200 } } as unknown as RelayMessage);

    expect(ws.closed).toEqual([[1011, "agent restarting"]]);
  });

  // 新进程就绪（capabilities 非空）后恢复预算清零：之后再次死亡仍可获得一次自愈机会。
  test("ready status resets the recovery budget", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws }));
    const send = handler.createMessageHandler(relayOn("rcs-1"));

    await send({ type: "status", payload: { connected: false, agentPid: 100 } } as unknown as RelayMessage);
    await send({
      type: "status",
      payload: { connected: true, capabilities: { loadSession: true }, agentPid: 200 },
    } as unknown as RelayMessage);
    await send({ type: "status", payload: { connected: false, agentPid: 200 } } as unknown as RelayMessage);

    expect(ws.closed).toEqual([
      [1011, "agent restarting"],
      [1011, "agent restarting"],
    ]);
  });
});
