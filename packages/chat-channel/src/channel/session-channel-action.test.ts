// packages/chat-channel/src/channel/session-channel-action.test.ts
// SessionChannel 协议层集成测试（Q12 测试 seam）：
// Action → Ack → Y.Doc 投影全链路，无真实网络、无真实 Agent。
// 覆盖：两阶段 Ack、commandId 幂等全链路、load_session 守卫与 cwd 服务端注入、
// list_sessions 状态门禁、cancel 终态、非法会话/状态稳定错误码。

import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { getAgentStatus, getChatRoot, getEntriesMap, getSessionInfo } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { SessionChannel, type SessionChannelDependencies, type SessionConnection } from "./index";
import type { ActionAck, ActionError } from "./types";

interface TestHarness {
  channel: SessionChannel;
  docManager: DocManager;
  prepareCalls: number;
  syncCalls: string[];
  errors: Array<{ message: string; error: unknown }>;
  acks: ActionAck[];
  errorFrames: ActionError[];
}

function createHarness(overrides: Partial<SessionChannelDependencies> = {}): TestHarness {
  const state = {
    prepareCalls: 0,
    syncCalls: [] as string[],
    errors: [] as Array<{ message: string; error: unknown }>,
    acks: [] as ActionAck[],
    errorFrames: [] as ActionError[],
  };
  const docManager = new DocManager({ onError: () => {}, onLog: () => {} });
  const channel = new SessionChannel({
    docManager,
    prepareClearSessionSnapshot: async () => {
      state.prepareCalls += 1;
    },
    syncSessionId: (_connection, newSessionId) => {
      state.syncCalls.push(newSessionId);
    },
    reportError: (message, error) => {
      state.errors.push({ message, error });
    },
    ...overrides,
  });
  // prepareCalls 用 getter 返回实时值：spread 会拷贝原始值导致断言读到 0
  return {
    channel,
    docManager,
    get prepareCalls() {
      return state.prepareCalls;
    },
    syncCalls: state.syncCalls,
    errors: state.errors,
    acks: state.acks,
    errorFrames: state.errorFrames,
  };
}

interface RelayRecord {
  jsonrpc: string;
  method: string;
  params: Record<string, unknown>;
}

function createConnection(overrides: Partial<SessionConnection> = {}): {
  connection: SessionConnection;
  relayMessages: RelayRecord[];
} {
  const relayMessages: RelayRecord[] = [];
  let nextRpcId = 0;
  const connection: SessionConnection = {
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    acpSessionId: null,
    agentStatusReceived: true,
    sessionLoaded: false,
    workspacePath: "/workspace/org-1/user-1/env-1",
    lastClientKeepalive: 0,
    sendToRelay: (message) => {
      const record = message as unknown as RelayRecord;
      relayMessages.push(record);
    },
    getNextRpcId: () => ++nextRpcId,
    ...overrides,
  };
  return { connection, relayMessages };
}

function createSinks(harness: TestHarness): {
  sendAck: (ack: ActionAck) => void;
  sendError: (err: ActionError) => void;
} {
  return {
    sendAck: (ack) => harness.acks.push(ack),
    sendError: (err) => harness.errorFrames.push(err),
  };
}

/** 断言用户消息已投影为 user entry（时间线在 Chat Doc） */
function readEntryIds(ydoc: Y.Doc): string[] {
  return Array.from(getEntriesMap(ydoc).keys()).sort();
}

