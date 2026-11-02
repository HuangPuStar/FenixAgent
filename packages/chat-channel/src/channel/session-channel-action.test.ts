import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { setSessionInfo } from "../state/chat-writer";
import type { SharedRelay } from "./connection-types";
import {
  createConnection,
  createHarness,
  createSinks,
  type RelayRecord,
  readEntryIds,
} from "./session-channel-action-test-helpers";
import { failPendingSessionMutations, waitForSessionMutation } from "./session-mutation";

describe("SessionChannel action flow", () => {
  // Agent 确认删除后才提交命令并刷新权威列表。
  test("delete refreshes the session list only after Agent success", async () => {
    const harness = createHarness();
    const shared = { pendingSessionMutations: new Map() } as SharedRelay;
    const { connection, relayMessages } = createConnection({
      awaitSessionMutation: (rpcId) => waitForSessionMutation(shared, rpcId),
    });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");

    const action = harness.channel.handleAction(
      connection,
      { action: "delete_session", sessionId: "ses-target", commandId: "cmd-delete" },
      createSinks(harness),
    );
    await Promise.resolve();
    expect(relayMessages.map((message) => message.method)).toEqual(["session/delete"]);
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    shared.pendingSessionMutations?.get(relayMessages[0].id as number)?.(true);
    await action;
    expect(relayMessages.map((message) => message.method)).toEqual(["session/delete", "session/list"]);
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed"]);
  });

  // Agent 返回失败时不刷新列表也不向浏览器发送 committed。
  test("delete failure keeps the list unchanged", async () => {
    const harness = createHarness();
    const shared = { pendingSessionMutations: new Map() } as SharedRelay;
    const { connection, relayMessages } = createConnection({
      awaitSessionMutation: (rpcId) => waitForSessionMutation(shared, rpcId),
    });
    await harness.docManager.openChat("rcs-1");
    const action = harness.channel.handleAction(
      connection,
      { action: "delete_session", sessionId: "ses-target", commandId: "cmd-failed" },
      createSinks(harness),
    );
    await Promise.resolve();
    shared.pendingSessionMutations?.get(relayMessages[0].id as number)?.(false);
    await action;
    expect(relayMessages.map((message) => message.method)).toEqual(["session/delete"]);
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted"]);
    expect(harness.errorFrames[0]).toMatchObject({ error: { type: "ACTION.AGENT_UNAVAILABLE" } });
  });

  // Agent 无响应时超时释放登记，禁止提前刷新历史列表。
  test("delete timeout does not refresh the session list", async () => {
    const harness = createHarness();
    const shared = { pendingSessionMutations: new Map() } as SharedRelay;
    const { connection, relayMessages } = createConnection({
      awaitSessionMutation: (rpcId) => waitForSessionMutation(shared, rpcId, 1),
    });
    await harness.docManager.openChat("rcs-1");
    await harness.channel.handleAction(
      connection,
      { action: "delete_session", sessionId: "ses-target", commandId: "cmd-timeout" },
      createSinks(harness),
    );
    expect(relayMessages.map((message) => message.method)).toEqual(["session/delete"]);
    expect(shared.pendingSessionMutations?.size).toBe(0);
    expect(harness.errorFrames[0]).toMatchObject({ error: { type: "ACTION.AGENT_UNAVAILABLE" } });
  });

  // 共享 relay 断开会使在途删除失败，不得继续刷新。
  test("relay disconnection does not refresh the session list", async () => {
    const harness = createHarness();
    const shared = { pendingSessionMutations: new Map() } as SharedRelay;
    const { connection, relayMessages } = createConnection({
      awaitSessionMutation: (rpcId) => waitForSessionMutation(shared, rpcId),
    });
    await harness.docManager.openChat("rcs-1");
    const action = harness.channel.handleAction(
      connection,
      { action: "delete_session", sessionId: "ses-target", commandId: "cmd-disconnect" },
      createSinks(harness),
    );
    await Promise.resolve();
    failPendingSessionMutations(shared);
    await action;
    expect(relayMessages.map((message) => message.method)).toEqual(["session/delete"]);
    expect(harness.errorFrames[0]).toMatchObject({ error: { type: "ACTION.AGENT_UNAVAILABLE" } });
  });
  // create_session 必须先刷新当前实例环境，随后才发送 session/new，让 Peri 冻结最新 Skills。
  test("refreshes the instance environment before forwarding session/new", async () => {
    const callOrder: string[] = [];
    const harness = createHarness({
      refreshInstanceEnvironment: async () => {
        callOrder.push("refresh");
      },
    });
    const { connection, relayMessages } = createConnection({
      sendToRelay: (message) => {
        callOrder.push("relay");
        relayMessages.push(message as unknown as RelayRecord);
      },
    });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");

    await harness.channel.handleAction(
      connection,
      { action: "create_session", commandId: "cmd-create" },
      createSinks(harness),
    );

    expect(callOrder).toEqual(["refresh", "relay"]);
    expect(relayMessages[0]).toMatchObject({ method: "session/new" });
  });

  // 通道 B：会话级 MCP 条目注入 session/new，且 provider 拿到的是服务端连接上下文。
  test("injects session-scoped mcp servers into session/new", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const mcpServers = [{ type: "http", name: "cloud-drive", url: "http://fenix.local/mcp/cloud-drive", headers: [] }];
    const harness = createHarness({
      sessionMcpServers: async (connection) => {
        contexts.push({ userId: connection.userId, agentId: connection.agentId });
        return mcpServers;
      },
    });
    const { connection, relayMessages } = createConnection();
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");

    await harness.channel.handleAction(
      connection,
      { action: "create_session", commandId: "cmd-mcp" },
      createSinks(harness),
    );

    expect(contexts).toEqual([{ userId: "user-1", agentId: "agent-1" }]);
    expect(relayMessages[0]).toMatchObject({ method: "session/new", params: { mcpServers } });
  });

  // provider 失败时降级为不注入：会话照常创建，错误进入宿主日志通道。
  test("keeps session creation working when session mcp resolution fails", async () => {
    const harness = createHarness({
      sessionMcpServers: async () => {
        throw new Error("token signing failed");
      },
    });
    const { connection, relayMessages } = createConnection();
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");

    await harness.channel.handleAction(
      connection,
      { action: "create_session", commandId: "cmd-mcp-error" },
      createSinks(harness),
    );

    expect(relayMessages[0]).toMatchObject({ method: "session/new" });
    expect((relayMessages[0]?.params as Record<string, unknown>).mcpServers).toBeUndefined();
    expect(harness.errors).toHaveLength(1);
  });

  // 非握手动作不解析会话级 MCP：避免每个 prompt 都做一次 token 签发与 DB 查询。
  test("does not resolve session mcp servers for prompt actions", async () => {
    let calls = 0;
    const harness = createHarness({
      sessionMcpServers: async () => {
        calls += 1;
        return;
      },
    });
    const { connection } = createConnection();
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");

    await harness.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-prompt-mcp", content: [{ type: "text", text: "hi" }] },
      createSinks(harness),
    );

    expect(calls).toBe(0);
  });

  // 环境刷新失败时不得创建 ACP session，客户端收到可重试的通用错误。
  test("does not forward session/new when the instance environment refresh fails", async () => {
    const harness = createHarness({
      refreshInstanceEnvironment: async () => {
        throw new Error("skill download failed");
      },
    });
    const { connection, relayMessages } = createConnection();
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");

    await harness.channel.handleAction(
      connection,
      { action: "create_session", commandId: "cmd-create-error" },
      createSinks(harness),
    );

    expect(relayMessages).toHaveLength(0);
    expect(harness.errorFrames[0]).toMatchObject({
      type: "action_error",
      commandId: "cmd-create-error",
      error: { type: "ACTION.AGENT_UNAVAILABLE" },
    });
    expect(harness.errors).toHaveLength(1);
  });

  // send_prompt 全链路：accepted → committed（含 turnId 与投影版本），用户消息经会话级入口进入同步投影。
  test("send_prompt commits a user entry and forwards session/prompt to relay", async () => {
    const syncMessages: Array<{ turnId: string; text: string }> = [];
    const otherSyncMessages: Array<{ turnId: string; text: string }> = [];
    const harness = createHarness({
      publishUserMessage: (rcsSessionId, turnId, text) => {
        if (rcsSessionId === "rcs-1") syncMessages.push({ turnId, text });
        else otherSyncMessages.push({ turnId, text });
      },
    });
    const { connection, relayMessages } = createConnection({
      syncConnection: {
        onInboundBytes: async () => {},
        acceptNormalizedEvent: () => {},
        acceptUserMessage: () => {},
        dispose: () => {},
      },
    });
    const otherConnection = createConnection({
      rcsSessionId: "rcs-other",
      syncConnection: {
        onInboundBytes: async () => {},
        acceptNormalizedEvent: () => {},
        acceptUserMessage: () => {},
        dispose: () => {},
      },
    }).connection;
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      {
        sessionId: connection.acpSessionId,
        action: "send_prompt",
        commandId: "cmd-1",
        content: [{ type: "text", text: "hello" }],
      },
      sinks,
    );

    expect(harness.acks.map((a) => a.status)).toEqual(["accepted", "committed"]);
    const committed = harness.acks[1];
    expect(committed?.turnId).toBeTruthy();
    expect(committed?.committedProjectionVersion).toBeGreaterThan(1);
    expect(relayMessages).toHaveLength(1);
    expect(relayMessages[0]?.method).toBe("session/prompt");
    expect(syncMessages).toEqual([{ turnId: committed?.turnId ?? "", text: "hello" }]);
    expect(otherConnection.syncConnection).toBeDefined();
    expect(otherSyncMessages).toEqual([]);
    // Chat Doc 投影：user_message 创建 user + assistant 两个 entry（时间线在 Chat Doc）
    const chatDoc = harness.docManager.getChatYdoc("rcs-1");
    expect(readEntryIds(chatDoc as Y.Doc)).toEqual([`${committed?.turnId}:assistant`, `${committed?.turnId}:user`]);
  });

  // send_prompt 出站必须携带服务端绑定的 acpSessionId：多会话共享同一 relay 时
  // acp-dispatcher 的 fallback（连接级当前会话）可能已被其他会话改写，prompt 会
  // 落到错误会话且不报错（loading 卡死根因）。绑定会话为权威目标，与 cwd 注入同理。
  test("send_prompt forwards the bound acpSessionId as the prompt target", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ acpSessionId: "ses-bound" });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      {
        sessionId: connection.acpSessionId,
        action: "send_prompt",
        commandId: "cmd-1",
        content: [{ type: "text", text: "hello" }],
      },
      sinks,
    );

    expect(relayMessages).toHaveLength(1);
    expect(relayMessages[0]?.params).toMatchObject({ sessionId: "ses-bound" });
  });

  // 同一 commandId 重发（超时重试语义）：返回 duplicate、不重复调用 Agent（relay 只发一次）。
  test("retrying the same commandId returns duplicate without re-forwarding to relay", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection();
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const first = createSinks(harness);
    const retry = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      {
        sessionId: connection.acpSessionId,
        action: "send_prompt",
        commandId: "cmd-1",
        content: [{ type: "text", text: "hello" }],
      },
      first,
    );
    await harness.channel.handleAction(
      connection,
      {
        sessionId: connection.acpSessionId,
        action: "send_prompt",
        commandId: "cmd-1",
        content: [{ type: "text", text: "hello" }],
      },
      retry,
    );

    expect(relayMessages).toHaveLength(1);
    // duplicate 是 harness.acks 中的第 3 条（首次 accepted/committed 之后）
    expect(harness.acks[2]).toMatchObject({ commandId: "cmd-1", status: "duplicate" });
    // 去重后时间线不重复（user + assistant 各一个）
    expect(readEntryIds(harness.docManager.getChatYdoc("rcs-1") as Y.Doc)).toHaveLength(2);
  });

  // load_session 非法 sessionId 必须拒绝（INVALID_STATE），不进入队列也不转发 relay。
  test("rejects load_session with invalid sessionId via INVALID_STATE", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ acpSessionId: "ses-1" });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      { action: "load_session", commandId: "cmd-1", sessionId: "" },
      sinks,
    );

    expect(harness.acks).toHaveLength(0);
    expect(harness.errorFrames[0]).toMatchObject({
      type: "action_error",
      commandId: "cmd-1",
      error: { type: "ACTION.INVALID_STATE" },
    });
    expect(relayMessages).toHaveLength(0);
  });

  // load_session 合法：换代两份 Doc 后再转发 session/load（cwd 服务端注入）。
  test("load_session replaces docs and forwards session/load with server-injected cwd", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ acpSessionId: "ses-old" });
    const oldChat = (await harness.docManager.openChat("rcs-1")).ydoc;
    const oldSession = (await harness.docManager.openSession("user-1", "agent-1", "rcs-1")).ydoc;
    const oldGeneration = harness.docManager.getProjectionGeneration("rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      { action: "load_session", commandId: "cmd-1", sessionId: "ses-new" },
      sinks,
    );

    expect(harness.acks.map((a) => a.status)).toEqual(["accepted", "committed"]);
    expect(harness.docManager.getChatYdoc("rcs-1")).not.toBe(oldChat);
    expect(harness.docManager.getSessionYdoc("rcs-1")).not.toBe(oldSession);
    expect(harness.docManager.getProjectionGeneration("rcs-1")).not.toBe(oldGeneration);
    expect(harness.syncCalls).toEqual(["ses-new"]);
    expect(connection.acpSessionId).toBe("ses-new");
    expect(relayMessages).toHaveLength(1);
    expect(relayMessages[0]?.method).toBe("session/load");
    // cwd 必须由服务端注入（workspacePath 来自已认证 environment），浏览器不可覆盖
    expect(relayMessages[0]?.params).toMatchObject({
      sessionId: "ses-new",
      cwd: "/workspace/org-1/user-1/env-1",
    });
  });

  // 首次恢复只能跳过与目标 ACP session 匹配的持久化投影：旧会话的时间线不可冒充
  // 新目标已加载，否则前端会先高亮目标但仍显示旧会话，需先切换其他项才会触发真正 load。
  test("first load replaces a persisted timeline when it belongs to another session", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ acpSessionId: null, sessionLoaded: false });
    const oldChat = (await harness.docManager.openChat("rcs-1")).ydoc;
    const oldSession = (await harness.docManager.openSession("user-1", "agent-1", "rcs-1")).ydoc;
    await harness.docManager.registerUserMessage("rcs-1", "message from the previous session");
    setSessionInfo(oldSession, { sessionId: "ses-old", title: "旧会话", status: "ready" });

    await harness.channel.handleAction(
      connection,
      { action: "load_session", commandId: "cmd-1", sessionId: "ses-target" },
      createSinks(harness),
    );

    expect(harness.docManager.getChatYdoc("rcs-1")).not.toBe(oldChat);
    expect(harness.docManager.getSessionYdoc("rcs-1")).not.toBe(oldSession);
    expect(harness.syncCalls).toEqual(["ses-target"]);
    expect(connection.acpSessionId).toBe("ses-target");
    expect(relayMessages).toHaveLength(1);
    expect(relayMessages[0]?.method).toBe("session/load");
    expect(relayMessages[0]?.params).toMatchObject({ sessionId: "ses-target" });
  });

  // 相同持久投影也不能证明新 runtime 已 load，必须重新等待 Agent 确认。
  test("first load confirms with Agent even when persisted timeline matches", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ acpSessionId: null, sessionLoaded: false });
    const persistedChat = (await harness.docManager.openChat("rcs-1")).ydoc;
    const persistedSession = (await harness.docManager.openSession("user-1", "agent-1", "rcs-1")).ydoc;
    await harness.docManager.registerUserMessage("rcs-1", "message from the persisted session");
    setSessionInfo(persistedSession, { sessionId: "ses-target", title: "已恢复会话", status: "ready" });

    await harness.channel.handleAction(
      connection,
      { action: "load_session", commandId: "cmd-1", sessionId: "ses-target" },
      createSinks(harness),
    );

    expect(harness.docManager.getChatYdoc("rcs-1")).not.toBe(persistedChat);
    expect(harness.docManager.getSessionYdoc("rcs-1")).not.toBe(persistedSession);
    expect(harness.syncCalls).toEqual(["ses-target"]);
    expect(connection.acpSessionId).toBe("ses-target");
    expect(relayMessages).toHaveLength(1);
  });

  // 同一 ACP session 重复 load：静默跳过（不转发 relay、不清空 Doc、不发快照）。
  test("skips load_session for the already-active session", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({
      acpSessionId: "ses-1",
      sessionLoaded: true,
    });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      { action: "load_session", commandId: "cmd-1", sessionId: "ses-1" },
      sinks,
    );

    expect(harness.acks.map((a) => a.status)).toEqual(["accepted", "committed"]);
    // 旧「清空快照持久化」端口（prepareClearSessionSnapshot）已随换代口径删除，此处只保留
    // 可观察的外部行为：既有的 acpSessionId 一致时既不转发 relay 也不重放清理。
    expect(relayMessages).toHaveLength(0);
  });

  // create_session：转发 session/new，cwd 服务端注入。
  test("create_session forwards session/new with server-injected cwd", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection();
    await harness.docManager.openChat("rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(connection, { action: "create_session", commandId: "cmd-1" }, sinks);

    expect(relayMessages).toHaveLength(1);
    expect(relayMessages[0]?.method).toBe("session/new");
    expect(relayMessages[0]?.params).toEqual({ cwd: "/workspace/org-1/user-1/env-1" });
  });

  // Agent status 未到达时 list_sessions 守卫：不转发 relay（静默跳过，仍返回 committed）。
  test("gates list_sessions until agent status arrives", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ agentStatusReceived: false });
    await harness.docManager.openChat("rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(connection, { action: "list_sessions", commandId: "cmd-1" }, sinks);

    expect(relayMessages).toHaveLength(0);
    expect(harness.acks.map((a) => a.status)).toEqual(["accepted", "committed"]);
  });
});
