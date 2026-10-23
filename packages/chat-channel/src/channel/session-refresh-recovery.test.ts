import { expect, test } from "bun:test";
import { setSessionInfo } from "../state/chat-writer";
import { createConnection, createHarness, createSinks } from "./session-channel-action-test-helpers";

const continuity = {};

/** 建立真正收到加载回执的会话，随后用新连接模拟页面刷新。 */
async function confirmedSession() {
  const harness = createHarness();
  await harness.docManager.openChat("rcs-1");
  await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
  const { connection } = createConnection({
    acpSessionId: null,
    sessionLoaded: false,
    runtimeIdentity: "epoch-1:1",
    getSessionContinuity: () => continuity,
  });
  await harness.channel.handleAction(
    connection,
    { action: "load_session", sessionId: "ses-active", commandId: "initial-load" },
    createSinks(harness),
  );
  // 生产回执处理器会在确认时写入 Session Doc；此处只替代外部 Agent 的响应。
  setSessionInfo(harness.docManager.getSessionYdoc("rcs-1")!, { sessionId: "ses-active" });
  await harness.docManager.registerUserMessage("rcs-1", "正在回复的问题");
  harness.channel.disposeRcsSession("rcs-1");
  return harness;
}

// 刷新后重复加载同一运行代次的会话不得清空消息或触发忙碌 Agent 的加载拒绝。
test("refresh restores confirmed session without loading the busy Agent", async () => {
  const harness = await confirmedSession();
  const chat = harness.docManager.getChatYdoc("rcs-1");
  const { connection, relayMessages } = createConnection({
    acpSessionId: "ses-active",
    sessionLoaded: false,
    runtimeIdentity: "epoch-1:1",
    getSessionContinuity: () => continuity,
    awaitSessionMutation: () => ({ completed: Promise.resolve(false), cancel() {} }),
  });
  try {
    for (const commandId of ["refresh-1", "refresh-2"]) {
      await harness.channel.handleAction(
        connection,
        { action: "load_session", sessionId: "ses-active", commandId },
        createSinks(harness),
      );
      expect(harness.errorFrames).toEqual([]);
      expect(harness.docManager.getChatYdoc("rcs-1")).toBe(chat);
      expect(relayMessages).toEqual([]);
      expect(connection.sessionLoaded).toBe(true);
      harness.channel.disposeRcsSession("rcs-1");
      connection.sessionLoaded = false;
    }
    await harness.channel.handleAction(
      connection,
      { action: "load_session", sessionId: "ses-active", commandId: "refresh-final" },
      createSinks(harness),
    );
    await harness.channel.handleAction(
      connection,
      {
        action: "send_prompt",
        sessionId: "ses-active",
        commandId: "next-prompt",
        content: [{ type: "text", text: "继续" }],
      },
      createSinks(harness),
    );
    expect(relayMessages.map((rpc) => rpc.method)).toEqual(["session/prompt"]);
    expect(relayMessages[0]?.params.sessionId).toBe("ses-active");
  } finally {
    harness.channel.disposeRcsSession("rcs-1");
    await harness.docManager.closeAll();
  }
});

// 运行代次、主服务代次、属主、实例或会话不匹配时必须重新得到 Agent 确认。
test.each([
  { runtimeIdentity: "epoch-1:2" },
  { runtimeIdentity: "epoch-2:1" },
  { runtimeIdentity: undefined },
  { userId: "another-user" },
  { instanceId: "another-instance" },
  { acpSessionId: "ses-other" },
])("refresh does not trust mismatched runtime or scope: %j", async (changed) => {
  const harness = await confirmedSession();
  const chat = harness.docManager.getChatYdoc("rcs-1");
  const { connection, relayMessages } = createConnection({
    acpSessionId: "ses-active",
    sessionLoaded: false,
    runtimeIdentity: "epoch-1:1",
    getSessionContinuity: () => continuity,
    ...changed,
  });
  try {
    await harness.channel.handleAction(
      connection,
      { action: "load_session", sessionId: connection.acpSessionId, commandId: "fresh-load" },
      createSinks(harness),
    );
    expect(relayMessages.map((rpc) => rpc.method)).toEqual(["session/load"]);
    expect(harness.docManager.getChatYdoc("rcs-1")).not.toBe(chat);
  } finally {
    harness.channel.disposeRcsSession("rcs-1");
    await harness.docManager.closeAll();
  }
});

