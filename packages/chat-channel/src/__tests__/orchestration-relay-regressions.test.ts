import { describe, expect, test } from "bun:test";
import { YjsBroadcaster } from "../channel/broadcaster";
import { ConnectionRegistry } from "../channel/connection-registry";
import { createClient, createRelayEvents, createSharedRelay } from "../channel/connection-test-helpers";
import type { RelayMessage } from "../channel/connection-types";
import { registerSessionSync, waitForSessionCreation, waitForSessionMutation } from "../channel/session-mutation";
import { getSessionInfo } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function harness() {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const processed: string[] = [];
  const shared = createSharedRelay();
  const client = createClient({ acpSessionId: "ses-old" });
  registry.addClient("ws", client);
  const handler = createRelayEvents(registry, broadcaster, processed);
  return { registry, broadcaster, processed, shared, client, handler };
}

describe("Agent 编排会话回执的传输边界", () => {
  // load 成功响应可省略 ID，只能沿用本次已登记目标，不能沿用连接旧 ID。
  test("无 sessionId 的成功 load 回执确认登记目标", async () => {
    const h = harness();
    registerSessionSync(h.shared, 1, "ses-new");
    const receipt = waitForSessionMutation(h.shared, 1);
    await h.handler.createMessageHandler(h.shared)({ jsonrpc: "2.0", id: 1, result: {} } as RelayMessage);
    expect(await receipt.completed).toBe(true);
    expect(h.client.acpSessionId).toBe("ses-new");
    expect(h.shared.pendingSessionTarget).toBeUndefined();
    if (h.shared.replayWindowTimer) clearTimeout(h.shared.replayWindowTimer);
  });

  // 已发 load 的回放目标与可发 prompt 的已确认绑定分开，确认前新历史仍须可见。
  test("加载中只接收登记目标的历史，保留旧发送绑定", async () => {
    const h = harness();
    registerSessionSync(h.shared, 1, "ses-new");
    const handler = h.handler.createMessageHandler(h.shared);
    await handler({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-new",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new" } },
      },
    } as unknown as RelayMessage);
    expect(h.processed).toContain("message_delta");
    expect(h.client.acpSessionId).toBe("ses-old");
    h.processed.length = 0;
    await handler({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-old",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } },
      },
    } as unknown as RelayMessage);
    expect(h.processed).toEqual([]);
  });

  // 超时或取消撤销登记后，迟到成功响应不能恢复失败的会话绑定。
  test("取消等待器后忽略迟到回执且不污染新请求", async () => {
    const h = harness();
    registerSessionSync(h.shared, 1, "ses-a");
    const old = waitForSessionMutation(h.shared, 1);
    old.cancel();
    registerSessionSync(h.shared, 2, "ses-b");
    const generation = h.shared.sessionSyncGeneration;
    old.cancel();
    expect(h.shared.sessionSyncGeneration).toBe(generation);
    await h.handler.createMessageHandler(h.shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses-a" },
    } as RelayMessage);
    expect(h.client.acpSessionId).toBe("ses-old");
    expect(h.shared.pendingSessionTarget?.sessionId).toBe("ses-b");
  });

  // Agent 必须确认本次请求的目标；协议异常和错误目标不能提交成功。
  test.each([null, { sessionId: "ses-wrong" }])("拒绝无效或目标不符的 load 回执 %j", async (result) => {
    const h = harness();
    registerSessionSync(h.shared, 1, "ses-new");
    const receipt = waitForSessionMutation(h.shared, 1);
    await h.handler.createMessageHandler(h.shared)({ jsonrpc: "2.0", id: 1, result } as RelayMessage);
    expect(await receipt.completed).toBe(false);
    expect(h.client.acpSessionId).toBe("ses-old");
    expect(h.shared.pendingSessionSyncIds?.size).toBe(0);
  });

  // 旧响应在读 Doc 时暂停，新切换接管后旧 await 完成也不能改写 registry 或新投影。
  test("回执处理跨 await 时复核切换身份", async () => {
    const h = harness();
    const manager = new DocManager({ acpBatchWindowMs: 0 });
    await manager.openChat("rcs-1");
    await manager.openSession("user-1", "agent-1", "rcs-1");
    const entered = deferred();
    const gate = deferred();
    const openSession = manager.openSession.bind(manager);
    manager.openSession = async (...args) => {
      entered.resolve();
      await gate.promise;
      return openSession(...args);
    };
    const handler = createRelayEvents(h.registry, h.broadcaster, [], { docManager: manager });
    registerSessionSync(h.shared, 1, "ses-a");
    const old = handler.createMessageHandler(h.shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses-a" },
    } as RelayMessage);
    await entered.promise;
    registerSessionSync(h.shared, 2, "ses-b");
    h.client.acpSessionId = "ses-b";
    gate.resolve();
    await old;
    expect(h.client.acpSessionId).toBe("ses-b");
    expect(getSessionInfo(manager.getSessionYdoc("rcs-1")!).get("sessionId")).not.toBe("ses-a");
    if (h.shared.replayWindowTimer) clearTimeout(h.shared.replayWindowTimer);
  });

  // create 的空回执也必须失效请求登记，避免之后的迟到结果偷偷绑定新会话。
  test("create 等待器取消撤销回执提交权", async () => {
    const h = harness();
    registerSessionSync(h.shared, 1);
    const receipt = waitForSessionCreation(h.shared, 1);
    receipt.cancel();
    await h.handler.createMessageHandler(h.shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses-orphan" },
    } as RelayMessage);
    expect(await receipt.completed).toBeNull();
    expect(h.client.acpSessionId).toBe("ses-old");
  });
});
