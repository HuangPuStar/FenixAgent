// packages/chat-channel/src/channel/command-coordinator-state.test.ts
// Turn 状态机测试（C4）：全转换、终态不可逆、单活动 turn、取消/超时路径、晚到增量丢弃。
//
// 两层覆盖：
// - 聚合层（applyNormalizedEvent）直接驱动：状态机全转换与终态不可逆的细粒度断言；
// - SessionChannel 集成（CommandCoordinator 驱动）：cancel 命令 → cancelling →
//   超时 interrupted / Agent 确认 cancelled 的端到端收敛。
// 无真实网络、无真实 Agent（Q12 测试 seam）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import type { NonPeriNormalizedEventType, NormalizedEvent } from "../schema";
import { applyNormalizedEvent, type DocPair } from "../state/aggregator";
import { getEntry, getEntryOrder, getSessionInfo } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { createChatDoc, createSessionDoc } from "../state/factory";
import { createTestRpcReservationFactory } from "./connection-test-helpers";
import { SessionChannel, type SessionChannelDependencies, type SessionConnection } from "./index";
import type { ActionAck, ActionError } from "./types";

let pair: DocPair;

function event(
  type: NonPeriNormalizedEventType,
  update: Record<string, unknown> = {},
  turnId?: string,
): NormalizedEvent {
  return { type, update, content: (update.content as Record<string, unknown>) ?? null, turnId };
}

function activeTurn(session: Y.Doc): { turnId: string | null; status: string | null } {
  const info = getSessionInfo(session);
  return {
    turnId: (info.get("activeTurnId") as string | null) ?? null,
    status: (info.get("activeTurnStatus") as string | null) ?? null,
  };
}

beforeEach(() => {
  pair = {
    chat: createChatDoc("rcs_state", null).ydoc,
    session: createSessionDoc("rcs_state", null).ydoc,
  };
});

// ── SessionChannel 集成 harness（复用 session-channel-action.test.ts 模式）──

interface Harness {
  channel: SessionChannel;
  docManager: DocManager;
  acks: ActionAck[];
  errorFrames: ActionError[];
}

function createHarness(overrides: Partial<SessionChannelDependencies> = {}): Harness {
  const acks: ActionAck[] = [];
  const errorFrames: ActionError[] = [];
  const docManager = new DocManager({ onError: () => {}, onLog: () => {} });
  const channel = new SessionChannel({
    docManager,
    prepareClearSessionSnapshot: async () => {},
    replaceProjection: () => {},
    syncSessionId: () => {},
    reportError: () => {},
    ...overrides,
  });
  return { channel, docManager, acks, errorFrames };
}

function createConnection(overrides: Partial<SessionConnection> = {}): SessionConnection {
  const reserveRpc = createTestRpcReservationFactory();
  return {
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    acpSessionId: "ses-1",
    agentStatusReceived: true,
    sessionLoaded: false,
    workspacePath: "/workspace/org-1/user-1/env-1",
    sendToRelay: () => {},
    reserveRpc,
    ...overrides,
  };
}

function createSinks(harness: Harness): { sendAck: (ack: ActionAck) => void; sendError: (err: ActionError) => void } {
  return {
    sendAck: (ack) => harness.acks.push(ack),
    sendError: (err) => harness.errorFrames.push(err),
  };
}

// ── 聚合层：状态机全转换 ──

describe("turn state machine transitions", () => {
  // accepting：用户消息被接受并写入用户 entry 后进入
  test("user_message moves turn to accepting", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    expect(activeTurn(pair.session)).toEqual({ turnId: "turn_1", status: "accepting" });
  });

  // accepting → running：收到首个内容增量
  test("first delta moves accepting to running", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    expect(activeTurn(pair.session).status).toBe("running");
  });

  // running → awaiting_permission：Agent 请求权限
  test("permission_requested moves running to awaiting_permission", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event("permission_requested", { permissionId: "p1", title: "Approve" }));
    expect(activeTurn(pair.session).status).toBe("awaiting_permission");
  });

  // awaiting_permission → running：权限解析后无未决请求
  test("permission_resolved moves awaiting_permission back to running", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event("permission_requested", { permissionId: "p1", title: "Approve" }));
    applyNormalizedEvent(pair, event("permission_resolved", { permissionId: "p1", decision: "allow" }));
    expect(activeTurn(pair.session).status).toBe("running");
  });

  // running → completed：终态事件收敛
  test("turn_completed moves running to completed", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event("turn_completed", { usage: { totalTokens: 5 } }));
    expect(activeTurn(pair.session).status).toBe("completed");
  });

  // running → failed：错误事件收敛
  test("turn_failed moves running to failed", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event("turn_failed", { error: "boom" }));
    expect(activeTurn(pair.session).status).toBe("failed");
  });

  // running → cancelling：用户取消 Action（cancel_turn）
  test("cancel_requested moves running to cancelling", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event("turn_cancel_requested"));
    expect(activeTurn(pair.session).status).toBe("cancelling");
  });

  // awaiting_permission → cancelling：权限挂起时用户取消
  test("cancel_requested moves awaiting_permission to cancelling", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("permission_requested", { permissionId: "p1", title: "Approve" }));
    applyNormalizedEvent(pair, event("turn_cancel_requested"));
    expect(activeTurn(pair.session).status).toBe("cancelling");
  });

  // cancelling → cancelled：Agent 确认取消
  test("agent confirmation moves cancelling to cancelled", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event("turn_cancel_requested"));
    applyNormalizedEvent(pair, event("turn_cancelled"));
    expect(activeTurn(pair.session).status).toBe("cancelled");
    // 相关 assistant entry 同步进入终态
    expect(getEntry(pair.chat, "turn_1:assistant")?.get("status")).toBe("cancelled");
  });

  // cancelling → interrupted：取消超时 / 连接丢失
  test("interrupt moves cancelling to interrupted", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event("turn_cancel_requested"));
    applyNormalizedEvent(pair, event("turn_interrupted"));
    expect(activeTurn(pair.session).status).toBe("interrupted");
    expect(getEntry(pair.chat, "turn_1:assistant")?.get("status")).toBe("cancelled");
  });

  // running → interrupted：连接丢失（relay 意外关闭）直接收敛
  test("interrupt moves running to interrupted on connection loss", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event("turn_interrupted"));
    expect(activeTurn(pair.session).status).toBe("interrupted");
  });
});

