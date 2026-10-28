import { afterEach, describe, expect, test } from "bun:test";
import type { ImChannelEventRow } from "../server/repositories/im-channel-event";
import {
  type DeliveryTimer,
  IM_INBOX_RESOURCE_URI,
  type ImSubscriptionSink,
} from "../server/services/langbot/delivery-dispatcher";
import {
  clearExpiredImEventTexts,
  markInterruptedImDeliveriesFailed,
  runImEventMaintenance,
} from "../server/services/langbot/event-maintenance";
import {
  createDataPlaneTestContext,
  type DataPlaneTestContext,
  type DataPlaneTestInput,
  makeEvent,
} from "./data-plane-fixtures";
import { makeChannel, makeConversation } from "./fixtures";

/**
 * 通知派发与事件维护回归（规格 §4.6 / §5.5 / §6.3）。
 *
 * 通知是 K 型事件：只带资源 URI，不带正文；没有订阅时事件保持 received 并按 1s/2s/4s… 退避，
 * 重启后遗留事件直接标记失败、不重放。
 */

const CHANNEL_ID = "0f0e0d0c-0b0a-4a49-8b8a-090807060504";
const CONVERSATION_ID = "conversation-a";
const NOW = new Date("2026-06-01T00:00:00.000Z");

interface FakeTimer extends DeliveryTimer {
  readonly delays: number[];
  runNext(): void;
}

/** 只记录延时并允许手动推进；退避节奏必须能在用例里被确定性地观察。 */
function createFakeTimer(): FakeTimer {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  const timer: FakeTimer = {
    delays,
    setTimeout(callback, delayMs) {
      const handle = nextHandle;
      nextHandle += 1;
      delays.push(delayMs);
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      callbacks.delete(handle as number);
    },
    runNext() {
      const entry = callbacks.entries().next().value;
      if (!entry) return;
      const [handle, callback] = entry;
      callbacks.delete(handle);
      callback();
    },
  };
  return timer;
}

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const contexts: DataPlaneTestContext[] = [];

afterEach(() => {
  for (const context of contexts.splice(0)) context.dispatcher.stop();
});

function setup(input: DataPlaneTestInput = {}): DataPlaneTestContext {
  const context = createDataPlaneTestContext({
    channels: [makeChannel({ id: CHANNEL_ID })],
    conversations: [
      makeConversation({
        id: CONVERSATION_ID,
        channelId: CHANNEL_ID,
        chatType: "person",
        chatId: "user-a",
        acpSessionId: null,
      }),
    ],
    now: () => NOW,
    ...input,
  });
  contexts.push(context);
  return context;
}

function makeInboxEvent(overrides: Partial<ImChannelEventRow> = {}): ImChannelEventRow {
  return makeEvent({
    channelId: CHANNEL_ID,
    chatType: "person",
    chatId: "user-a",
    status: "received",
    ...overrides,
  });
}

describe("IM 通知派发", () => {
  // 没有订阅流时事件必须保持 received，并按 1s/2s/4s… 退避，上限 30s；不能改写成失败。
  test("无订阅时保持 received 并按指数退避重试", async () => {
    const timer = createFakeTimer();
    const event = makeInboxEvent();
    const context = setup({ events: [event], timer });

    context.dispatcher.enqueue({ eventId: event.id, conversationId: CONVERSATION_ID });
    await flushAsync();
    expect(context.events.rows[0]!.status).toBe("received");
    expect(timer.delays).toEqual([1_000]);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      timer.runNext();
      await flushAsync();
    }
    expect(timer.delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(context.events.rows[0]!.status).toBe("received");
  });

  // 订阅注册后必须补发积压事件；通知只带 URI，正文只能由 Agent 走 resources/read 读取。
  test("订阅补发只发送资源 URI 并标记 delivered", async () => {
    const timer = createFakeTimer();
    const event = makeInboxEvent({ text: "敏感正文" });
    const context = setup({ events: [event], timer });
    const notifications: unknown[] = [];
    const sink: ImSubscriptionSink = {
      notifyResourceUpdated: (input) => {
        notifications.push(input);
      },
    };

    context.dispatcher.subscribe(CONVERSATION_ID, sink);
    await flushAsync();

    expect(notifications).toEqual([{ uri: IM_INBOX_RESOURCE_URI }]);
    expect(JSON.stringify(notifications)).not.toContain("敏感正文");
    expect(context.events.rows[0]!.status).toBe("delivered");
    expect(context.events.rows[0]!.deliveryVia).toBe("notification");
  });

  // 订阅按 conversation 隔离；一个会话的补发不能唤醒另一个会话的 Agent。
  test("订阅按会话隔离", async () => {
    const otherConversationId = "conversation-b";
    const ownEvent = makeInboxEvent();
    const otherEvent = makeInboxEvent({ chatId: "user-b" });
    const context = setup({
      conversations: [
        makeConversation({
          id: CONVERSATION_ID,
          channelId: CHANNEL_ID,
          chatType: "person",
          chatId: "user-a",
          acpSessionId: null,
        }),
        makeConversation({
          id: otherConversationId,
          channelId: CHANNEL_ID,
          chatType: "person",
          chatId: "user-b",
          acpSessionId: null,
        }),
      ],
      events: [ownEvent, otherEvent],
    });
    const notifications: unknown[] = [];

    context.dispatcher.subscribe(CONVERSATION_ID, {
      notifyResourceUpdated: (input) => {
        notifications.push(input);
      },
    });
    await flushAsync();

    expect(notifications).toHaveLength(1);
    expect(context.events.rows.find((row) => row.id === ownEvent.id)!.status).toBe("delivered");
    expect(context.events.rows.find((row) => row.id === otherEvent.id)!.status).toBe("received");
    expect(context.dispatcher.subscriptionCount(otherConversationId)).toBe(0);
  });
});

