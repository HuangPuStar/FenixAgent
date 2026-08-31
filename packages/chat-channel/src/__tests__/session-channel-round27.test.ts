// packages/chat-channel/src/__tests__/session-channel-round27.test.ts
// SessionChannel 的内存边界测试：不启动 WebSocket、Redis 或 Agent 进程。

import { describe, expect, test } from "bun:test";
import { createTestRpcReservationFactory, type TestRpcReservation } from "../channel/connection-test-helpers";
import { SessionChannel, type SessionConnection } from "../channel/session-channel";
import type { ActionAck, ActionError } from "../channel/types";
import { getSessionInfo } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";

interface Harness {
  channel: SessionChannel;
  manager: DocManager;
  connection: SessionConnection;
  sent: Record<string, unknown>[];
  acks: ActionAck[];
  errors: ActionError[];
  replacements: number[];
  synced: Array<string | null>;
  reservations: TestRpcReservation[];
  reports: Array<{ message: string; error: unknown }>;
}

async function createHarness(overrides: Partial<SessionConnection> = {}): Promise<Harness> {
  const manager = new DocManager({ acpBatchWindowMs: 0 });
  await manager.openChat("rcs-1");
  await manager.openSession("user-1", "agent-1", "rcs-1");
  const sent: Record<string, unknown>[] = [];
  const acks: ActionAck[] = [];
  const errors: ActionError[] = [];
  const replacements: number[] = [];
  const synced: Array<string | null> = [];
  const reports: Array<{ message: string; error: unknown }> = [];
  const reserveRpc = createTestRpcReservationFactory();
  const connection: SessionConnection = {
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    acpSessionId: "ses-1",
    agentStatusReceived: true,
    sessionLoaded: false,
    workspacePath: "/trusted-workspace",
    sendToRelay: (message) => {
      sent.push(message);
    },
    reserveRpc,
    ...overrides,
  };
  const channel = new SessionChannel({
    docManager: manager,
    replaceProjection: () => replacements.push(1),
    syncSessionId: (_connection, sessionId) => synced.push(sessionId),
    reportError: (message, error) => reports.push({ message, error }),
  });
  return {
    channel,
    manager,
    connection,
    sent,
    acks,
    errors,
    replacements,
    synced,
    reservations: reserveRpc.reservations,
    reports,
  };
}

async function commitSessionSync(harness: Harness, sessionId: string): Promise<void> {
  const reservation = harness.reservations.at(-1);
  if (!reservation || reservation.owner.kind !== "session-sync") {
    throw new Error("expected a session-sync reservation");
  }
  const committed = await reservation.owner.lifecycle.commit({ sessionId }, () => !reservation.aborted);
  if (!committed) throw new Error(`expected session-sync commit for ${sessionId}`);
}

async function submit(harness: Harness, action: Record<string, unknown>): Promise<void> {
  await harness.channel.handleAction(harness.connection, action, {
    sendAck: (ack) => harness.acks.push(ack),
    sendError: (error) => harness.errors.push(error),
  });
}

function committed(harness: Harness): ActionAck | undefined {
  return harness.acks.find((ack) => ack.status === "committed");
}

