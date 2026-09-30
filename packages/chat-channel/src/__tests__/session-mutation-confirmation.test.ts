import { afterEach, describe, expect, test } from "bun:test";
import { YjsBroadcaster } from "../channel/broadcaster";
import { ConnectionRegistry } from "../channel/connection-registry";
import type { RelayMessage, SharedRelay } from "../channel/connection-types";
import { RelayEventHandler } from "../channel/relay-event-handler";
import { SessionChannel, type SessionConnection } from "../channel/session-channel";
import { failPendingSessionMutations, waitForSessionMutation } from "../channel/session-mutation";
import type { ActionAck, ActionError } from "../channel/types";
import { getSessionInfo } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";

interface Harness {
  manager: DocManager;
  shared: SharedRelay;
  connection: SessionConnection;
  sent: Record<string, unknown>[];
  acks: ActionAck[];
  errors: ActionError[];
  reports: string[];
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

async function createHarness(timeoutMs = 1_000): Promise<Harness> {
  const manager = new DocManager({ acpBatchWindowMs: 0 });
  await manager.openChat("rcs-1");
  await manager.openSession("user-1", "agent-1", "rcs-1");
  getSessionInfo(manager.getSessionYdoc("rcs-1")!).set("sessionId", "ses-current");
  const sent: Record<string, unknown>[] = [];
  const acks: ActionAck[] = [];
  const errors: ActionError[] = [];
  const reports: string[] = [];
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
    acpSessionId: "ses-current",
    agentStatusReceived: true,
    sessionLoaded: false,
    workspacePath: shared.workspacePath,
    sendToRelay: (rpc) => {
      sent.push(rpc);
    },
    getNextRpcId: () => ++shared.nextRpcId,
    awaitSessionMutation: (rpcId) => waitForSessionMutation(shared, rpcId, timeoutMs),
  };
  const channel = new SessionChannel({
    docManager: manager,
    replaceProjection() {},
    syncSessionId() {},
    reportError(message) {
      reports.push(message);
    },
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
    reports,
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

describe("Agent 会话变更结果确认", () => {
  // 重命名和删除必须等待对应 Agent 成功响应，不能把 relay 发送完成当成持久化完成。
  test.each(["delete_session"])("%s 成功响应后才提交并刷新列表", async (action) => {
    const harness = await createHarness();
    const pending = harness.send({ action, commandId: "mutation-1", sessionId: "ses-other", title: "新标题" });
    await Bun.sleep(0);

    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    expect(harness.sent).toHaveLength(1);
    expect(harness.shared.pendingSessionMutations?.size).toBe(1);
    await harness.receive({ jsonrpc: "2.0", id: 999, result: {} });
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted"]);

    await harness.receive({
      type: "session_data",
      payload: { jsonrpc: "2.0", id: harness.sent[0]?.id, result: { sessionId: "ses-other" } },
    });
    await pending;

    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed"]);
    expect(harness.errors).toEqual([]);
    expect(harness.sent[1]).toMatchObject({ method: "session/list", params: { cwd: "/trusted-workspace" } });
    expect(harness.shared.pendingSessionMutations?.size).toBe(0);
    expect(getSessionInfo(harness.manager.getSessionYdoc("rcs-1")!).get("sessionId")).toBe("ses-current");
    expect(harness.connection.acpSessionId).toBe("ses-current");

    await harness.send({ action, commandId: "mutation-1", sessionId: "ses-other", title: "新标题" });
    expect(harness.acks.at(-1)?.status).toBe("duplicate");
    expect(harness.sent).toHaveLength(2);
  });

  // Agent 删除已成功时，标题元数据清理失败只记录诊断，仍提交删除并重新拉取列表。
  test("删除成功后标题清理失败仍提交并刷新列表", async () => {
    const harness = await createHarness();
    harness.manager.setSessionTitleStore({
      async read() {
        return {};
      },
      async write() {},
      async delete() {
        throw new Error("metadata unavailable");
      },
    });
    const pending = harness.send({
      action: "delete_session",
      commandId: "delete-cleanup-failed",
      sessionId: "ses-other",
    });
    await Bun.sleep(0);
    await harness.receive({ jsonrpc: "2.0", id: harness.sent[0]?.id, result: { deleted: true } });
    await pending;
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed"]);
    expect(harness.errors).toEqual([]);
    expect(harness.sent[1]).toMatchObject({ method: "session/list" });
    expect(harness.reports).toContain("[SessionChannel] session title cleanup failed");
  });

  // Agent 拒绝变更时不得刷新或提交，失败命令允许同 commandId 再次尝试。
  test("错误响应返回失败且释放等待登记", async () => {
    const harness = await createHarness();
    const action = { action: "delete_session", commandId: "delete-failed", sessionId: "ses-other" };
    const pending = harness.send(action);
    await Bun.sleep(0);
    await harness.receive({ jsonrpc: "2.0", id: harness.sent[0]?.id, error: { code: -32603, message: "Rejected" } });
    await pending;

    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.AGENT_UNAVAILABLE" } }]);
    expect(harness.sent).toHaveLength(1);
    expect(harness.shared.pendingSessionMutations?.size).toBe(0);

    const retry = harness.send(action);
    await Bun.sleep(0);
    await harness.receive({ jsonrpc: "2.0", id: harness.sent[1]?.id, result: {} });
    await retry;
    expect(harness.acks.at(-1)?.status).toBe("committed");
  });

  // relay 断开必须立即收敛等待中的删除，不能留下成功反馈或待决资源。
  test("relay 断开使待决变更失败", async () => {
    const harness = await createHarness();
    const pending = harness.send({
      action: "delete_session",
      commandId: "delete-disconnected",
      sessionId: "ses-other",
    });
    await Bun.sleep(0);
    await harness.receive({ type: "relay_closed" });
    await pending;
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.AGENT_UNAVAILABLE" } }]);
    expect(harness.shared.pendingSessionMutations?.size).toBe(0);
  });

  // Agent 没有回包时有界超时必须失败，迟到成功响应不得把已失败命令改成成功。
  test("超时释放登记且忽略迟到成功响应", async () => {
    const harness = await createHarness(5);
    await harness.send({ action: "delete_session", commandId: "delete-timeout", sessionId: "ses-other" });
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.AGENT_UNAVAILABLE" } }]);
    expect(harness.shared.pendingSessionMutations?.size).toBe(0);
    await harness.receive({ jsonrpc: "2.0", id: harness.sent[0]?.id, result: {} });
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    expect(harness.sent).toHaveLength(1);
  });

  // relay 发送异常必须同步取消已登记的等待，不能泄漏定时器或发送列表刷新。
  test("发送失败取消变更等待", async () => {
    const harness = await createHarness();
    harness.connection.sendToRelay = () => {
      throw new Error("relay unavailable");
    };
    await harness.send({ action: "delete_session", commandId: "delete-send-failed", sessionId: "ses-other" });
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.AGENT_UNAVAILABLE" } }]);
    expect(harness.shared.pendingSessionMutations?.size).toBe(0);
    expect(harness.sent).toEqual([]);
  });

  // 缺失响应确认端口时保守拒绝变更，不得退回“发送即成功”的旧语义。
  test("缺少结果确认端口不提交会话变更", async () => {
    const harness = await createHarness();
    harness.connection.awaitSessionMutation = undefined;
    await harness.send({
      action: "delete_session",
      commandId: "rename-no-confirmation",
      sessionId: "ses-other",
      title: "新标题",
    });
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.AGENT_UNAVAILABLE" } }]);
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    expect(harness.sent).toEqual([]);
  });
});
