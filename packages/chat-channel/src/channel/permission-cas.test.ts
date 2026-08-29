// packages/chat-channel/src/channel/permission-cas.test.ts
// 权限 CAS（C5）协议层集成测试：
// - respond_permission 原子迁移：仅 pending → resolved 一次，迁移成功才向 Agent
//   发送 permission.resolve（JSON-RPC 响应），重复响应不重发
// - 超时 / turn 终态 / 会话切换 / 断链（dispose）的终态迁移与 pending 清理
// - 权限请求与 activeTurn 关联：多权限场景下 turn 的 awaiting_permission 收敛

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import type { NonPeriNormalizedEventType, NormalizedEvent } from "../schema";
import { applyNormalizedEvent, type DocPair } from "../state/aggregator";
import { getPendingPermissions, getSessionInfo, getToolCallsMap, readActiveTurn } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { createChatDoc, createSessionDoc } from "../state/factory";
import { createTestRpcReservationFactory, type TestRpcReservation } from "./connection-test-helpers";
import { SessionChannel, type SessionChannelDependencies, type SessionConnection } from "./index";
import type { ActionAck, ActionError } from "./types";

// ── 控制面 harness（复用 session-channel-action.test.ts 的测试 seam）──

interface TestHarness {
  channel: SessionChannel;
  docManager: DocManager;
  acks: ActionAck[];
  errorFrames: ActionError[];
  errors: Array<{ message: string; error: unknown }>;
}

function createHarness(overrides: Partial<SessionChannelDependencies> = {}): TestHarness {
  const state = {
    acks: [] as ActionAck[],
    errorFrames: [] as ActionError[],
    errors: [] as Array<{ message: string; error: unknown }>,
  };
  const docManager = new DocManager({ onError: () => {}, onLog: () => {} });
  const channel = new SessionChannel({
    docManager,
    prepareClearSessionSnapshot: async () => {},
    replaceProjection: () => {},
    syncSessionId: () => {},
    reportError: (message, error) => {
      state.errors.push({ message, error });
    },
    ...overrides,
  });
  return {
    channel,
    docManager,
    get acks() {
      return state.acks;
    },
    get errorFrames() {
      return state.errorFrames;
    },
    errors: state.errors,
  };
}

interface RelayRecord {
  jsonrpc: string;
  id: string;
  result: { outcome: { outcome: string; optionId?: string } };
}

function createConnection(overrides: Partial<SessionConnection> = {}): {
  connection: SessionConnection;
  relayMessages: RelayRecord[];
  reservations: TestRpcReservation[];
} {
  const relayMessages: RelayRecord[] = [];
  const reserveRpc = createTestRpcReservationFactory();
  const connection: SessionConnection = {
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    acpSessionId: "ses_1",
    agentStatusReceived: true,
    sessionLoaded: false,
    workspacePath: "/workspace/org-1/user-1/env-1",
    sendToRelay: (message) => {
      const record = message as unknown as RelayRecord;
      if (record.jsonrpc === "2.0" && "result" in record) relayMessages.push(record);
    },
    reserveRpc,
    ...overrides,
  };
  return { connection, relayMessages, reservations: reserveRpc.reservations };
}