// ── 聚合层：终态不可逆 ──

describe("terminal turns are irreversible", () => {
  // 四种终态下，任何增量/工具/权限/取消请求都不能把 turn 改回运行态
  test.each([
    ["completed", "turn_completed"],
    ["failed", "turn_failed"],
    ["cancelled", "turn_cancelled"],
    ["interrupted", "turn_interrupted"],
  ] as const)("terminal %s cannot be reverted to running by any input", (terminal, terminalEvent) => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event(terminalEvent));

    // 终态后各种输入逐一尝试
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "late" } }));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "bash" }));
    applyNormalizedEvent(pair, event("permission_requested", { permissionId: "p1", title: "Approve" }));
    applyNormalizedEvent(pair, event("turn_cancel_requested"));
    applyNormalizedEvent(pair, event("turn_completed"));

    expect(activeTurn(pair.session).status).toBe(terminal);
    // 投影无新增内容：assistant entry 文本止于终态前增量
    const assistant = getEntry(pair.chat, "turn_1:assistant");
    const blocks = assistant?.get("blocks") as Y.Map<Y.Map<unknown>>;
    expect((blocks.get("text")?.get("text") as Y.Text | undefined)?.toString() ?? "").toBe("hello");
    // 终态后的工具/权限不投影
    expect(blocks.get("tool:t1")).toBeUndefined();
  });

  // 终态后重复收到同一终态事件：幂等跳过（不重复写、状态不变）
  test("duplicate terminal events are idempotently skipped", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("turn_completed"));
    const dup = applyNormalizedEvent(pair, event("turn_completed"));
    expect(dup.applied).toBe(false);
    expect(activeTurn(pair.session).status).toBe("completed");
  });
});

// ── 聚合层：取消后晚到增量丢弃 ──

describe("deltas after cancel are dropped", () => {
  // cancelling（非终态）期间晚到增量即被丢弃：投影无新增内容
  test("deltas are dropped while cancelling", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event("turn_cancel_requested"));

    const late = applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "late" } }));
    expect(late.applied).toBe(false);

    const assistant = getEntry(pair.chat, "turn_1:assistant");
    const blocks = assistant?.get("blocks") as Y.Map<Y.Map<unknown>>;
    expect((blocks.get("text")?.get("text") as Y.Text).toString()).toBe("hello");
  });

  // 取消确认（cancelled）后晚到增量同样丢弃，不出现"已取消还在输出"
  test("deltas after cancelled are dropped", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
    applyNormalizedEvent(pair, event("turn_cancel_requested"));
    applyNormalizedEvent(pair, event("turn_cancelled"));

    const late = applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "late" } }));
    expect(late.applied).toBe(false);
    expect(activeTurn(pair.session).status).toBe("cancelled");
  });

  // 重复 cancel 幂等：cancelling 后再次 cancel_requested 不产生副作用
  test("duplicate cancel_requested is idempotent", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("turn_cancel_requested"));
    const dup = applyNormalizedEvent(pair, event("turn_cancel_requested"));
    expect(dup.applied).toBe(false);
    expect(activeTurn(pair.session).status).toBe("cancelling");
  });
});

// ── 聚合层：单活动 turn ──

