import type { ImChannelEventStatus, ImChatType } from "@fenix/resource-channel/db";
import type { ImChannelRow } from "../server/repositories/im-channel";
import type { ImChannelConversationRow } from "../server/repositories/im-channel-conversation";
import type {
  ImChannelEventInsertInput,
  ImChannelEventRepository,
  ImChannelEventRow,
} from "../server/repositories/im-channel-event";
import type { ImChannelRouteRow } from "../server/repositories/im-channel-route";
import type { LangBotClient, LangBotSendMessageInput } from "../server/services/langbot/client";
import { type ConversationService, createConversationService } from "../server/services/langbot/conversation-service";
import {
  createDeliveryDispatcher,
  type DeliveryDispatcher,
  type DeliveryTimer,
} from "../server/services/langbot/delivery-dispatcher";
import type { ImSessionBridge } from "../server/services/langbot/im-session-bridge";
import { createInboundService, type InboundService } from "../server/services/langbot/inbound-service";
import { createImOutboundService, type ImOutboundService } from "../server/services/langbot/outbound-service";
import {
  createInMemoryChannelRepository,
  createInMemoryConversationRepository,
  createInMemoryRouteRepository,
  createStubLangBotClient,
  type InMemoryChannelRepository,
  type InMemoryConversationRepository,
  type InMemoryRouteRepository,
} from "./fixtures";

/**
 * 数据面用例的共享设施：内存事件仓储 + 真实入站/出站/会话/派发服务。
 *
 * 入站与出站的规则（去重、@ 校验、路由优先级、退避）都在服务层，替身它们只会测到路由转发，因此这里
 * 只替身持久化、LangBot 客户端与事务边界。事务用直通实现：真实事务会访问平台 DB，用例不连库。
 */

/** 用例密钥；与生产配置无关，只用于证明签名覆盖 conversationId。 */
export const IM_TEST_TOKEN_SECRET = "im-test-secret";

const EVENT_RECEIVED_AT = new Date("2026-01-01T00:00:00.000Z");

export function makeEvent(overrides: Partial<ImChannelEventRow> = {}): ImChannelEventRow {
  return {
    id: crypto.randomUUID(),
    channelId: "channel-1",
    eventUuid: crypto.randomUUID(),
    eventType: "bot.person_message",
    chatType: "person",
    chatId: "user-a",
    text: "你好",
    readAt: null,
    senderId: "user-a",
    agentConfigId: null,
    status: "received",
    deliveryVia: null,
    attempts: 1,
    lastError: null,
    ackSentAt: null,
    receivedAt: EVENT_RECEIVED_AT,
    processedAt: null,
    ...overrides,
  };
}

export interface InMemoryEventRepository extends ImChannelEventRepository {
  readonly rows: ImChannelEventRow[];
}