// 换代或销毁后重新打开的持久投影不能继承旧内存确认。
test("recreated projection requires load even when the session and runtime match", async () => {
  const harness = await confirmedSession();
  await harness.docManager.closeAll();
  await harness.docManager.openChat("rcs-1");
  const doc = await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
  setSessionInfo(doc.ydoc, { sessionId: "ses-active" });
  const { connection, relayMessages } = createConnection({
    acpSessionId: "ses-active",
    sessionLoaded: false,
    runtimeIdentity: "epoch-1:1",
    getSessionContinuity: () => continuity,
  });
  try {
    await harness.channel.handleAction(
      connection,
      { action: "load_session", sessionId: "ses-active", commandId: "recreated-load" },
      createSinks(harness),
    );
    expect(relayMessages.map((rpc) => rpc.method)).toEqual(["session/load"]);
  } finally {
    harness.channel.disposeRcsSession("rcs-1");
    await harness.docManager.closeAll();
  }
});

// Agent 断连必须作废确认，不能按普通页面刷新继续信任旧会话。
test("Agent disconnect invalidates the proof retained for page refresh", async () => {
  const harness = await confirmedSession();
  const { connection, relayMessages } = createConnection({
    acpSessionId: "ses-active",
    sessionLoaded: false,
    runtimeIdentity: "epoch-1:1",
    getSessionContinuity: () => continuity,
  });
  harness.channel.invalidateRuntimeSession("rcs-1");
  try {
    await harness.channel.handleAction(
      connection,
      { action: "load_session", sessionId: "ses-active", commandId: "after-agent-disconnect" },
      createSinks(harness),
    );
    expect(relayMessages.map((rpc) => rpc.method)).toEqual(["session/load"]);
  } finally {
    harness.channel.disposeRcsSession("rcs-1");
    await harness.docManager.closeAll();
  }
});

// create_session 的成功回执与 load_session 一样，应允许新会话在回复期间刷新。
test("refresh also restores a session confirmed by creation", async () => {
  const harness = createHarness();
  await harness.docManager.openChat("rcs-1");
  await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
  const { connection } = createConnection({
    acpSessionId: null,
    sessionLoaded: false,
    runtimeIdentity: "epoch-1:1",
    getSessionContinuity: () => continuity,
    awaitSessionCreation: () => ({ completed: Promise.resolve("ses-created"), cancel() {} }),
  });
  try {
    await harness.channel.handleAction(
      connection,
      { action: "create_session", commandId: "create" },
      createSinks(harness),
    );
    setSessionInfo(harness.docManager.getSessionYdoc("rcs-1")!, { sessionId: "ses-created" });
    const original = harness.docManager.getChatYdoc("rcs-1");
    harness.channel.disposeRcsSession("rcs-1");
    const fresh = createConnection({
      acpSessionId: "ses-created",
      sessionLoaded: false,
      runtimeIdentity: "epoch-1:1",
      getSessionContinuity: () => continuity,
    });
    await harness.channel.handleAction(
      fresh.connection,
      { action: "load_session", sessionId: "ses-created", commandId: "restore-created" },
      createSinks(harness),
    );
    expect(fresh.relayMessages).toEqual([]);
    expect(harness.docManager.getChatYdoc("rcs-1")).toBe(original);
    expect(fresh.connection.sessionLoaded).toBe(true);
  } finally {
    harness.channel.disposeRcsSession("rcs-1");
    await harness.docManager.closeAll();
  }
});