describe("single active turn per session", () => {
  // cancelling 中用户发新消息：旧 turn 终结（entry cancelled），新 turn 接管
  test("new user message during cancelling starts a fresh turn", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "first" } }, "turn_1"));
    applyNormalizedEvent(pair, event("turn_cancel_requested"));
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "second" } }, "turn_2"));

    expect(getEntry(pair.chat, "turn_1:assistant")?.get("status")).toBe("cancelled");
    expect(activeTurn(pair.session)).toEqual({ turnId: "turn_2", status: "accepting" });
    // 时间线顺序：两个 turn 的用户/助手 entry 依次排列
    expect(getEntryOrder(pair.chat).toArray()).toEqual([
      "turn_1:user",
      "turn_1:assistant",
      "turn_2:user",
      "turn_2:assistant",
    ]);
  });
});

// ── SessionChannel 集成：取消流程端到端 ──

describe("cancel flow through CommandCoordinator", () => {
  afterEach(() => {
    harness?.channel.disposeRcsSession("rcs-1");
  });
  let harness: Harness;

  function setup(overrides: Partial<SessionChannelDependencies> = {}): Harness {
    harness = createHarness(overrides);
    return harness;
  }

  // cancel 命令端到端：send_prompt（accepting）→ cancel（cancelling）→
  // Agent 确认（turn_cancelled）→ cancelled 终态
  test("cancel converges to cancelled after agent confirmation", async () => {
    const h = setup();
    const connection = createConnection();
    await h.docManager.openChat("rcs-1");
    await h.docManager.openSession("user-1", "agent-1", "rcs-1");

    await h.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "hi" }] },
      createSinks(h),
    );
    await h.channel.handleAction(connection, { action: "cancel", commandId: "cmd-2" }, createSinks(h));

    const sessionDoc = h.docManager.getSessionYdoc("rcs-1") as Y.Doc;
    expect(activeTurn(sessionDoc).status).toBe("cancelling");

    // Agent 确认取消（acp-link 取消后回 prompt_complete { stopReason: "cancelled" }）
    h.docManager.processNormalizedEvent("rcs-1", {
      type: "turn_cancelled",
      update: { stopReason: "cancelled" },
      content: null,
    });
    expect(activeTurn(sessionDoc).status).toBe("cancelled");
    expect(h.acks.map((a) => a.status)).toEqual(["accepted", "committed", "accepted", "committed"]);
  });

  // cancel 命令端到端：Agent 未确认时取消超时 → interrupted 终态
  test("cancel converges to interrupted after timeout", async () => {
    const h = setup({ cancelTimeoutMs: 20 });
    const connection = createConnection();
    await h.docManager.openChat("rcs-1");
    await h.docManager.openSession("user-1", "agent-1", "rcs-1");

    await h.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "hi" }] },
      createSinks(h),
    );
    await h.channel.handleAction(connection, { action: "cancel", commandId: "cmd-2" }, createSinks(h));

    const sessionDoc = h.docManager.getSessionYdoc("rcs-1") as Y.Doc;
    expect(activeTurn(sessionDoc).status).toBe("cancelling");

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(activeTurn(sessionDoc).status).toBe("interrupted");
  });

  // 取消超时兜底不得误伤后续 turn：超时前用户已发起新 turn → 不投递 interrupted
  test("cancel timeout does not interrupt a newer turn", async () => {
    const h = setup({ cancelTimeoutMs: 20 });
    const connection = createConnection();
    await h.docManager.openChat("rcs-1");
    await h.docManager.openSession("user-1", "agent-1", "rcs-1");

    await h.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "hi" }] },
      createSinks(h),
    );
    await h.channel.handleAction(connection, { action: "cancel", commandId: "cmd-2" }, createSinks(h));
    // 超时前用户发起新 turn（旧 turn 被终结）
    await h.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-3", content: [{ type: "text", text: "again" }] },
      createSinks(h),
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    // 新 turn 保持 accepting，不被旧取消定时器误中断
    const sessionDoc = h.docManager.getSessionYdoc("rcs-1") as Y.Doc;
    expect(activeTurn(sessionDoc).status).toBe("accepting");
  });

  // disposeRcsSession 清理取消定时器：释放后不再投递 interrupted
  test("disposeRcsSession clears pending cancel timer", async () => {
    const h = setup({ cancelTimeoutMs: 20 });
    const connection = createConnection();
    await h.docManager.openChat("rcs-1");
    await h.docManager.openSession("user-1", "agent-1", "rcs-1");

    await h.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "hi" }] },
      createSinks(h),
    );
    await h.channel.handleAction(connection, { action: "cancel", commandId: "cmd-2" }, createSinks(h));
    h.channel.disposeRcsSession("rcs-1");

    await new Promise((resolve) => setTimeout(resolve, 60));
    // Doc 已释放：无内存 Doc 时事件被 docManager 丢弃，无状态变更（此处 Doc 未关闭，
    // 但 activeConnections 已清空，定时器已清理，状态保持 cancelling）
    const sessionDoc = h.docManager.getSessionYdoc("rcs-1") as Y.Doc;
    expect(activeTurn(sessionDoc).status).toBe("cancelling");
  });
});