export function createInMemoryEventRepository(initial: ImChannelEventRow[] = []): InMemoryEventRepository {
  const rows = [...initial];

  function patchRow(eventId: string, patch: Partial<ImChannelEventRow>): void {
    const index = rows.findIndex((row) => row.id === eventId);
    const current = rows[index];
    if (!current) return;
    rows[index] = { ...current, ...patch };
  }

  return {
    rows,
    async findById({ eventId }) {
      return rows.find((row) => row.id === eventId);
    },
    async insertIfAbsent(input: ImChannelEventInsertInput) {
      // 唯一键 (channel_id, event_uuid) 是去重的唯一权威，替身也要按它判重。
      if (rows.some((row) => row.channelId === input.channelId && row.eventUuid === input.eventUuid)) return;
      const row = makeEvent({
        channelId: input.channelId,
        eventUuid: input.eventUuid,
        eventType: input.eventType,
        chatType: input.chatType,
        chatId: input.chatId,
        text: input.text ?? null,
        senderId: input.senderId ?? null,
        agentConfigId: input.agentConfigId ?? null,
        status: input.status,
        deliveryVia: input.deliveryVia ?? null,
        receivedAt: new Date(),
      });
      rows.push(row);
      return row;
    },
    async findUndeliveredByChat({ channelId, chatType, chatId, limit }) {
      const matched = rows
        .filter(
          (row) =>
            row.channelId === channelId &&
            row.chatType === chatType &&
            row.chatId === chatId &&
            row.status === "received",
        )
        .sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime());
      return limit === undefined ? matched : matched.slice(0, limit);
    },
    async findRecentByChat({ channelId, chatType, chatId, since, limit }) {
      return rows
        .filter(
          (row) =>
            row.channelId === channelId &&
            row.chatType === chatType &&
            row.chatId === chatId &&
            row.receivedAt.getTime() >= since.getTime(),
        )
        .sort((left, right) => right.receivedAt.getTime() - left.receivedAt.getTime())
        .slice(0, limit);
    },
    async findPendingPage({ channelId, chatType, chatId, after, limit }) {
      const pending = rows
        .filter(
          (row) =>
            row.channelId === channelId &&
            row.chatType === chatType &&
            row.chatId === chatId &&
            (row.status === "received" || row.status === "delivered") &&
            // 与真实仓储同口径：先比 received_at，再以主键决定同毫秒内的顺序。
            (after === undefined ||
              row.receivedAt.getTime() > after.receivedAt.getTime() ||
              (row.receivedAt.getTime() === after.receivedAt.getTime() && row.id > after.id)),
        )
        .sort((left, right) => {
          const byTime = left.receivedAt.getTime() - right.receivedAt.getTime();
          return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
        });
      return pending.slice(0, limit);
    },
    async countPendingByChat({ channelId, chatType, chatId }) {
      return rows.filter(
        (row) =>
          row.channelId === channelId &&
          row.chatType === chatType &&
          row.chatId === chatId &&
          (row.status === "received" || row.status === "delivered"),
      ).length;
    },
    async takeText({ eventId, readAt }) {
      const row = rows.find((item) => item.id === eventId);
      if (!row || row.text === null) return;
      const text = row.text;
      patchRow(eventId, { text: null, readAt });
      return text;
    },
    async markDelivered({ eventId, deliveryVia, at }) {
      patchRow(eventId, { status: "delivered", deliveryVia, processedAt: at });
    },
    async markFailed({ eventId, lastError, at }) {
      patchRow(eventId, { status: "failed", lastError, processedAt: at });
    },
    async markSkipped({ eventId, at }) {
      patchRow(eventId, { status: "skipped", processedAt: at });
    },
    async recordAttempt({ eventId, lastError }) {
      const row = rows.find((item) => item.id === eventId);
      if (!row) return;
      patchRow(eventId, { attempts: row.attempts + 1, lastError });
    },
    async markAckSent({ eventId, at }) {
      patchRow(eventId, { ackSentAt: at });
    },
    async markUnfinishedAsFailed({ reason, at }) {
      const unfinished: ImChannelEventStatus[] = ["received", "delivered"];
      let cleared = 0;
      for (const row of rows) {
        if (!unfinished.includes(row.status)) continue;
        patchRow(row.id, { status: "failed", lastError: reason, processedAt: at });
        cleared += 1;
      }
      return cleared;
    },
    async clearTextsBefore({ before }) {
      let cleared = 0;
      for (const row of rows) {
        if (row.text === null || row.receivedAt.getTime() >= before.getTime()) continue;
        patchRow(row.id, { text: null });
        cleared += 1;
      }
      return cleared;
    },
    async deleteTerminalBefore({ statuses, before }) {
      const keep = rows.filter(
        (row) => !(statuses.includes(row.status) && row.receivedAt.getTime() < before.getTime()),
      );
      const removed = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return removed;
    },
  };
}

export interface RecordedSend {
  readonly botUuid: string;
  readonly input: LangBotSendMessageInput;
}

export interface RecordedNotice {
  readonly channelId: string;
  readonly chatType: ImChatType;
  readonly chatId: string;
  readonly senderId: string | null;
  readonly text: string;
}