async function commitSessionSync(reservations: TestRpcReservation[], sessionId: string): Promise<void> {
  const reservation = reservations.at(-1);
  if (!reservation || reservation.owner.kind !== "session-sync") {
    throw new Error("expected a session-sync reservation");
  }
  const committed = await reservation.owner.lifecycle.commit({ sessionId }, () => !reservation.aborted);
  if (!committed) throw new Error(`expected session-sync commit for ${sessionId}`);
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

/** 建立 turn + 工具调用 + 权限请求的完整上下文（用户消息 → 工具调用 → 权限请求投影） */
async function setupTurnWithPendingPermission(
  harness: TestHarness,
  permissionId: string,
  toolCallId: string,
  expiresAt: string,
): Promise<void> {
  await harness.docManager.openChat("rcs-1");
  await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
  harness.docManager.processNormalizedEvent("rcs-1", {
    type: "user_message",
    update: { content: { type: "text", text: "hi" } },
    content: { type: "text", text: "hi" },
    turnId: "turn_1",
  });
  // 工具调用先投影，权限请求才能关联 toolCallId（聚合层关联存在才更新）
  harness.docManager.processNormalizedEvent("rcs-1", {
    type: "tool_call_started",
    update: { toolCallId, title: "bash" },
    content: null,
  });
  harness.docManager.processNormalizedEvent("rcs-1", {
    type: "permission_requested",
    update: {
      permissionId,
      title: "Run command",
      toolCallId,
      options: ["allow_once", "deny"],
      expiresAt,
    },
    content: null,
  });
}

describe("permission CAS (C5)", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    harness.docManager.setPermissionRequestedHandler(null);
  });

  // 重复 respond_permission（相同 permissionId、不同 commandId）只有第一次 CAS 生效，
  // Agent 只收到一次 resolve，第二次幂等返回 committed 且不重发
  test("duplicate respond_permission resolves once and agent receives a single resolve", async () => {
    const { connection, relayMessages } = createConnection();
    await setupTurnWithPendingPermission(harness, "p1", "t1", new Date(Date.now() + 60_000).toISOString());

    const sinks = createSinks(harness);
    await harness.channel.handleAction(
      connection,
      { action: "respond_permission", commandId: "cmd-1", requestId: "p1", optionId: "allow" },
      sinks,
    );
    await harness.channel.handleAction(
      connection,
      { action: "respond_permission", commandId: "cmd-2", requestId: "p1", optionId: "allow" },
      sinks,
    );

    // 只有第一次迁移成功并发送 resolve（JSON-RPC 响应，id = permissionId）
    expect(relayMessages).toHaveLength(1);
    expect(relayMessages[0]?.id).toBe("p1");
    expect(relayMessages[0]?.result.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    // 两次响应都返回 committed（幂等成功，不报错）
    expect(harness.acks.map((a) => a.status)).toEqual(["accepted", "committed", "accepted", "committed"]);
    // Session Doc 投影为 resolved（前端 filter pending 后不再显示）
    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1");
    expect(getPendingPermissions(sessionDoc!).get("p1")?.get("status")).toBe("resolved");
    // CAS 成功后 decision 落盘：allow → "allow"
    expect(getPendingPermissions(sessionDoc!).get("p1")?.get("decision")).toBe("allow");
  });

  // 未知 permissionId（不存在于 pendingPermissions）时 CAS 失败：不发 resolve、幂等成功
  test("unknown permissionId does not send resolve", async () => {
    const { connection, relayMessages } = createConnection();
    await setupTurnWithPendingPermission(harness, "p1", "t1", new Date(Date.now() + 60_000).toISOString());

    await harness.channel.handleAction(
      connection,
      { action: "respond_permission", commandId: "cmd-1", requestId: "p-unknown", optionId: "allow" },
      createSinks(harness),
    );

    expect(relayMessages).toHaveLength(0);
    expect(harness.acks.map((a) => a.status)).toEqual(["accepted", "committed"]);
  });

  // deny 响应（optionId 为空）翻译为 cancelled outcome，并收敛关联工具调用为 cancelled
  test("deny response sends cancelled outcome and cancels the tool call", async () => {
    const { connection, relayMessages } = createConnection();
    await setupTurnWithPendingPermission(harness, "p1", "t1", new Date(Date.now() + 60_000).toISOString());

    await harness.channel.handleAction(
      connection,
      { action: "respond_permission", commandId: "cmd-1", requestId: "p1", optionId: null },
      createSinks(harness),
    );

    expect(relayMessages[0]?.result.outcome).toEqual({ outcome: "cancelled" });
    const tool = getToolCallsMap(harness.docManager.getChatYdoc("rcs-1")!).get("t1");
    expect(tool?.get("status")).toBe("cancelled");
    // deny 决议（optionId 为 null）→ decision 落盘 "deny"
    expect(getPendingPermissions(harness.docManager.getSessionYdoc("rcs-1")!).get("p1")?.get("decision")).toBe("deny");
    // turn 无其他 pending → 恢复 running（C4 语义：deny 后 Agent 决定是否继续）
    expect(getSessionInfo(harness.docManager.getSessionYdoc("rcs-1")!).get("activeTurnStatus")).toBe("running");
  });

  // 权限超时：expiresAt 已过 → 定时器立即触发 pending → expired，turn（无其他 pending）收敛 cancelled
  test("expired permission migrates to expired terminal state and cancels the turn", async () => {
    const { connection } = createConnection();
    // expiresAt 设为过去时间，定时器立即触发
    await setupTurnWithPendingPermission(harness, "p1", "t1", new Date(Date.now() - 1000).toISOString());
    // 确保 timer 在事件循环中执行
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1")!;
    expect(getPendingPermissions(sessionDoc).get("p1")?.get("status")).toBe("expired");
    // expired 路径不写 decision（保持 upsert 时的 null），前端 expired → denied 映射不变
    expect(getPendingPermissions(sessionDoc).get("p1")?.get("decision")).toBeNull();
    expect(getSessionInfo(sessionDoc).get("activeTurnStatus")).toBe("cancelled");
    expect(getToolCallsMap(harness.docManager.getChatYdoc("rcs-1")!).get("t1")?.get("status")).toBe("cancelled");

    // 过期后响应 → CAS 失败，不再发 resolve（即使命令重发也不重发 RPC）
    const { relayMessages } = createConnection();
    await harness.channel.handleAction(
      connection,
      { action: "respond_permission", commandId: "cmd-1", requestId: "p1", optionId: "allow" },
      createSinks(harness),
    );
    expect(relayMessages).toHaveLength(0);
  });

  // 多个 pending 权限：一个 resolved 后 turn 保持 awaiting_permission，全部解决才恢复 running
  test("turn stays awaiting_permission until all pending permissions are resolved", async () => {
    const { connection, relayMessages } = createConnection();
    await setupTurnWithPendingPermission(harness, "p1", "t1", new Date(Date.now() + 60_000).toISOString());
    // 同一 turn 追加第二个权限请求
    harness.docManager.processNormalizedEvent("rcs-1", {
      type: "permission_requested",
      update: {
        permissionId: "p2",
        title: "Read file",
        toolCallId: "t2",
        options: ["allow_once", "deny"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      content: null,
    });

    // 解决 p1 → turn 仍 awaiting_permission
    await harness.channel.handleAction(
      connection,
      { action: "respond_permission", commandId: "cmd-1", requestId: "p1", optionId: "allow" },
      createSinks(harness),
    );
    let sessionDoc = harness.docManager.getSessionYdoc("rcs-1")!;
    expect(getSessionInfo(sessionDoc).get("activeTurnStatus")).toBe("awaiting_permission");
    expect(relayMessages).toHaveLength(1);

    // 解决 p2 → turn 恢复 running
    await harness.channel.handleAction(
      connection,
      { action: "respond_permission", commandId: "cmd-2", requestId: "p2", optionId: "allow" },
      createSinks(harness),
    );
    sessionDoc = harness.docManager.getSessionYdoc("rcs-1")!;
    expect(getSessionInfo(sessionDoc).get("activeTurnStatus")).toBe("running");
    expect(relayMessages).toHaveLength(2);
  });

  // 会话切换（load_session 到新会话）→ pendingPermissions 整体清空，不残留可授权项。
  // sessionLoaded=true 表示非重连的正常切换（重连场景保留已有 Doc 内容，见 C3 守卫）
  test("session switch clears pending permissions", async () => {
    const { connection, reservations } = createConnection({ sessionLoaded: true });
    await setupTurnWithPendingPermission(harness, "p1", "t1", new Date(Date.now() + 60_000).toISOString());

    await harness.channel.handleAction(
      connection,
      { action: "load_session", commandId: "cmd-load", sessionId: "ses_new" },
      createSinks(harness),
    );
    await commitSessionSync(reservations, "ses_new");

    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1")!;
    expect(getPendingPermissions(sessionDoc).size).toBe(0);
  });

  // 断链（前端最后连接关闭 → disposeRcsSession）：权限过期定时器被清除，
  // 之后即使超过 expiresAt 也不再迁移（Y.Doc 状态保留，重连后可见）
  test("disposeRcsSession clears permission timers so late expiry is not applied", async () => {
    await setupTurnWithPendingPermission(harness, "p1", "t1", new Date(Date.now() + 60).toISOString());
    harness.channel.disposeRcsSession("rcs-1");

    await new Promise((resolve) => setTimeout(resolve, 120));
    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1")!;
    expect(getPendingPermissions(sessionDoc).get("p1")?.get("status")).toBe("pending");
  });
});

// ── 聚合层：turn 终态后权限请求失效清理（不依赖控制面）──

describe("permission CAS on turn terminal (aggregator)", () => {
  let pair: DocPair;

  beforeEach(() => {
    pair = {
      chat: createChatDoc("rcs_t", null).ydoc,
      session: createSessionDoc("rcs_t", null).ydoc,
    };
  });

  function event(
    type: NonPeriNormalizedEventType,
    update: Record<string, unknown> = {},
    turnId?: string,
  ): NormalizedEvent {
    return { type, update, content: (update.content as Record<string, unknown>) ?? null, turnId };
  }

  function runTurnWithPermission(turnId: string): void {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, turnId));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "bash" }));
    applyNormalizedEvent(pair, event("permission_requested", { permissionId: "p1", toolCallId: "t1", title: "Run" }));
  }

  // 四种 turn 终态（completed/failed/cancelled/interrupted）都会使该 turn 的 pending
  // 权限迁移为 expired、awaiting_permission 工具调用收敛 cancelled（不残留可授权项）
  for (const [eventType, turnStatus] of [
    ["turn_completed", "completed"],
    ["turn_failed", "failed"],
    ["turn_cancelled", "cancelled"],
    ["turn_interrupted", "interrupted"],
  ] as const) {
    test(`${eventType} expires the turn's pending permissions`, () => {
      runTurnWithPermission("turn_1");
      // 断言先进入 awaiting_permission（工具调用关联）
      expect(readActiveTurn(pair.session).turnStatus).toBe("awaiting_permission");
      expect(getToolCallsMap(pair.chat).get("t1")?.get("status")).toBe("awaiting_permission");

      applyNormalizedEvent(pair, event(eventType, {}));

      expect(getPendingPermissions(pair.session).get("p1")?.get("status")).toBe("expired");
      expect(getToolCallsMap(pair.chat).get("t1")?.get("status")).toBe("cancelled");
      expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe(turnStatus);
    });
  }

  // 终态清理只影响该 turn 的权限：其他 turn 的 pending 项不受牵连
  test("terminal cleanup only expires permissions of the finished turn", () => {
    runTurnWithPermission("turn_1");
    // 直接注入一条其他 turn 的历史残留 pending 项（模拟异常数据，聚合层不产生此形态）
    pair.session.transact(() => {
      const old = new Y.Map<unknown>();
      old.set("permissionId", "p_old");
      old.set("turnId", "turn_0");
      old.set("toolCallId", null);
      old.set("title", "Old");
      old.set("description", null);
      old.set("options", ["allow_once", "deny"]);
      old.set("status", "pending");
      old.set("expiresAt", new Date(Date.now() + 60_000).toISOString());
      getPendingPermissions(pair.session).set("p_old", old);
    });
    applyNormalizedEvent(pair, event("turn_completed", {}));

    expect(getPendingPermissions(pair.session).get("p1")?.get("status")).toBe("expired");
    expect(getPendingPermissions(pair.session).get("p_old")?.get("status")).toBe("pending");
  });
});
