// create_session 的创建回执：committed Ack 必须携带 Agent 实际创建出的 session id。
//
// 为什么单列一个文件：这条回执是「在该分组新建会话」把归属绑定到本页本次创建的唯一依据
// （见 docs/design/2026-10-15-chat-space-design.md §6.5）。共享投影里的 active session 变化
// 无法回答「这次点击创建出了哪个会话」——同一 Y.Doc 上别的标签页创建/切换同样会改它。
// 本文件覆盖三条边界：正常回执、被后续切换取代的迟到回执、Agent 拒绝与 relay 断开的空回执。

import { afterEach, describe, expect, test } from "bun:test";
import { YjsBroadcaster } from "../channel/broadcaster";
import { ConnectionRegistry } from "../channel/connection-registry";
import type { RelayMessage, SharedRelay } from "../channel/connection-types";
import { RelayEventHandler } from "../channel/relay-event-handler";
import { SessionChannel, type SessionConnection } from "../channel/session-channel";
import { failPendingSessionMutations, waitForSessionCreation } from "../channel/session-mutation";
import type { ActionAck, ActionError } from "../channel/types";
import { DocManager } from "../state/doc-manager";

interface Harness {
  manager: DocManager;
  shared: SharedRelay;
  connection: SessionConnection;
  sent: Record<string, unknown>[];
  acks: ActionAck[];
  errors: ActionError[];
  send: (action: Record<string, unknown>) => Promise<void>;
  receive: (response: Record<string, unknown>) => Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    failPendingSessionMutations(harness.shared);
    await harness.manager.closeAll();
  }
});

async function createHarness(): Promise<Harness> {
  const manager = new DocManager({ acpBatchWindowMs: 0 });
  await manager.openChat("rcs-1");
  await manager.openSession("user-1", "agent-1", "rcs-1");
  const sent: Record<string, unknown>[] = [];
  const acks: ActionAck[] = [];
  const errors: ActionError[] = [];
  const shared: SharedRelay = {
    handle: { state: "open", send() {}, close() {} },
    unsubscribe: null,
    refCount: 1,
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    workspacePath: "/trusted-workspace",
    nextRpcId: 0,
  };
  const connection: SessionConnection = {
    userId: shared.userId,
    agentId: shared.agentId,
    instanceId: shared.instanceId,
    rcsSessionId: shared.rcsSessionId,
    acpSessionId: null,
    agentStatusReceived: true,
    sessionLoaded: false,
    workspacePath: shared.workspacePath,
    sendToRelay: (rpc) => {
      sent.push(rpc);
    },
    getNextRpcId: () => ++shared.nextRpcId,
    registerSessionSyncRpcId: (rpcId) => {
      if (!shared.pendingSessionSyncIds) shared.pendingSessionSyncIds = new Set();
      shared.pendingSessionSyncIds.add(rpcId);
      shared.latestSessionSyncRpcId = rpcId;
    },
    awaitSessionCreation: (rpcId) => waitForSessionCreation(shared, rpcId, 1_000),
  };
  const channel = new SessionChannel({
    docManager: manager,
    replaceProjection() {},
    syncSessionId() {},
    reportError() {},
  });
  const registry = new ConnectionRegistry();
  const handler = new RelayEventHandler({
    docManager: manager,
    registry,
    broadcaster: new YjsBroadcaster(registry),
    registerYjsDocListener() {},
    reportError() {},
    touchInstanceActivity() {},
    terminateLocalDeadInstance() {},
  });
  const receive = handler.createMessageHandler(shared);
  const harness: Harness = {
    manager,
    shared,
    connection,
    sent,
    acks,
    errors,
    send: (action) =>
      channel.handleAction(connection, action, {
        sendAck: (ack) => acks.push(ack),
        sendError: (error) => errors.push(error),
      }),
    receive: async (response) => {
      await receive(response as unknown as RelayMessage);
    },
  };
  harnesses.push(harness);
  return harness;
}

/** 会话同步响应的线上信封（translator 解析的包裹格式）。 */
function sessionSyncResult(rpcId: unknown, sessionId: string) {
  return { type: "session_data", payload: { jsonrpc: "2.0", id: rpcId, result: { sessionId } } };
}

function committed(harness: Harness): ActionAck | undefined {
  return harness.acks.find((ack) => ack.status === "committed");
}

describe("create_session 创建回执", () => {
  // 创建成功的判定是 Agent 的 session/new 结果，不是「RPC 已转发」：committed Ack 必须等结果并带上 session id。
  test("Agent 返回结果后 committed Ack 携带 session id", async () => {
    const harness = await createHarness();
    const pending = harness.send({ action: "create_session", commandId: "create-receipt" });
    await Bun.sleep(0);

    // 只发出去还不够：此时既不能提交，也不能给出创建回执。
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    expect(harness.sent[0]).toMatchObject({ method: "session/new" });

    await harness.receive(sessionSyncResult(harness.sent[0]?.id, "ses-new"));
    await pending;

    const ack = committed(harness);
    expect(ack?.commandId).toBe("create-receipt");
    expect(ack?.sessionId).toBe("ses-new");
    expect(harness.errors).toEqual([]);
  });

  // 用户/别的标签页在结果回来前切走时，投影不提交（新鲜度校验），但创建者仍必须拿到自己那次创建的回执。
  test("被后续切换取代的迟到回执仍然结算 session id", async () => {
    const harness = await createHarness();
    const creating = harness.send({ action: "create_session", commandId: "create-superseded" });
    await Bun.sleep(0);
    const createRpcId = harness.sent[0]?.id;

    // 另一个标签页的 load 抢占了「最新会话同步请求」位置。
    harness.connection.registerSessionSyncRpcId?.(999);
    await harness.receive(sessionSyncResult(createRpcId, "ses-created-elsewhere"));
    await creating;

    expect(committed(harness)?.sessionId).toBe("ses-created-elsewhere");
    // 投影没有被这次创建改写：会话 id 仍以最新一次切换为准。
    expect(harness.connection.acpSessionId).toBeNull();
  });

  // Agent 拒绝创建时不产生回执：调用方据此走「无回执」分支（不写归属），而不是把失败当成功。
  test("Agent 拒绝时提交不含 session id 的回执", async () => {
    const harness = await createHarness();
    const pending = harness.send({ action: "create_session", commandId: "create-rejected" });
    await Bun.sleep(0);

    await harness.receive({
      type: "session_data",
      payload: { jsonrpc: "2.0", id: harness.sent[0]?.id, error: { code: -32000, message: "no active session" } },
    });
    await pending;

    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed"]);
    expect(committed(harness)?.sessionId).toBeUndefined();
  });

  // relay 断开（实例回收/机器离线）时在途回执必须立即失败，不能让等待方挂到超时。
  test("relay 断开使在途创建回执以空值完成", async () => {
    const harness = await createHarness();
    const pending = harness.send({ action: "create_session", commandId: "create-relay-closed" });
    await Bun.sleep(0);
    expect(harness.shared.pendingSessionCreations?.size).toBe(1);

    failPendingSessionMutations(harness.shared);
    await pending;

    expect(committed(harness)?.sessionId).toBeUndefined();
    expect(harness.shared.pendingSessionCreations?.size).toBe(0);
  });
});