describe("SessionChannel action flow", () => {
  // send_prompt 全链路：accepted → committed（含 turnId 与投影版本），用户消息进入 Chat Doc 时间线。
  test("send_prompt commits a user entry and forwards session/prompt to relay", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection();
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "hello" }] },
      sinks,
    );

    expect(harness.acks.map((a) => a.status)).toEqual(["accepted", "committed"]);
    const committed = harness.acks[1];
    expect(committed?.turnId).toBeTruthy();
    expect(committed?.committedProjectionVersion).toBeGreaterThan(1);
    expect(relayMessages).toHaveLength(1);
    expect(relayMessages[0]?.method).toBe("session/prompt");
    // Chat Doc 投影：user_message 创建 user + assistant 两个 entry（时间线在 Chat Doc）
    const chatDoc = harness.docManager.getChatYdoc("rcs-1");
    expect(readEntryIds(chatDoc as Y.Doc)).toEqual([`${committed?.turnId}:assistant`, `${committed?.turnId}:user`]);
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
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "hello" }] },
      first,
    );
    await harness.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "hello" }] },
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
      code: "INVALID_STATE",
      retryable: false,
    });
    expect(relayMessages).toHaveLength(0);
  });

  // load_session 合法：先清空两份 Doc（快照 + clear），再转发 session/load（cwd 服务端注入）。
  test("load_session clears docs and forwards session/load with server-injected cwd", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ acpSessionId: "ses-old" });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      { action: "load_session", commandId: "cmd-1", sessionId: "ses-new" },
      sinks,
    );

    expect(harness.acks.map((a) => a.status)).toEqual(["accepted", "committed"]);
    expect(harness.prepareCalls).toBe(1);
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

  // 同一 ACP session 重复 load：静默跳过（不转发 relay、不清空 Doc、不发快照）。
  test("skips load_session for the already-active session", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ acpSessionId: "ses-1", sessionLoaded: true });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      { action: "load_session", commandId: "cmd-1", sessionId: "ses-1" },
      sinks,
    );

    expect(harness.acks.map((a) => a.status)).toEqual(["accepted", "committed"]);
    expect(harness.prepareCalls).toBe(0);
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

  // cancel：转发 session/cancel，turn 先进入 cancelling 中间态（非终态），
  // Agent 确认取消（turn_cancelled 规范化事件）后收敛为 cancelled 终态。
  test("cancel forwards session/cancel and converges to cancelled after agent confirmation", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ acpSessionId: "ses-1" });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    // 先发一条消息创建活动 turn，再取消
    await harness.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "hi" }] },
      createSinks(harness),
    );
    await harness.channel.handleAction(connection, { action: "cancel", commandId: "cmd-2" }, sinks);

    expect(relayMessages.map((m) => m.method)).toEqual(["session/prompt", "session/cancel"]);
    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1");
    // 取消请求落地为 cancelling（非终态，晚到增量自此丢弃）
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("cancelling");

    // Agent 确认取消（acp-link 取消后回 prompt_complete { stopReason: "cancelled" }）
    harness.docManager.processNormalizedEvent("rcs-1", {
      type: "turn_cancelled",
      update: { stopReason: "cancelled" },
      content: null,
    });
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("cancelled");
  });

  // 未绑定任何连接的 rcsSessionId：validateAction 拒绝（SESSION_NOT_FOUND），不发 accepted。
  test("rejects actions for unknown sessions with SESSION_NOT_FOUND", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ rcsSessionId: "rcs-ghost" });
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "hi" }] },
      sinks,
    );

    expect(harness.acks).toHaveLength(0);
    expect(harness.errorFrames[0]).toMatchObject({ code: "SESSION_NOT_FOUND", retryable: false });
    expect(relayMessages).toHaveLength(0);
  });

  // relay 发送失败：返回 AGENT_UNAVAILABLE（retryable），不进入 cancelling、不产生 committed。
  test("maps relay send failure to retryable AGENT_UNAVAILABLE", async () => {
    const harness = createHarness();
    const { connection } = createConnection();
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const failing = { ...connection, sendToRelay: () => Promise.reject(new Error("relay closed")) };
    const sinks = createSinks(harness);

    await harness.channel.handleAction(failing, { action: "cancel", commandId: "cmd-1" }, sinks);

    expect(harness.acks.map((a) => a.status)).toEqual(["accepted"]);
    expect(harness.errorFrames[0]).toMatchObject({ code: "AGENT_UNAVAILABLE", retryable: true });
    expect(harness.errors).toHaveLength(1);
  });

  // 快照准备失败（Redis 不可用）：保留旧会话绑定，返回稳定错误且不转发 relay。
  test("keeps old session binding when snapshot preparation rejects", async () => {
    const harness = createHarness({
      prepareClearSessionSnapshot: async () => {
        throw new Error("Redis unavailable");
      },
    });
    const { connection, relayMessages } = createConnection({ acpSessionId: "ses-old" });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      { action: "load_session", commandId: "cmd-1", sessionId: "ses-new" },
      sinks,
    );

    expect(connection.acpSessionId).toBe("ses-old");
    expect(relayMessages).toHaveLength(0);
    expect(harness.acks.map((a) => a.status)).toEqual(["accepted"]);
    expect(harness.errorFrames[0]?.retryable).toBe(true);
    expect(harness.errorFrames[0]?.code).toBe("AGENT_UNAVAILABLE");
  });
});

describe("SessionChannel doc projection", () => {
  // send_prompt 后 Chat Doc 投影用户消息；disposeRcsSession 后同 commandId 重发重新执行。
  test("disposeRcsSession releases dedup state so resubmission re-executes", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection();
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");

    await harness.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "first" }] },
      createSinks(harness),
    );
    expect(relayMessages).toHaveLength(1);

    harness.channel.disposeRcsSession("rcs-1");
    await harness.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "again" }] },
      createSinks(harness),
    );

    expect(relayMessages).toHaveLength(2);
    // 新 turn：时间线新增 user + assistant 各一条（共 4 个 entry）
    expect(readEntryIds(harness.docManager.getChatYdoc("rcs-1") as Y.Doc)).toHaveLength(4);
  });

  // agent status 消息经规范化事件投影到 Session Doc（agent.status ready）。
  test("agent status is projected to session doc via normalized event", async () => {
    const harness = createHarness();
    const { connection } = createConnection();
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");

    harness.docManager.processNormalizedEvent("rcs-1", {
      type: "agent_status",
      update: { instanceId: "instance-1", status: "ready", capabilities: { loadSession: true } },
      content: null,
    });

    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1");
    expect(getAgentStatus(sessionDoc as Y.Doc).get("status")).toBe("ready");
    expect(getChatRoot(harness.docManager.getChatYdoc("rcs-1") as Y.Doc).get("projectionVersion")).toBeGreaterThan(1);
    void connection;
  });
});