describe("IM 事件维护", () => {
  // 上一个进程遗留的 received / delivered 不可能再被本进程投递：启动时一次性标记失败，不重放。
  test("重启把遗留的 received 与 delivered 标记为 failed", async () => {
    const context = setup({
      events: [
        makeInboxEvent({ status: "received" }),
        makeInboxEvent({ status: "delivered" }),
        makeInboxEvent({ status: "skipped" }),
      ],
    });

    const cleared = await markInterruptedImDeliveriesFailed({ events: context.events, at: NOW });

    expect(cleared).toBe(2);
    expect(context.events.rows.map((row) => row.status)).toEqual(["failed", "failed", "skipped"]);
    expect(context.events.rows[0]!.lastError).toBe("restart");
    expect(context.events.rows[0]!.processedAt).toEqual(NOW);
  });

  // 正文只允许被读取一次：第一次取出后立即置空，重复读取拿不到内容，暴露窗口不超过一次 resources/read。
  test("读取正文后立即清空", async () => {
    const event = makeInboxEvent({ text: "只读一次" });
    const context = setup({ events: [event] });

    const first = await context.events.takeText({ eventId: event.id, readAt: NOW });
    const second = await context.events.takeText({ eventId: event.id, readAt: NOW });

    expect(first).toBe("只读一次");
    expect(second).toBeUndefined();
    expect(context.events.rows[0]!.text).toBeNull();
    expect(context.events.rows[0]!.readAt).toEqual(NOW);
  });

  // 正文只在 TTL 内保留：过期事件清空 text 但保留行与状态，投递元数据仍可审计。
  test("只清空超过 TTL 的正文", async () => {
    const expired = makeInboxEvent({ receivedAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1_000) });
    const fresh = makeInboxEvent({ receivedAt: new Date(NOW.getTime() - 60 * 60 * 1_000) });
    const context = setup({ events: [expired, fresh] });

    const cleared = await clearExpiredImEventTexts({ events: context.events, ttlHours: 24, now: NOW });

    expect(cleared).toBe(1);
    expect(context.events.rows.find((row) => row.id === expired.id)!.text).toBeNull();
    expect(context.events.rows.find((row) => row.id === fresh.id)!.text).toBe("你好");
    expect(context.events.rows).toHaveLength(2);
  });

  // 终态事件行按状态保留 7 / 30 天：过期即删，未过期（含正好落在边界上）必须留下。
  test("删除过期的终态事件并保留未过期行", async () => {
    const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);
    const expiredDelivered = makeInboxEvent({ status: "delivered", receivedAt: daysAgo(8) });
    const freshDelivered = makeInboxEvent({ status: "delivered", receivedAt: daysAgo(6) });
    const boundaryDelivered = makeInboxEvent({ status: "delivered", receivedAt: daysAgo(7) });
    const expiredSkipped = makeInboxEvent({ status: "skipped", receivedAt: daysAgo(8) });
    const freshSkipped = makeInboxEvent({ status: "skipped", receivedAt: daysAgo(6) });
    const expiredFailed = makeInboxEvent({ status: "failed", receivedAt: daysAgo(31) });
    const freshFailed = makeInboxEvent({ status: "failed", receivedAt: daysAgo(29) });
    const boundaryFailed = makeInboxEvent({ status: "failed", receivedAt: daysAgo(30) });
    const pending = makeInboxEvent({ status: "received", receivedAt: daysAgo(40) });
    const context = setup({
      events: [
        expiredDelivered,
        freshDelivered,
        boundaryDelivered,
        expiredSkipped,
        freshSkipped,
        expiredFailed,
        freshFailed,
        boundaryFailed,
        pending,
      ],
    });

    const result = await runImEventMaintenance({ events: context.events, ttlHours: 24, now: NOW });

    expect(result).toMatchObject({ deliveredDeleted: 1, skippedDeleted: 1, failedDeleted: 1 });
    expect(context.events.rows.map((row) => row.id).sort()).toEqual(
      [freshDelivered, boundaryDelivered, freshSkipped, freshFailed, boundaryFailed, pending]
        .map((row) => row.id)
        .sort(),
    );
  });
});
