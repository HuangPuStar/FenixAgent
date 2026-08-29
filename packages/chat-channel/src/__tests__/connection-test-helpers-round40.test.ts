import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { YjsBroadcaster } from "../channel/broadcaster";
import { ConnectionRegistry } from "../channel/connection-registry";
import {
  codedError,
  createBoundDocs,
  createClient,
  createGateway,
  createRelayEvents,
  createSessionChannelStub,
  createSharedRelay,
  createSpawnClassifier,
  createTestRpcReservationFactory,
  createWs,
  decodeSnapshot,
  decodeUpdateFrames,
  deferred,
  textFrames,
} from "../channel/connection-test-helpers";
import { getRelayRpcState, type RelayMessage } from "../channel/connection-types";
import { encodeYjsUpdateFrame } from "../protocol/update-frame";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

describe("connection-test-helpers 内存连接语义", () => {
  // 新建 WS 默认处于 OPEN，且没有遗留消息或关闭记录。
  test("creates an open in-memory websocket with empty transport history", () => {
    const ws = createWs();

    expect(ws.readyState).toBe(1);
    expect(ws.messages).toEqual([]);
    expect(ws.closed).toEqual([]);
    expect(ws.bufferedAmount).toBe(0);
  });

  // fake WS 应保留发送顺序，便于测试控制帧和二进制帧交错的真实传输情形。
  test("records text and binary websocket frames in send order", () => {
    const ws = createWs();
    const update = new Uint8Array([1, 2]);

    ws.send('{"type":"keep_alive"}');
    ws.send(update);

    expect(ws.messages).toEqual(['{"type":"keep_alive"}', update]);
  });

  // close 调用的 code 与 reason 是断链断言所需的可观测状态。
  test("records every websocket close invocation with its code and reason", () => {
    const ws = createWs();

    ws.close(1013, "slow consumer");
    ws.close();

    expect(ws.closed).toEqual([
      [1013, "slow consumer"],
      [undefined, undefined],
    ]);
  });

  // 自定义 bufferedAmount 必须透传，才能用纯内存 fake 驱动背压分支。
  test("preserves a supplied websocket buffered amount", () => {
    const ws = createWs(65_537);

    expect(ws.bufferedAmount).toBe(65_537);
  });

  // 控制帧提取不能误把 Yjs 二进制帧交给 JSON 断言。
  test("filters binary updates out of text frames", () => {
    const ws = createWs();
    ws.send('{"type":"pong"}');
    ws.send(new Uint8Array([1, 2, 3]));
    ws.send('{"type":"error"}');

    expect(textFrames(ws)).toEqual(['{"type":"pong"}', '{"type":"error"}']);
  });

  // 更新帧解码只接受协议合法的二进制帧，损坏数据应被隔离而非污染结果。
  test("decodes valid update frames while ignoring text and invalid binary frames", () => {
    const ws = createWs();
    const update = new Uint8Array([9, 8, 7]);
    ws.send('{"type":"keep_alive"}');
    ws.send(new Uint8Array([0xff]));
    ws.send(encodeYjsUpdateFrame("chat:rcs-1", update));

    expect(decodeUpdateFrames(ws)).toEqual([{ docName: "chat:rcs-1", update }]);
  });

  // snapshot helper 必须能将真实 Yjs update 恢复为可查询的文档状态。
  test("restores a requested snapshot into a Yjs document", () => {
    const source = new Y.Doc();
    source.getMap("chat").set("title", "恢复成功");
    const ws = createWs();
    ws.send(encodeYjsUpdateFrame("chat:rcs-1", Y.encodeStateAsUpdate(source)));

    expect(decodeSnapshot(ws, "chat:rcs-1").getMap("chat").get("title")).toBe("恢复成功");
  });

  // 不存在目标文档时必须明确失败，防止测试把错误路由误判为快照为空。
  test("fails with the requested document name when a snapshot is absent", () => {
    const ws = createWs();

    expect(() => decodeSnapshot(ws, "session:missing")).toThrow(
      "expected yjs update frame for session:missing, got 0 frames",
    );
  });

  // shared relay 的默认身份与引用计数应匹配单连接初始装配。
  test("creates a shared relay with default identity and one reference", () => {
    const relay = createSharedRelay();

    expect(relay).toMatchObject({
      refCount: 1,
      userId: "user-1",
      agentId: "agent-1",
      instanceId: "instance-1",
      rcsSessionId: "rcs-1",
      workspacePath: "/workspace",
    });
    expect(getRelayRpcState(relay).pendingRpcRequests.size).toBe(0);
    expect(relay.unsubscribe).toBeNull();
  });

  // 覆写必须替代默认 relay 状态，以便构造关闭或回放等生命周期情形。
  test("applies shared relay overrides without changing unspecified defaults", () => {
    const relay = createSharedRelay({ rcsSessionId: "rcs-2", refCount: 3 });

    expect(relay.rcsSessionId).toBe("rcs-2");
    expect(relay.refCount).toBe(3);
    expect(relay.userId).toBe("user-1");
  });

  // client helper 默认表示 relay 已就绪但 ACP session 尚未加载的连接。
  test("creates a ready client with an unloaded session", () => {
    const client = createClient();

    expect(client.relayReady).toBe(true);
    expect(client.acpSessionId).toBeNull();
    expect(client.sessionLoaded).toBe(false);
    expect(client.pendingMessages).toEqual([]);
  });

  // 每个 client 的消息缓冲必须独立，避免多标签页 fake 在测试中串扰。
  test("keeps client pending message buffers isolated", () => {
    const first = createClient({ relayReady: false });
    const second = createClient({ relayReady: false });
    first.pendingMessages.push('{"type":"action"}');

    expect(first.pendingMessages).toEqual(['{"type":"action"}']);
    expect(second.pendingMessages).toEqual([]);
  });

  // stub 要将频道 action 转成确定的 cancel RPC，供 Gateway 的真实消息路径使用。
  test("forwards session channel stub actions as a cancel relay RPC", async () => {
    const channel = createSessionChannelStub();
    const relayed: Record<string, unknown>[] = [];

    await channel.handleAction(
      {
        userId: "user-1",
        agentId: "agent-1",
        instanceId: "instance-1",
        rcsSessionId: "rcs-1",
        acpSessionId: "ses-1",
        agentStatusReceived: true,
        sessionLoaded: true,
        workspacePath: "/workspace",
        sendToRelay: (message) => {
          relayed.push(message);
        },
        reserveRpc: createTestRpcReservationFactory(),
      },
      {},
      { sendAck() {}, sendError() {} },
    );

    expect(relayed).toEqual([{ jsonrpc: "2.0", id: 1, method: "session/cancel", params: {} }]);
  });

  // offline 分类仅认可受支持的 Error code，普通 Error 不能被误判。
  test("classifies supported machine offline errors but rejects uncoded errors", () => {
    const classifier = createSpawnClassifier();

    expect(classifier.isMachineOffline(codedError("NODE_OFFLINE"))).toBe(true);
    expect(classifier.isMachineOffline(new Error("offline text only"))).toBe(false);
  });

  // 永久 spawn 失败需转为稳定的前端错误码，未知 code 保持非永久。
  test("maps permanent spawn error codes and leaves unknown codes unclassified", () => {
    const classifier = createSpawnClassifier();

    expect(classifier.classifyPermanentSpawnFailure(codedError("MAX_SESSIONS_REACHED"))).toBe("max_sessions_reached");
    expect(classifier.classifyPermanentSpawnFailure(codedError("TRANSIENT"))).toBeNull();
  });

  // codedError 保留诊断 message 与 code，使调用方可走宿主同构的错误分类。
  test("creates an Error instance carrying the supplied diagnostic code", () => {
    const error = codedError("AUTO_START_DISABLED", "internal diagnostic");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("AUTO_START_DISABLED");
    expect(error.message).toBe("internal diagnostic");
  });

  // 内存 DocManager 应预先打开 chat 与 session 文档，且二者互不共享数据。
  test("opens isolated in-memory chat and session documents", async () => {
    const { chatDoc, sessionDoc } = await createBoundDocs("rcs-isolated");
    chatDoc.getMap("chat").set("message", "only chat");

    expect(chatDoc.getMap("chat").get("message")).toBe("only chat");
    expect(sessionDoc.getMap("chat").get("message")).toBeUndefined();
  });

  // docManager 返回的绑定必须使用请求的 RCS session，不能落到 helper 默认会话。
  test("binds opened documents to the requested RCS session", async () => {
    const { docManager } = await createBoundDocs("rcs-requested");

    expect(docManager.getChatYdoc("rcs-requested")).toBeDefined();
    expect(docManager.getChatYdoc("rcs-1")).toBeUndefined();
  });

  // relay event helper 的默认处理器应将规范化事件真实记录下来。
  test("creates relay events that record normalized event types in memory", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    const relay = createSharedRelay();

    await handler.createMessageHandler(relay)({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk" } },
    } as unknown as RelayMessage);

    expect(processed).toEqual(["message_delta"]);
  });

  // gateway helper 应把真实 Gateway 装配为可打开的纯内存连接。
  test("creates a gateway that opens a connection without external services", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const gateway = createGateway(registry, broadcaster, relayEvents);
    const ws = createWs();

    await gateway.handleOpen(ws, "ws-memory", "user-1", "agent-1", "rcs-memory");

    expect(registry.getClient("ws-memory")?.rcsSessionId).toBe("rcs-memory");
    gateway.handleClose("ws-memory");
  });

  // deferred 允许测试精确控制异步边界，resolve 前 promise 不应提前完成。
  test("keeps a deferred promise pending until explicitly resolved", async () => {
    const pending = deferred<string>();
    let settled = false;
    void pending.promise.then(() => {
      settled = true;
    });

    await flushMicrotasks();
    expect(settled).toBe(false);

    pending.resolve("ready");
    await expect(pending.promise).resolves.toBe("ready");
    expect(settled).toBe(true);
  });
});