describe("SessionChannel 内存协议与状态边界", () => {
  // send_prompt 必须绑定服务端会话，而不能信任浏览器提供的 sessionId。
  test("send_prompt 使用绑定的 sessionId", async () => {
    const harness = await createHarness();
    await submit(harness, {
      action: "send_prompt",
      commandId: "prompt-1",
      content: [{ type: "text", text: "你好" }],
      sessionId: "untrusted",
    });
    expect(harness.sent[0]).toMatchObject({ method: "session/prompt", params: { sessionId: "ses-1" } });
    expect(committed(harness)?.turnId).toBeDefined();
  });

  // send_prompt 的空内容仍转发协议请求，但不创建用户 turn。
  test("send_prompt 空内容不创建 turn", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "send_prompt", commandId: "prompt-empty", content: [] });
    expect(harness.sent[0]).toMatchObject({ method: "session/prompt" });
    expect(committed(harness)?.turnId).toBeUndefined();
  });

  // cancel 必须转成精确的 session/cancel RPC。
  test("cancel 转发绑定会话的 RPC", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "cancel", commandId: "cancel-1" });
    expect(harness.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session/cancel",
      params: { sessionId: "ses-1" },
    });
  });

  // create_session 必须使用认证后的 workspace。
  test("create_session 注入可信 workspace", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "create_session", commandId: "create-1", cwd: "/untrusted" });
    await commitSessionSync(harness, "ses-created");
    expect(harness.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/trusted-workspace" },
    });
    expect(harness.replacements).toHaveLength(1);
  });

  // list_sessions 在 Agent 未就绪时静默跳过。
  test("list_sessions 在未收到状态前不转发", async () => {
    const harness = await createHarness({ agentStatusReceived: false });
    await submit(harness, { action: "list_sessions", commandId: "list-pending" });
    expect(harness.sent).toEqual([]);
    expect(committed(harness)).toBeDefined();
  });

  // list_sessions 在 Agent 就绪后使用可信 workspace。
  test("list_sessions 在就绪后转发", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "list_sessions", commandId: "list-ready" });
    expect(harness.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session/list",
      params: { cwd: "/trusted-workspace" },
    });
  });

  // resume_session 必须登记且转发指定 session。
  test("resume_session 转发指定会话", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "resume_session", commandId: "resume-1", sessionId: "ses-old" });
    expect(harness.sent[0]).toMatchObject({
      method: "session/resume",
      params: { sessionId: "ses-old", cwd: "/trusted-workspace" },
    });
    expect(harness.reservations).toHaveLength(1);
    expect(harness.reservations[0]?.id).toBe(1);
    expect(harness.reservations[0]?.owner.kind).toBe("session-sync");
  });

  // rename_session 保留标题并绑定传入会话。
  test("rename_session 转发标题", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "rename_session", commandId: "rename-1", sessionId: "ses-2", title: "新标题" });
    expect(harness.sent[0]).toMatchObject({
      method: "session/rename",
      params: { sessionId: "ses-2", title: "新标题" },
    });
  });

  // delete_session 转发目标会话。
  test("delete_session 转发目标会话", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "delete_session", commandId: "delete-1", sessionId: "ses-2" });
    expect(harness.sent[0]).toMatchObject({ method: "session/delete", params: { sessionId: "ses-2" } });
  });

  // set_session_mode 转发模式字段。
  test("set_session_mode 转发模式", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "set_session_mode", commandId: "mode-1", sessionId: "ses-2", modeId: "plan" });
    expect(harness.sent[0]).toMatchObject({ method: "session/setMode", params: { modeId: "plan" } });
  });

  // load_session 缺失 sessionId 必须在 accepted 前拒绝。
  test("load_session 缺失 sessionId 返回 INVALID_STATE", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "load_session", commandId: "load-invalid" });
    expect(harness.acks).toEqual([]);
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.INVALID_STATE" } }]);
  });

  // 同一 ACP 会话重复 load 必须避免重复 RPC。
  test("load_session 同会话幂等跳过", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "load_session", commandId: "load-same", sessionId: "ses-1" });
    expect(harness.sent).toEqual([]);
    expect(harness.replacements).toEqual([]);
  });

  // 新会话 load 必须替换投影并同步绑定。
  test("load_session 新会话替换投影并同步", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "load_session", commandId: "load-new", sessionId: "ses-2" });
    await commitSessionSync(harness, "ses-2");
    expect(harness.replacements).toHaveLength(1);
    expect(harness.synced).toEqual(["ses-2"]);
    expect(harness.reservations).toHaveLength(1);
    expect(harness.reservations[0]?.id).toBe(1);
    expect(harness.reservations[0]?.owner.kind).toBe("session-sync");
    expect(harness.sent[0]).toMatchObject({
      method: "session/load",
      params: { sessionId: "ses-2", cwd: "/trusted-workspace" },
    });
  });

  // commandId 重放必须返回 duplicate 且不重复发送。
  test("已提交 commandId 重放不重复转发", async () => {
    const harness = await createHarness();
    const action = { action: "list_sessions", commandId: "dedup-1" };
    await submit(harness, action);
    await submit(harness, action);
    expect(harness.sent).toHaveLength(1);
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed", "duplicate"]);
  });

  // 不同 commandId 允许独立执行。
  test("不同 commandId 分别转发", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "list_sessions", commandId: "distinct-1" });
    await submit(harness, { action: "list_sessions", commandId: "distinct-2" });
    expect(harness.sent).toHaveLength(2);
  });

  // 无 action 的畸形输入不得越过协议形状校验。
  test("缺失 action 返回 INVALID_STATE", async () => {
    const harness = await createHarness();
    await submit(harness, { commandId: "missing-action" });
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.INVALID_STATE" } }]);
  });

  // 未知 action 不得转发到 relay。
  test("未知 action 返回 INVALID_STATE", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "unknown", commandId: "unknown-1" });
    expect(harness.sent).toEqual([]);
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.INVALID_STATE" } }]);
  });

  // 非字符串 commandId 必须被协议校验拒绝。
  test("非字符串 commandId 返回 INVALID_STATE", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "list_sessions", commandId: 1 });
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.INVALID_STATE" } }]);
  });

  // 过期投影版本必须拒绝，避免旧客户端覆盖新状态。
  test("过期投影版本返回 VERSION_CONFLICT", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "list_sessions", commandId: "version-old", expectedProjectionVersion: -1 });
    expect(harness.sent).toEqual([]);
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.VERSION_CONFLICT" } }]);
  });

  // 正确投影版本仍可提交命令。
  test("当前投影版本允许提交", async () => {
    const harness = await createHarness();
    const projectionVersion = harness.manager.getChatYdoc("rcs-1")?.getMap("root").get("projectionVersion");
    await submit(harness, {
      action: "list_sessions",
      commandId: "version-current",
      expectedProjectionVersion: projectionVersion,
    });
    expect(harness.errors).toEqual([]);
    expect(harness.sent).toHaveLength(1);
  });

  // relay 抛错必须转换为脱敏且可重试的错误。
  test("relay 发送失败返回 AGENT_UNAVAILABLE", async () => {
    const harness = await createHarness({ sendToRelay: () => Promise.reject(new Error("private relay detail")) });
    await submit(harness, { action: "list_sessions", commandId: "relay-fail" });
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.AGENT_UNAVAILABLE" } }]);
    expect(harness.reports[0]?.message).toContain("relay send failed");
  });

  // 失败 commandId 不能永久占用去重表。
  test("relay 失败后同 commandId 可以重试", async () => {
    let fail = true;
    const sent: Record<string, unknown>[] = [];
    const harness = await createHarness({
      sendToRelay: (message) => {
        if (fail) return Promise.reject(new Error("offline"));
        sent.push(message);
      },
    });
    await submit(harness, { action: "list_sessions", commandId: "retry-after-fail" });
    fail = false;
    await submit(harness, { action: "list_sessions", commandId: "retry-after-fail" });
    expect(sent).toHaveLength(1);
    expect(committed(harness)).toBeDefined();
  });

  // create_session 环境刷新失败必须不替换投影也不发送 RPC。
  test("环境刷新失败返回 AGENT_UNAVAILABLE", async () => {
    const manager = new DocManager({ acpBatchWindowMs: 0 });
    await manager.openChat("rcs-1");
    await manager.openSession("user-1", "agent-1", "rcs-1");
    const errors: ActionError[] = [];
    const channel = new SessionChannel({
      docManager: manager,
      refreshInstanceEnvironment: () => Promise.reject(new Error("refresh failed")),
      replaceProjection() {},
      syncSessionId() {},
      reportError() {},
    });
    const harness = await createHarness();
    await channel.handleAction(
      harness.connection,
      { action: "create_session", commandId: "refresh-fail" },
      { sendAck: (ack) => harness.acks.push(ack), sendError: (error) => errors.push(error) },
    );
    expect(errors).toMatchObject([{ error: { type: "ACTION.AGENT_UNAVAILABLE" } }]);
  });

  // prompt 注册必须记录 RPC 与创建的 turnId。
  test("send_prompt 登记待决 prompt", async () => {
    const harness = await createHarness();
    await submit(harness, {
      action: "send_prompt",
      commandId: "pending-prompt",
      content: [{ type: "text", text: "记录" }],
    });
    expect(harness.reservations).toHaveLength(1);
    expect(harness.reservations[0]?.id).toBe(1);
    const owner = harness.reservations[0]?.owner;
    expect(owner?.kind).toBe("prompt");
    expect(owner?.kind === "prompt" ? owner.turnId : undefined).toBe(committed(harness)?.turnId);
  });

  // prompt 登记必须先于 relay send，以覆盖 send 内同步回送 JSON-RPC 响应的 transport。
  test("send_prompt 在 relay 发送前登记所有权", async () => {
    let registered = false;
    let consumed = false;
    const reserveRpc = createTestRpcReservationFactory();
    const harness = await createHarness({
      reserveRpc: (owner) => {
        registered = true;
        return reserveRpc(owner);
      },
      sendToRelay: () => {
        expect(registered).toBe(true);
        registered = false;
        consumed = true;
      },
    });

    await submit(harness, {
      action: "send_prompt",
      commandId: "sync-prompt",
      content: [{ type: "text", text: "同步响应" }],
    });

    expect(consumed).toBe(true);
    expect(registered).toBe(false);
    expect(reserveRpc.reservations[0]?.owner.kind).toBe("prompt");
    expect(committed(harness)?.turnId).toBeDefined();
  });

  // prompt relay send 抛错时必须撤销所有权登记并只把该 prompt 的 turn 收敛为失败。
  test("send_prompt 发送失败回滚登记并收敛所属 turn", async () => {
    const reserveRpc = createTestRpcReservationFactory();
    const harness = await createHarness({
      reserveRpc,
      sendToRelay: () => {
        expect(reserveRpc.reservations[0]?.owner.kind).toBe("prompt");
        expect(reserveRpc.reservations[0]?.aborted).toBe(false);
        throw new Error("private relay detail");
      },
    });

    await submit(harness, {
      action: "send_prompt",
      commandId: "prompt-send-fail",
      content: [{ type: "text", text: "任务" }],
    });

    expect(reserveRpc.reservations[0]?.aborted).toBe(true);
    expect(getSessionInfo(harness.manager.getSessionYdoc("rcs-1")!).get("activeTurnStatus")).toBe("failed");
    expect(harness.errors).toMatchObject([{ code: "AGENT_UNAVAILABLE", retryable: true }]);
  });

  // cancel relay send 抛错时必须撤销该请求的 turn 所有权，且未发出的取消不能改变活动 turn。
  test("cancel 发送失败回滚登记且不取消活动 turn", async () => {
    const reserveRpc = createTestRpcReservationFactory();
    const harness = await createHarness({
      reserveRpc,
      sendToRelay: (message) => {
        if (message.method === "session/cancel") {
          const cancelReservation = reserveRpc.reservations.at(-1);
          expect(cancelReservation?.owner.kind).toBe("cancel");
          expect(cancelReservation?.aborted).toBe(false);
          throw new Error("private cancel detail");
        }
        harness.sent.push(message);
      },
    });
    await submit(harness, {
      action: "send_prompt",
      commandId: "before-cancel-fail",
      content: [{ type: "text", text: "任务" }],
    });
    const turnId = getSessionInfo(harness.manager.getSessionYdoc("rcs-1")!).get("activeTurnId");

    await submit(harness, { action: "cancel", commandId: "cancel-send-fail" });

    const sessionInfo = getSessionInfo(harness.manager.getSessionYdoc("rcs-1")!);
    const cancelReservation = reserveRpc.reservations.at(-1);
    expect(cancelReservation?.owner.kind).toBe("cancel");
    expect(cancelReservation?.aborted).toBe(true);
    expect(sessionInfo.get("activeTurnId")).toBe(turnId);
    expect(sessionInfo.get("activeTurnStatus")).toBe("accepting");
    expect(harness.errors).toMatchObject([{ code: "AGENT_UNAVAILABLE", retryable: true }]);
  });

  // cancel 在活动 turn 上应进入 cancelling 状态。
  test("cancel 将活动 turn 标记为 cancelling", async () => {
    const harness = await createHarness();
    await submit(harness, {
      action: "send_prompt",
      commandId: "turn-before-cancel",
      content: [{ type: "text", text: "任务" }],
    });
    await submit(harness, { action: "cancel", commandId: "cancel-active" });
    expect(getSessionInfo(harness.manager.getSessionYdoc("rcs-1")!).get("activeTurnStatus")).toBe("cancelling");
  });

  // dispose 后必须释放去重状态，后继连接可以使用相同 commandId。
  test("disposeRcsSession 后释放 commandId 去重状态", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "list_sessions", commandId: "after-dispose" });
    harness.channel.disposeRcsSession("rcs-1");
    await submit(harness, { action: "list_sessions", commandId: "after-dispose" });
    expect(harness.sent).toHaveLength(2);
    expect(harness.acks.at(-1)?.status).toBe("committed");
  });

  // 不同 RCS session 的去重表必须相互隔离。
  test("不同 RCS session 隔离 commandId", async () => {
    const first = await createHarness();
    const second = await createHarness({ rcsSessionId: "rcs-2" });
    await second.manager.openChat("rcs-2");
    await second.manager.openSession("user-1", "agent-1", "rcs-2");
    await submit(first, { action: "list_sessions", commandId: "shared-id" });
    await submit(second, { action: "list_sessions", commandId: "shared-id" });
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
  });

  // 同一会话下不带 commandId 的请求会被稳定拒绝。
  test("缺失 commandId 返回 INVALID_STATE", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "list_sessions" });
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.INVALID_STATE" } }]);
  });

  // protocolVersion 与 client 是信封字段，不能污染发给 ACP 的 payload。
  test("协议信封字段不会进入 RPC 参数", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "list_sessions", commandId: "envelope", protocolVersion: 2, client: "browser" });
    expect(harness.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session/list",
      params: { cwd: "/trusted-workspace" },
    });
  });

  // create_session 刷新成功后必须只执行一次刷新。
  test("create_session 在替换前刷新环境", async () => {
    const manager = new DocManager({ acpBatchWindowMs: 0 });
    await manager.openChat("rcs-1");
    await manager.openSession("user-1", "agent-1", "rcs-1");
    const order: string[] = [];
    const channel = new SessionChannel({
      docManager: manager,
      refreshInstanceEnvironment: async () => {
        order.push("refresh");
      },
      replaceProjection: () => order.push("replace"),
      syncSessionId() {},
      reportError() {},
    });
    const harness = await createHarness();
    await channel.handleAction(
      harness.connection,
      { action: "create_session", commandId: "refresh-success" },
      { sendAck: (ack) => harness.acks.push(ack), sendError: (error) => harness.errors.push(error) },
    );
    await commitSessionSync(harness, "ses-created");
    expect(order).toEqual(["refresh", "replace"]);
  });

  // load_session 完成后，后续 prompt 必须改用新的服务端绑定。
  test("load_session 更新后续 prompt 的绑定会话", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "load_session", commandId: "switch", sessionId: "ses-2" });
    await commitSessionSync(harness, "ses-2");
    await submit(harness, {
      action: "send_prompt",
      commandId: "prompt-after-switch",
      content: [{ type: "text", text: "继续" }],
    });
    expect(harness.sent[1]).toMatchObject({ method: "session/prompt", params: { sessionId: "ses-2" } });
  });

  // load_session 被重复提交时同一个 commandId 仍保持去重。
  test("load_session 重放不重复替换投影", async () => {
    const harness = await createHarness();
    const action = { action: "load_session", commandId: "switch-once", sessionId: "ses-2" };
    await submit(harness, action);
    await commitSessionSync(harness, "ses-2");
    await submit(harness, action);
    expect(harness.replacements).toHaveLength(1);
    expect(harness.sent).toHaveLength(1);
  });

  // sessionLoaded 为 false 且投影不匹配时，首次 load 必须请求 Agent。
  test("首次 load 投影不匹配时转发给 Agent", async () => {
    const harness = await createHarness({ sessionLoaded: false });
    await submit(harness, { action: "load_session", commandId: "projection-mismatch", sessionId: "ses-3" });
    expect(harness.sent[0]).toMatchObject({ method: "session/load", params: { sessionId: "ses-3" } });
  });

  // 激活回调中后续步骤失败时，已修改的本地 binding 必须恢复且候选不得成为活动投影。
  test("会话激活中途失败时补偿 binding 并恢复旧投影", async () => {
    const manager = new DocManager({ acpBatchWindowMs: 0 });
    await manager.openChat("rcs-1");
    await manager.openSession("user-1", "agent-1", "rcs-1");
    const previousChat = manager.getChat("rcs-1");
    const previousSession = manager.getSession("rcs-1");
    const reserveRpc = createTestRpcReservationFactory();
    const connection: SessionConnection = {
      userId: "user-1",
      agentId: "agent-1",
      instanceId: "instance-1",
      rcsSessionId: "rcs-1",
      acpSessionId: "ses-old",
      agentStatusReceived: true,
      sessionLoaded: false,
      workspacePath: "/trusted-workspace",
      sendToRelay() {},
      reserveRpc,
    };
    const channel = new SessionChannel({
      docManager: manager,
      replaceProjection() {
        throw new Error("listener replacement failed");
      },
      syncSessionId() {},
      reportError() {},
    });

    await channel.handleAction(
      connection,
      { action: "load_session", commandId: "rollback-binding", sessionId: "ses-new" },
      { sendAck() {}, sendError() {} },
    );
    const reservation = reserveRpc.reservations[0];
    if (!reservation || reservation.owner.kind !== "session-sync") throw new Error("expected session sync");

    await expect(reservation.owner.lifecycle.commit({ sessionId: "ses-new" }, () => true)).rejects.toThrow(
      "listener replacement failed",
    );
    expect(connection.acpSessionId).toBe("ses-old");
    expect(connection.sessionLoaded).toBe(false);
    expect(manager.getChat("rcs-1")).toBe(previousChat);
    expect(manager.getSession("rcs-1")).toBe(previousSession);
    await manager.closeAll();
  });

  // session/new 响应前目标会话未知，任意 session-bound 事件必须忽略且不占用有界队列。
  test("create_session 在目标会话未知时忽略过渡事件", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "create_session", commandId: "create-ignore-events" });
    const reservation = harness.reservations.at(-1);
    if (!reservation || reservation.owner.kind !== "session-sync") throw new Error("expected session sync");

    for (let index = 0; index < 300; index += 1) {
      expect(
        reservation.owner.lifecycle.queueEvent({
          type: "session_updated",
          acpSessionId: `ses-unrelated-${index}`,
          update: { sessionId: `ses-unrelated-${index}`, title: "Unrelated" },
          content: null,
        }),
      ).toBe("ignored");
    }

    expect(await reservation.owner.lifecycle.commit({ sessionId: "ses-created" }, () => true)).toBe(true);
    expect(harness.replacements).toHaveLength(1);
  });

  // load_session 只允许目标 ACP session 的事件进入候选队列，缺失或错配 ID 必须忽略。
  test("load_session 只暂存精确匹配目标会话的事件", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "load_session", commandId: "load-filter-events", sessionId: "ses-target" });
    const reservation = harness.reservations.at(-1);
    if (!reservation || reservation.owner.kind !== "session-sync") throw new Error("expected session sync");

    expect(
      reservation.owner.lifecycle.queueEvent({
        type: "session_updated",
        update: { title: "Missing ID" },
        content: null,
      }),
    ).toBe("ignored");
    expect(
      reservation.owner.lifecycle.queueEvent({
        type: "session_updated",
        acpSessionId: "ses-other",
        update: { sessionId: "ses-other", title: "Other" },
        content: null,
      }),
    ).toBe("ignored");
    expect(
      reservation.owner.lifecycle.queueEvent({
        type: "session_updated",
        acpSessionId: "ses-target",
        update: { sessionId: "ses-target", title: "Target" },
        content: null,
      }),
    ).toBe("queued");

    expect(reservation.owner.lifecycle.drainEvents("ses-target")).toHaveLength(1);
    await reservation.owner.lifecycle.rollback();
  });

  // respond_permission 缺少 requestId 时仅确认，不可向 Agent 发送无效响应。
  test("respond_permission 缺少 requestId 时不转发", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "respond_permission", commandId: "permission-missing" });
    expect(harness.sent).toEqual([]);
    expect(committed(harness)).toBeDefined();
  });

  // respond_question 缺少 questionId 时仅确认，不可向 Agent 发送无效控制帧。
  test("respond_question 缺少 questionId 时不转发", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "respond_question", commandId: "question-missing" });
    expect(harness.sent).toEqual([]);
    expect(committed(harness)).toBeDefined();
  });

  // commandId 的去重仅在 dispose 前生效。
  test("dispose 后新 commandId 仍能正常提交", async () => {
    const harness = await createHarness();
    harness.channel.disposeRcsSession("rcs-1");
    await submit(harness, { action: "list_sessions", commandId: "new-after-dispose" });
    expect(harness.sent).toHaveLength(1);
    expect(harness.errors).toEqual([]);
  });

  // null workspace 是合法绑定，不能由浏览器的 cwd 覆盖。
  test("空 workspace 不接受浏览器 cwd", async () => {
    const harness = await createHarness({ workspacePath: null });
    await submit(harness, { action: "list_sessions", commandId: "null-workspace", cwd: "/browser" });
    expect(harness.sent[0]).toMatchObject({ method: "session/list", params: { cwd: null } });
  });

  // 命令完成 ack 必须携带当前投影版本，供客户端进行乐观并发校验。
  test("committed ack 携带投影版本", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "list_sessions", commandId: "ack-version" });
    expect(committed(harness)?.committedProjectionVersion).toBeTypeOf("number");
  });

  // load_session 注册回调必须只收到该会话同步请求的 RPC id。
  test("create_session 登记会话同步 RPC id", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "create_session", commandId: "create-register" });
    expect(harness.reservations.map((reservation) => reservation.id)).toEqual([1]);
    expect(harness.reservations[0]?.owner.kind).toBe("session-sync");
  });

  // 已完成命令的 duplicate ack 应保留原始投影版本。
  test("duplicate ack 复用已提交结果", async () => {
    const harness = await createHarness();
    const action = { action: "list_sessions", commandId: "duplicate-result" };
    await submit(harness, action);
    const original = committed(harness);
    if (!original) throw new Error("expected committed acknowledgement");
    await submit(harness, action);
    expect(harness.acks.at(-1)).toEqual({ ...original, status: "duplicate" });
  });

  // 空字符串 sessionId 同样属于非法 load 输入。
  test("load_session 空 sessionId 返回 INVALID_STATE", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "load_session", commandId: "load-empty", sessionId: "" });
    expect(harness.errors).toMatchObject([{ error: { type: "ACTION.INVALID_STATE" } }]);
  });

  // 非数值 expectedProjectionVersion 不应进入并发校验。
  test("非数值投影版本被忽略", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "list_sessions", commandId: "version-string", expectedProjectionVersion: "0" });
    expect(harness.errors).toEqual([]);
    expect(harness.sent).toHaveLength(1);
  });

  // cancel 的请求 id 必须随连接计数器单调递增。
  test("连续 cancel 使用递增 RPC id", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "cancel", commandId: "cancel-one" });
    await submit(harness, { action: "cancel", commandId: "cancel-two" });
    expect(harness.sent.map((message) => message.id)).toEqual([1, 2]);
  });

  // resume_session 不会替换当前投影，等待 Agent 返回后再由事件层同步。
  test("resume_session 不提前替换投影", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "resume_session", commandId: "resume-no-replace", sessionId: "ses-2" });
    expect(harness.replacements).toEqual([]);
    expect(harness.synced).toEqual([]);
  });

  // 取消前没有活动 turn 时依旧只发送取消协议请求。
  test("无活动 turn 的 cancel 不创建投影状态", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "cancel", commandId: "cancel-no-turn" });
    expect(getSessionInfo(harness.manager.getSessionYdoc("rcs-1")!).get("activeTurnId")).toBeUndefined();
    expect(harness.sent).toHaveLength(1);
  });

  // create_session 不应擅自修改旧连接的 acpSessionId。
  test("create_session 保留旧会话绑定直到响应到达", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "create_session", commandId: "create-keep-binding" });
    expect(harness.connection.acpSessionId).toBe("ses-1");
  });

  // 多段文本 content 应合并为同一个用户消息 turn。
  test("多段文本 prompt 合并为一个 turn", async () => {
    const harness = await createHarness();
    await submit(harness, {
      action: "send_prompt",
      commandId: "multi-text",
      content: [
        { type: "text", text: "第一段" },
        { type: "image", data: "ignored" },
        { type: "text", text: "第二段" },
      ],
    });
    expect(committed(harness)?.turnId).toBeDefined();
    expect(harness.sent).toHaveLength(1);
  });

  // reload 后重复同一绑定会话仍不得产生额外 relay 调用。
  test("切换后同会话 load 保持静默", async () => {
    const harness = await createHarness();
    await submit(harness, { action: "load_session", commandId: "load-first", sessionId: "ses-2" });
    await commitSessionSync(harness, "ses-2");
    await submit(harness, { action: "load_session", commandId: "load-second", sessionId: "ses-2" });
    expect(harness.sent).toHaveLength(1);
  });

  // relay 发送错误不得泄露其内部错误文本给客户端。
  test("relay 错误响应不泄露内部信息", async () => {
    const harness = await createHarness({ sendToRelay: () => Promise.reject(new Error("credential=secret")) });
    await submit(harness, { action: "list_sessions", commandId: "sanitized-error" });
    expect(harness.errors[0]?.error).toMatchObject({
      type: "ACTION.AGENT_UNAVAILABLE",
      message: "The Agent is unavailable for the action.",
    });
    expect(JSON.stringify(harness.errors[0])).not.toContain("credential=secret");
    expect(JSON.stringify(harness.errors)).not.toContain("credential=secret");
  });

  // dispose 仅清理指定 RCS session，其他会话的命令仍可执行。
  test("dispose 隔离其他 RCS session", async () => {
    const harness = await createHarness();
    harness.channel.disposeRcsSession("rcs-other");
    await submit(harness, { action: "list_sessions", commandId: "other-dispose" });
    expect(harness.sent).toHaveLength(1);
  });
});
