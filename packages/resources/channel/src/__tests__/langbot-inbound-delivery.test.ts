import { afterEach, describe, expect, test } from "bun:test";
import {
  createImSessionBridge,
  IM_WAKE_PROMPT_TEXT,
  type ImSessionBridge,
  ImSessionBridgeError,
} from "../server/services/langbot/im-session-bridge";
import { createDataPlaneTestContext, type DataPlaneTestContext, type DataPlaneTestInput } from "./data-plane-fixtures";
import { makeChannel, makeRoute } from "./fixtures";
import { createFakeImSessionPort } from "./im-session-fake";

/**
 * 入站事务提交后的投递分支（规格 §6.1 第 5-7 步 / §6.3）。
 *
 * 检验的是「接受的事件不会停在 received」这条生产链路：冷启动走一次通用唤醒并按 prompt 收口，
 * 暖态走订阅通知，失败则落 failed 并回固定提示。服务规则本身在 `langbot-inbound.test.ts`。
 */

const CHANNEL_ID = "0f0e0d0c-0b0a-4a49-8b8a-090807060504";

function makePayload(): Record<string, unknown> {
  return {
    uuid: crypto.randomUUID(),
    event_type: "bot.person_message",
    data: {
      bot_uuid: "bot-1",
      sender: { id: "user-a", name: "Sender" },
      message: [{ type: "Plain", text: "你好" }],
    },
  };
}

const contexts: DataPlaneTestContext[] = [];

function setup(input: DataPlaneTestInput): { context: DataPlaneTestContext; tasks: Promise<void>[] } {
  const tasks: Promise<void>[] = [];
  const context = createDataPlaneTestContext({
    channels: [makeChannel({ id: CHANNEL_ID })],
    routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: null, agentConfigId: "agent-1" })],
    ...input,
    // 用例需要等待异步投递结果；生产的 fire-and-forget 行为由默认执行器覆盖。
    afterResponse: (task) => {
      tasks.push(task);
    },
  });
  contexts.push(context);
  return { context, tasks };
}

afterEach(() => {
  for (const context of contexts.splice(0)) context.dispatcher.stop();
});

describe("LangBot 入站投递", () => {
  // 冷启动只发一次通用唤醒，并把事件与 conversation 的 ACP 会话落库；不得再排通知。
  test("冷启动发送唤醒 prompt 并把事件标为 prompt 投递", async () => {
    const port = createFakeImSessionPort();
    const { context, tasks } = setup({ bridge: createImSessionBridge({ port }) });

    const outcome = await context.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() });
    expect(outcome.kind).toBe("accepted");
    expect(tasks).toHaveLength(1);
    await tasks[0];

    expect(port.calls.sendWakePrompt).toBe(1);
    expect(port.wakePrompts).toEqual([IM_WAKE_PROMPT_TEXT]);
    const event = context.events.rows[0]!;
    expect(event.status).toBe("delivered");
    expect(event.deliveryVia).toBe("prompt");
    expect(context.conversations.rows[0]!.acpSessionId).toBe("ses_fake_1");
    expect(context.failureNotices).toHaveLength(0);
  });

  // 暖会话依赖 Agent 的 MCP 订阅：只发通知，不再重复消耗一次 prompt。
  test("暖会话只投递订阅通知", async () => {
    const port = createFakeImSessionPort();
    const { context, tasks } = setup({ bridge: createImSessionBridge({ port }) });

    await context.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() });
    await tasks[0];

    const conversationId = context.conversations.rows[0]!.id;
    let notified = 0;
    context.dispatcher.subscribe(conversationId, {
      notifyResourceUpdated: () => {
        notified += 1;
      },
    });

    await context.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() });
    await tasks[1];
    await Bun.sleep(0);

    expect(port.calls.sendWakePrompt).toBe(1);
    expect(notified).toBe(1);
    const second = context.events.rows[1]!;
    expect(second.status).toBe("delivered");
    expect(second.deliveryVia).toBe("notification");
  });

  // 实例或会话启动失败不能让消息静默退避：事件落 failed，并由平台回固定提示（规格 §6.3）。
  test("冷启动失败时事件落 failed 并回固定提示", async () => {
    const bridge: ImSessionBridge = {
      open: () =>
        Promise.reject(new ImSessionBridgeError("ENSURE_INSTANCE_FAILED", "conversation-1", "IM 专属实例启动失败")),
      invalidate: () => undefined,
      isWarm: () => false,
    };
    const { context, tasks } = setup({ bridge });

    await context.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() });
    await tasks[0];

    const event = context.events.rows[0]!;
    expect(event.status).toBe("failed");
    expect(event.lastError).toBe("ENSURE_INSTANCE_FAILED");
    expect(context.failureNotices).toEqual([
      {
        channelId: CHANNEL_ID,
        chatType: "person",
        chatId: "user-a",
        senderId: "user-a",
        text: "系统繁忙，请稍后重试。",
      },
    ]);
  });
});
