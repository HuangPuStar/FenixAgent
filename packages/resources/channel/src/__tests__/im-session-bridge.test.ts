import { describe, expect, test } from "bun:test";
import type { ImSessionTarget } from "../server/ports/im-session";
import {
  createImSessionBridge,
  IM_WAKE_PROMPT_TEXT,
  ImSessionBridgeError,
} from "../server/services/langbot/im-session-bridge";
import { createFakeImSessionPort } from "./im-session-fake";

function makeTarget(overrides: Partial<ImSessionTarget> = {}): ImSessionTarget {
  return {
    channelId: "channel-1",
    conversationId: "conversation-1",
    organizationId: "org-1",
    ownerUserId: "owner-1",
    agentConfigId: "agent-1",
    rcsSessionId: "rcs_im_1",
    acpSessionId: null,
    ...overrides,
  };
}

async function captureError(promise: Promise<unknown>): Promise<ImSessionBridgeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImSessionBridgeError) return error;
    throw error;
  }
  throw new Error("预期冷启动失败，但调用成功返回");
}

describe("IM 会话冷启动桥接", () => {
  // 首条消息必须确保实例、打开会话并发送一次固定唤醒 prompt，且 prompt 不含任何业务数据。
  test("首条消息走通用唤醒 prompt，正文、发送者与聊天标识都不进入 prompt", async () => {
    const port = createFakeImSessionPort();
    const bridge = createImSessionBridge({ port });
    const target = makeTarget();

    const outcome = await bridge.open(target);

    expect(outcome).toEqual({ kind: "cold_started", acpSessionId: "ses_fake_1" });
    expect(port.calls).toEqual({ ensureInstance: 1, openSession: 1, sendWakePrompt: 1, close: 1 });
    expect(port.wakePrompts).toEqual([IM_WAKE_PROMPT_TEXT]);
    expect(port.wakePrompts[0]).not.toContain(target.conversationId);
    expect(port.wakePrompts[0]).not.toContain(target.ownerUserId);
    expect(port.openInputs[0]?.target.acpSessionId).toBeNull();
    expect(bridge.isWarm(target.conversationId)).toBe(true);
  });

  // 暖会话不再打开会话或发 prompt，但每次都要确认实例仍在运行，否则实例重启无法被发现。
  test("后续消息命中暖态，不重复发送 prompt", async () => {
    const port = createFakeImSessionPort();
    const bridge = createImSessionBridge({ port });
    await bridge.open(makeTarget());

    const outcome = await bridge.open(makeTarget({ acpSessionId: "ses_fake_1" }));

    expect(outcome).toEqual({ kind: "warm" });
    expect(port.calls).toEqual({ ensureInstance: 2, openSession: 1, sendWakePrompt: 1, close: 1 });
  });

  // 实例重启后 uid 不变、运行代次变化，暖态必须作废并重新冷启动，否则通知会发给未注册的 inbox。
  test("实例重启后重新冷启动", async () => {
    const port = createFakeImSessionPort();
    const bridge = createImSessionBridge({ port });
    await bridge.open(makeTarget());

    port.rebuildRuntime();
    const outcome = await bridge.open(makeTarget({ acpSessionId: "ses_fake_1" }));

    expect(outcome.kind).toBe("cold_started");
    expect(port.calls.sendWakePrompt).toBe(2);
    expect(port.calls.openSession).toBe(2);
  });

  // 实例被替换时 uid 也变化，与重启一样必须重新冷启动。
  test("实例被替换后重新冷启动", async () => {
    const port = createFakeImSessionPort();
    const bridge = createImSessionBridge({ port });
    await bridge.open(makeTarget());

    port.replaceInstance();
    const outcome = await bridge.open(makeTarget({ acpSessionId: "ses_fake_1" }));

    expect(outcome.kind).toBe("cold_started");
    expect(port.calls.sendWakePrompt).toBe(2);
  });

  // 路由改绑 Agent 会重建 rcsSessionId，旧 ACP 会话属于旧 Agent，必须按新会话重新冷启动。
  test("路由改绑 Agent 导致会话键变化时重新冷启动", async () => {
    const port = createFakeImSessionPort();
    const bridge = createImSessionBridge({ port });
    await bridge.open(makeTarget());

    const outcome = await bridge.open(makeTarget({ rcsSessionId: "rcs_im_2" }));

    expect(outcome.kind).toBe("cold_started");
    expect(port.openInputs[1]?.target.rcsSessionId).toBe("rcs_im_2");
    expect(port.calls.sendWakePrompt).toBe(2);
  });

  // session/load 失败后新建会话时，调用方显式作废暖态，下一条消息必须重新唤醒。
  test("会话重建由调用方作废暖态后重新冷启动", async () => {
    const port = createFakeImSessionPort();
    const bridge = createImSessionBridge({ port });
    const target = makeTarget();
    await bridge.open(target);

    bridge.invalidate(target.conversationId);
    const outcome = await bridge.open(target);

    expect(bridge.isWarm(target.conversationId)).toBe(true);
    expect(outcome.kind).toBe("cold_started");
    expect(port.calls.sendWakePrompt).toBe(2);
  });

  // 冷启动失败必须上抛 COLD_START_FAILED 且不留暖态；降级为暖态等于改走通知，而 inbox 尚未注册。
  test("冷启动失败只上抛，不留下暖态也不改走通知", async () => {
    const port = createFakeImSessionPort();
    const bridge = createImSessionBridge({ port });
    const target = makeTarget();
    port.failNextWake(new Error("relay closed"));

    const error = await captureError(bridge.open(target));

    expect(error.code).toBe("COLD_START_FAILED");
    expect(error.conversationId).toBe(target.conversationId);
    expect(bridge.isWarm(target.conversationId)).toBe(false);
    expect(port.calls.close).toBe(1);

    // 重试仍走 prompt 路径（第 2 次唤醒），说明失败没有被记成暖态。
    const retried = await bridge.open(target);
    expect(retried.kind).toBe("cold_started");
    expect(port.calls.sendWakePrompt).toBe(2);
  });

  // 并发消息共享同一次冷启动，只发一次 prompt：一次唤醒处理全部积压。
  test("并发消息只触发一次冷启动", async () => {
    const port = createFakeImSessionPort();
    const bridge = createImSessionBridge({ port });
    const target = makeTarget();

    const outcomes = await Promise.all([bridge.open(target), bridge.open(target)]);

    expect(outcomes.map((item) => item.kind).sort()).toEqual(["cold_started", "warm"]);
    expect(port.calls.openSession).toBe(1);
    expect(port.calls.sendWakePrompt).toBe(1);
  });

  // 并发消息若已换 Agent，旧会话的冷启动不能当作新会话的暖态，两条会话各需一次唤醒。
  test("并发换 Agent 时不同会话键各自冷启动", async () => {
    const port = createFakeImSessionPort();
    const bridge = createImSessionBridge({ port });

    const outcomes = await Promise.all([
      bridge.open(makeTarget({ rcsSessionId: "rcs_im_old" })),
      bridge.open(makeTarget({ rcsSessionId: "rcs_im_new" })),
    ]);

    expect(outcomes.map((item) => item.kind)).toEqual(["cold_started", "cold_started"]);
    expect(port.openInputs.map((item) => item.target.rcsSessionId)).toEqual(["rcs_im_old", "rcs_im_new"]);
    expect(port.calls.sendWakePrompt).toBe(2);
  });

  // 实例确保失败时链路立即中止：不打开会话、不发 prompt，由上层把事件标记为 failed。
  test("确保实例失败时不打开会话也不发 prompt", async () => {
    const port = createFakeImSessionPort();
    const bridge = createImSessionBridge({ port });
    port.failNextEnsure(new Error("spawn failed"));

    const error = await captureError(bridge.open(makeTarget()));

    expect(error.code).toBe("ENSURE_INSTANCE_FAILED");
    expect(port.calls.openSession).toBe(0);
    expect(port.calls.sendWakePrompt).toBe(0);
    expect(bridge.isWarm("conversation-1")).toBe(false);
  });

  // 会话打开失败同样中止，不能用通知代替尚未建立的会话。
  test("打开会话失败时不发送 prompt", async () => {
    const port = createFakeImSessionPort();
    const bridge = createImSessionBridge({ port });
    port.failNextOpen(new Error("handshake timeout"));

    const error = await captureError(bridge.open(makeTarget()));

    expect(error.code).toBe("OPEN_SESSION_FAILED");
    expect(port.calls.sendWakePrompt).toBe(0);
    expect(bridge.isWarm("conversation-1")).toBe(false);
  });
});
