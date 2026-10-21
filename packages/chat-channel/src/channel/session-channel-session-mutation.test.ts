import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { getSessionInfo } from "../state/chat-writer";
import { createConnection, createHarness, createSinks, waitForTurnStatus } from "./session-channel-action-test-helpers";

describe("SessionChannel action flow", () => {
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
      {
        sessionId: connection.acpSessionId,
        action: "send_prompt",
        commandId: "cmd-1",
        content: [{ type: "text", text: "hi" }],
      },
      createSinks(harness),
    );
    await harness.channel.handleAction(connection, { action: "cancel", commandId: "cmd-2" }, sinks);

    expect(relayMessages.map((m) => m.method)).toEqual(["session/prompt", "session/cancel"]);
    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1");
    // 取消请求落地为 cancelling（非终态，晚到增量自此丢弃）
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("cancelling");
    // cancelling 展示态投影：仍显示 loading（取消进行中），但停止按钮已禁用
    const cancelling = getSessionInfo(sessionDoc as Y.Doc);
    expect(cancelling.get("presenting")).toBe("loading");
    expect(cancelling.get("loading")).not.toBeNull();
    expect(cancelling.get("canCancel")).toBe(false);

    // Agent 确认取消（acp-link 取消后回 prompt_complete { stopReason: "cancelled" }）
    harness.docManager.processNormalizedEvent("rcs-1", {
      type: "turn_cancelled",
      update: { stopReason: "cancelled" },
      content: null,
    });
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("cancelled");
    // cancelled 终态投影：done，无 loading 与取消
    const cancelled = getSessionInfo(sessionDoc as Y.Doc);
    expect(cancelled.get("presenting")).toBe("done");
    expect(cancelled.get("loading")).toBeNull();
    expect(cancelled.get("canCancel")).toBe(false);
  });

  // P2-4：cancel RPC 透传目标 sessionId——多会话并发下 dispatcher 必须按 RPC 中的
  // sessionId 精确路由到对应 query，而不是一律 fallback 当前会话（否则可能取消错 query）。
  test("cancel forwards session/cancel with the target sessionId from the action payload", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ acpSessionId: "ses-current" });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    // action payload 携带目标会话（前端 onCancel 从 sessionState.acpSessionId 填充）
    await harness.channel.handleAction(
      connection,
      { action: "cancel", commandId: "cmd-2", sessionId: "ses-target" },
      sinks,
    );

    expect(relayMessages).toHaveLength(1);
    expect(relayMessages[0]?.method).toBe("session/cancel");
    expect(relayMessages[0]?.params).toMatchObject({ sessionId: "ses-target" });
  });

  // acpSessionId 为 null（session/new 的 RPC 往返尚未完成）时 cancel 仍必须进入状态机：
  // 原 `&& connection.acpSessionId` 门禁会吞掉取消请求，Agent 回 {cancelled:false} 无任何终态事件，
  // turn 永久卡 accepting（loading 卡死）。取消分支无条件化后 turn 立即 cancelling 并转发 session/cancel。
  test("cancel with null acpSessionId still enters cancelling and forwards session/cancel", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ acpSessionId: null });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.docManager.registerUserMessage("rcs-1", "hi");
    await harness.channel.handleAction(connection, { action: "cancel", commandId: "cmd-2" }, sinks);

    expect(relayMessages.map((m) => m.method)).toEqual(["session/cancel"]);
    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1");
    // 取消请求落地为 cancelling（非终态），不再被 acpSessionId 门禁跳过
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("cancelling");
  });

  // acpSessionId 为 null 时取消无 Agent 确认事件（acp-link 回 {cancelled:false} 不产生终态），
  // 取消超时兜底必须在 cancelTimeoutMs 后把 turn 收敛为 interrupted，防止 loading 卡死。
  test("cancel with null acpSessionId converges to interrupted via cancel timeout", async () => {
    const harness = createHarness({ cancelTimeoutMs: 20 });
    const { connection } = createConnection({ acpSessionId: null });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.docManager.registerUserMessage("rcs-1", "hi");
    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1");
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("accepting");

    await harness.channel.handleAction(connection, { action: "cancel", commandId: "cmd-2" }, sinks);
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("cancelling");

    // 等待超时回调（cancelTimeoutMs=20，轮询等待收敛，避免固定等待 flaky）
    await waitForTurnStatus(sessionDoc, "interrupted");
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("interrupted");
    // 超时兜底终态投影：presenting=done，无 loading 与取消（loading 卡死防护闭环）
    const interrupted = getSessionInfo(sessionDoc as Y.Doc);
    expect(interrupted.get("presenting")).toBe("done");
    expect(interrupted.get("loading")).toBeNull();
    expect(interrupted.get("canCancel")).toBe(false);
  });

  // 双终态幂等：取消超时已收敛为 interrupted 后，晚到的 Agent 确认事件（turn_cancelled）
  // 被聚合层 applyTurnTerminal 幂等跳过——状态保持 interrupted，不回退、不重复写。
  test("turn_cancelled after cancel-timeout terminal is idempotently skipped", async () => {
    const harness = createHarness({ cancelTimeoutMs: 20 });
    const { connection } = createConnection({ acpSessionId: null });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.docManager.registerUserMessage("rcs-1", "hi");
    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1");
    await harness.channel.handleAction(connection, { action: "cancel", commandId: "cmd-2" }, sinks);
    await waitForTurnStatus(sessionDoc, "interrupted");

    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("interrupted");

    harness.docManager.processNormalizedEvent("rcs-1", {
      type: "turn_cancelled",
      update: { stopReason: "cancelled" },
      content: null,
    });
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("interrupted");
  });

  // 终态后 cancel 无副作用：turn 已 completed 时发 cancel，聚合层拒绝迁移
  // （cancel after terminal turn），armCancelTimeout 回调因 activeTurnStatus 非 cancelling
  // 也不动作——状态保持 completed，不会误中断已完成 turn；relay 仍正常转发 RPC（幂等 no-op）。
  test("cancel after completed turn is a no-op (state unchanged, timeout guard holds)", async () => {
    const harness = createHarness({ cancelTimeoutMs: 20 });
    const { connection } = createConnection({ acpSessionId: "ses-1" });
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      {
        sessionId: connection.acpSessionId,
        action: "send_prompt",
        commandId: "cmd-1",
        content: [{ type: "text", text: "hi" }],
      },
      createSinks(harness),
    );
    // Agent 正常完成 turn（completed 终态）
    harness.docManager.processNormalizedEvent("rcs-1", {
      type: "turn_completed",
      update: { stopReason: "end_turn" },
      content: null,
    });
    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1");
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("completed");

    // 终态后 cancel：状态保持 completed（聚合层拒绝），RPC 仍转发（幂等 no-op 语义）
    await harness.channel.handleAction(connection, { action: "cancel", commandId: "cmd-2" }, sinks);
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("completed");
    // completed 终态展示态投影保持不变：presenting=done，无 loading 与取消
    const completed = getSessionInfo(sessionDoc as Y.Doc);
    expect(completed.get("presenting")).toBe("done");
    expect(completed.get("loading")).toBeNull();
    expect(completed.get("canCancel")).toBe(false);

    // 等待超过 cancelTimeoutMs：armCancelTimeout 守卫（turnId 相同但状态非 cancelling）
    // 不收敛为 interrupted，完成后的 turn 不会被误标中断
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getSessionInfo(sessionDoc as Y.Doc).get("activeTurnStatus")).toBe("completed");
  });

  // 未绑定任何连接的 rcsSessionId：validateAction 拒绝（SESSION_NOT_FOUND），不发 accepted。
  test("rejects actions for unknown sessions with SESSION_NOT_FOUND", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection({ rcsSessionId: "rcs-ghost" });
    const sinks = createSinks(harness);

    await harness.channel.handleAction(
      connection,
      {
        sessionId: connection.acpSessionId,
        action: "send_prompt",
        commandId: "cmd-1",
        content: [{ type: "text", text: "hi" }],
      },
      sinks,
    );

    expect(harness.acks).toHaveLength(0);
    expect(harness.errorFrames[0]).toMatchObject({ error: { type: "ACTION.SESSION_NOT_FOUND" } });
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
    expect(harness.errorFrames[0]).toMatchObject({ error: { type: "ACTION.AGENT_UNAVAILABLE" } });
    expect(harness.errors).toHaveLength(1);
  });

  // 投影换代失败：保留旧会话绑定，返回稳定错误且不转发 relay。
  test("keeps old session binding when projection replacement rejects", async () => {
    const harness = createHarness();
    harness.docManager.replaceProjection = async () => {
      throw new Error("Redis unavailable");
    };
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
    expect(harness.errorFrames[0]?.error.type).toBe("INTERNAL.UNCLASSIFIED");
  });
});