export interface DataPlaneTestContext {
  readonly channels: InMemoryChannelRepository;
  readonly routes: InMemoryRouteRepository;
  readonly conversations: InMemoryConversationRepository;
  readonly events: InMemoryEventRepository;
  readonly client: LangBotClient;
  readonly conversationService: ConversationService;
  readonly inbound: InboundService;
  readonly outbound: ImOutboundService;
  readonly dispatcher: DeliveryDispatcher;
  /** 已发送到 LangBot 的消息，按调用顺序。 */
  readonly sent: RecordedSend[];
  /** 非文本事件的固定提示记录。 */
  readonly notices: RecordedNotice[];
  /** 冷启动失败的固定提示记录（规格 §6.3）。 */
  readonly failureNotices: RecordedNotice[];
  readonly transactions: { count: number };
}

export interface DataPlaneTestInput {
  channels?: ImChannelRow[];
  routes?: ImChannelRouteRow[];
  conversations?: ImChannelConversationRow[];
  events?: ImChannelEventRow[];
  tokenSecret?: string;
  now?: () => Date;
  timer?: DeliveryTimer;
  generateConversationId?: () => string;
  /** 替换发送实现；默认记录到 `sent`。抛错路径用它验证错误映射。 */
  sendMessage?: (botUuid: string, input: LangBotSendMessageInput) => Promise<void>;
  /** 冷启动桥接；不传时入站退化为「只入队通知」（生产装配前的行为）。 */
  bridge?: ImSessionBridge;
  /** 响应后异步执行器；用例传入会收集 Promise 的实现以便断言投递结果。 */
  afterResponse?: (task: Promise<void>) => void;
}

/** 构造数据面服务；调用方在 `afterEach` 里执行 `context.dispatcher.stop()`。 */
export function createDataPlaneTestContext(input: DataPlaneTestInput = {}): DataPlaneTestContext {
  const channels = createInMemoryChannelRepository(input.channels);
  const routes = createInMemoryRouteRepository(input.routes);
  const conversations = createInMemoryConversationRepository(input.conversations);
  const events = createInMemoryEventRepository(input.events);
  const sent: RecordedSend[] = [];
  const notices: RecordedNotice[] = [];
  const failureNotices: RecordedNotice[] = [];
  const transactions = { count: 0 };

  const client = createStubLangBotClient({
    sendMessage:
      input.sendMessage ??
      (async (botUuid, message) => {
        sent.push({ botUuid, input: message });
      }),
  });
  const now = input.now ?? (() => new Date());
  const conversationService = createConversationService({
    conversations,
    ...(input.generateConversationId ? { generateId: input.generateConversationId } : {}),
  });
  const dispatcher = createDeliveryDispatcher({
    events,
    conversations,
    now,
    ...(input.timer ? { timer: input.timer } : {}),
  });
  const outbound = createImOutboundService({
    client,
    channels,
    conversations,
    routes,
    events,
    tokenSecret: () => input.tokenSecret ?? IM_TEST_TOKEN_SECRET,
    now,
  });
  const inbound = createInboundService({
    channels,
    routes,
    conversations,
    events,
    conversationService,
    dispatcher,
    now,
    transaction: async (callback) => {
      transactions.count += 1;
      return callback();
    },
    // 用记录器替身：固定提示是否真的发出由 outbound 自己的用例覆盖，这里只断言触发条件与文案。
    notifyUnsupported: (notice) => {
      notices.push({
        channelId: notice.channel.id,
        chatType: notice.chatType,
        chatId: notice.chatId,
        senderId: notice.senderId,
        text: notice.text,
      });
    },
    notifyFailure: (notice) => {
      failureNotices.push({
        channelId: notice.channel.id,
        chatType: notice.chatType,
        chatId: notice.chatId,
        senderId: notice.senderId,
        text: notice.text,
      });
    },
    ...(input.bridge ? { bridge: input.bridge } : {}),
    ...(input.afterResponse ? { afterResponse: input.afterResponse } : {}),
  });

  return {
    channels,
    routes,
    conversations,
    events,
    client,
    conversationService,
    inbound,
    outbound,
    dispatcher,
    sent,
    notices,
    failureNotices,
    transactions,
  };
}
