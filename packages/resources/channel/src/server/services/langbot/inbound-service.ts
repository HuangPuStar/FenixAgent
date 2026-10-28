import { error as logError } from "@fenix/logger";
import { runInTransaction } from "@fenix/platform-sdk/server";
import type { ImChatType } from "@fenix/resource-channel/db";
import type { ImSessionTarget } from "../../ports/im-session";
import type { ImChannelRepository, ImChannelRow } from "../../repositories/im-channel";
import type {
  ImChannelConversationRepository,
  ImChannelConversationRow,
} from "../../repositories/im-channel-conversation";
import type { ImChannelEventRepository } from "../../repositories/im-channel-event";
import type { ImChannelRouteRepository } from "../../repositories/im-channel-route";
import type { ConversationService } from "./conversation-service";
import type { DeliveryDispatcher } from "./delivery-dispatcher";
import { type ImSessionBridge, ImSessionBridgeError, type ImSessionOpenOutcome } from "./im-session-bridge";
import { findActiveRoute } from "./route-service";
import { readBotUuid } from "./types";

/**
 * LangBot Webhook 入站（规格 §4.3 / §6.1）。
 *
 * 职责只有一条链：校验 → 解析 → 事务内去重落库 + 路由 + conversation → 事务提交后投递通知。
 * 所有 I/O 之外的行为都在这里，路由层只做协议映射。
 *
 * 关键边界：
 * 1. 去重必须由数据库唯一键原子拦截（`insertIfAbsent`），不能先查后插：多实例与重启后重投都靠它。
 * 2. 没有订阅流时事件保持 `received`，由 dispatcher 退避重试；这里只负责入队，不等待 Agent。
 * 3. 群聊只接受直接 @ 的消息；LangBot Webhook 不提供机器人自身 IM ID，因此「直接 At」是当前能判定的
 *    最强条件，AtAll 不算直接 @（规格 §6.1.1）。
 * 4. 非文本事件只落 `skipped` 并回固定提示，不进入 Agent。
 */

export type ImInboundEventType = "bot.person_message" | "bot.group_message";

export type InboundRejectionReason =
  | "channel_missing"
  | "channel_disabled"
  | "bot_mismatch"
  | "unsupported_event"
  | "not_mentioned"
  | "invalid_payload";

export type InboundOutcome =
  | {
      readonly kind: "accepted";
      readonly eventId: string;
      readonly conversationId: string;
      readonly agentChanged: boolean;
    }
  | { readonly kind: "duplicate" }
  | { readonly kind: "skipped"; readonly eventId: string; readonly reason: "no_route" | "non_text" }
  | { readonly kind: "rejected"; readonly reason: InboundRejectionReason };

export interface InboundService {
  handle(input: { channelId: string; payload: unknown }): Promise<InboundOutcome>;
}

export interface InboundServiceDeps {
  readonly channels: ImChannelRepository;
  readonly routes: ImChannelRouteRepository;
  readonly conversations: ImChannelConversationRepository;
  readonly events: ImChannelEventRepository;
  readonly conversationService: ConversationService;
  readonly dispatcher: DeliveryDispatcher;
  /**
   * 冷启动桥；未装配时退化为「只入队通知」。
   *
   * 生产必须装配：暖会话的通知依赖 Agent 的 MCP 订阅，而订阅只在首个 turn 注册；没有桥就不会有人
   * 启动实例、发送唤醒，事件会无限退避。
   */
  readonly bridge?: ImSessionBridge;
  /** 测试注入；默认使用平台 REQUIRED 事务。 */
  readonly transaction?: <T>(callback: () => Promise<T>) => Promise<T>;
  readonly now?: () => Date;
  /** 非文本固定提示；生产接 outbound，失败只记日志。 */
  readonly notifyUnsupported?: (input: {
    channel: ImChannelRow;
    chatType: ImChatType;
    chatId: string;
    senderId: string | null;
    text: string;
  }) => void | Promise<void>;
  /** 实例启动 / 会话打开失败的固定提示（规格 §6.3）；与通知一样由平台代发。 */
  readonly notifyFailure?: (input: {
    channel: ImChannelRow;
    chatType: ImChatType;
    chatId: string;
    senderId: string | null;
    text: string;
  }) => void | Promise<void>;
  /** 响应后的异步执行器；测试注入以便 await，生产保持 fire-and-forget。 */
  readonly afterResponse?: (task: Promise<void>) => void;
}

interface ParsedInboundEvent {
  readonly eventUuid: string;
  readonly eventType: ImInboundEventType;
  readonly chatType: ImChatType;
  readonly chatId: string;
  readonly senderId: string;
  readonly text: string;
  readonly mentioned: boolean;
  readonly nonText: boolean;
}

type ParseResult =
  | { readonly ok: true; readonly event: ParsedInboundEvent }
  | { readonly ok: false; readonly reason: InboundRejectionReason };

const TEXT_ONLY_NOTICE = "当前仅支持文本消息。";
const BUSY_NOTICE = "系统繁忙，请稍后重试。";
/** 冷启动 prompt 已覆盖会话积压；收口上限与 dispatcher 的补发上限保持一致。 */
const PENDING_DELIVERY_LIMIT = 100;
/** 这些组件属于消息结构，不是正文；其余未知组件一律按「非文本」处理。 */
const STRUCTURAL_COMPONENTS = new Set(["At", "AtAll", "Quote", "Source"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readMentionTarget(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * 解析 LangBot Webhook 事件体。
 *
 * Webhook 文档的消息字段叫 `message`，而消息实体文档叫 `message_chain`；两者都接受，避免上游版本差异
 * 让整条入站链路静默失效。
 */
function parseEvent(payload: unknown, expectedBotUuid: string | null): ParseResult {
  const outer = asRecord(payload);
  const data = outer ? asRecord(outer.data) : null;
  if (!outer || !data) return { ok: false, reason: "invalid_payload" };

  const eventUuid = readString(outer, "uuid");
  const rawEventType = readString(outer, "event_type");
  if (!eventUuid || !rawEventType) return { ok: false, reason: "invalid_payload" };
  if (rawEventType !== "bot.person_message" && rawEventType !== "bot.group_message") {
    return { ok: false, reason: "unsupported_event" };
  }
  const eventType: ImInboundEventType = rawEventType;

  const botUuid = readString(data, "bot_uuid");
  if (!botUuid || !expectedBotUuid || botUuid !== expectedBotUuid) {
    return { ok: false, reason: "bot_mismatch" };
  }

  const sender = asRecord(data.sender);
  const senderId = sender ? readString(sender, "id") : null;
  if (!senderId) return { ok: false, reason: "invalid_payload" };

  const chatType: ImChatType = eventType === "bot.group_message" ? "group" : "person";
  let chatId = senderId;
  if (chatType === "group") {
    const group = asRecord(data.group);
    const groupId = group ? readString(group, "id") : null;
    if (!groupId) return { ok: false, reason: "invalid_payload" };
    chatId = groupId;
  }

  const components = data.message ?? data.message_chain;
  if (!Array.isArray(components) || components.length === 0) return { ok: false, reason: "invalid_payload" };

  const texts: string[] = [];
  let mentioned = false;
  let nonText = false;
  for (const rawComponent of components) {
    const component = asRecord(rawComponent);
    const type = component ? readString(component, "type") : null;
    if (!component || !type) {
      nonText = true;
      continue;
    }
    if (type === "Plain") {
      const text = component.text;
      if (typeof text === "string") texts.push(text);
      else nonText = true;
      continue;
    }
    if (type === "At") {
      if (readMentionTarget(component.target)) mentioned = true;
      continue;
    }
    if (STRUCTURAL_COMPONENTS.has(type)) continue;
    nonText = true;
  }

  const text = texts.join("");
  // 纯 @ 或纯图片都没有可处理正文；统一按非文本处理，走固定提示。
  if (!nonText && text.length === 0) nonText = true;
  if (chatType === "group" && !nonText && !mentioned) return { ok: false, reason: "not_mentioned" };

  return {
    ok: true,
    event: { eventUuid, eventType, chatType, chatId, senderId, text, mentioned, nonText },
  };
}

export function createInboundService(deps: InboundServiceDeps): InboundService {
  const transaction = deps.transaction ?? runInTransaction;
  const now = deps.now ?? (() => new Date());

  async function recordAndRoute(channel: ImChannelRow, event: ParsedInboundEvent, at: Date): Promise<InboundOutcome> {
    // 事务内先做去重与路由，再创建会话：事件行与会话映射要么一起成立，要么一起回滚。
    const route = event.nonText
      ? null
      : await findActiveRoute(deps.routes, {
          channelId: channel.id,
          chatType: event.chatType,
          chatId: event.chatId,
        });

    const inserted = await deps.events.insertIfAbsent({
      channelId: channel.id,
      eventUuid: event.eventUuid,
      eventType: event.eventType,
      chatType: event.chatType,
      chatId: event.chatId,
      text: event.nonText ? null : event.text,
      senderId: event.senderId,
      agentConfigId: route?.agentConfigId ?? null,
      status: "received",
    });
    if (!inserted) return { kind: "duplicate" };

    if (event.nonText || !route) {
      await deps.events.markSkipped({ eventId: inserted.id, at });
      return {
        kind: "skipped",
        eventId: inserted.id,
        reason: event.nonText ? "non_text" : "no_route",
      };
    }

    const ensured = await deps.conversationService.ensure({
      channelId: channel.id,
      ownerUserId: channel.userId,
      chatType: event.chatType,
      chatId: event.chatId,
      agentConfigId: route.agentConfigId,
    });
    await deps.conversations.touchLastEventAt({ conversationId: ensured.conversation.id, at });

    return {
      kind: "accepted",
      eventId: inserted.id,
      conversationId: ensured.conversation.id,
      agentChanged: ensured.agentChanged,
    };
  }

  /**
   * 冷启动 prompt 会读取 inbox 中的全部积压，因此把仍为 `received` 的事件一并标成 `prompt` 投递。
   *
   * 只标当前事件会让同一个 inbox 的旧事件继续走退避重试，订阅建立后重复唤醒 Agent。
   */
  async function markPromptDelivered(input: {
    channel: ImChannelRow;
    conversation: ImChannelConversationRow;
    acpSessionId: string;
    at: Date;
  }): Promise<void> {
    if (input.conversation.acpSessionId !== input.acpSessionId) {
      await deps.conversations.updateAcpSession({
        conversationId: input.conversation.id,
        acpSessionId: input.acpSessionId,
      });
    }
    const pending = await deps.events.findUndeliveredByChat({
      channelId: input.channel.id,
      chatType: input.conversation.chatType,
      chatId: input.conversation.chatId,
      limit: PENDING_DELIVERY_LIMIT,
    });
    for (const row of pending) {
      await deps.events.markDelivered({ eventId: row.id, deliveryVia: "prompt", at: input.at });
    }
  }

  /** 响应后的异步投递：冷启动走一次 prompt，暖态只发订阅通知；失败按 §6.3 落 failed 并回固定提示。 */
  async function deliverAccepted(input: {
    bridge: ImSessionBridge;
    channel: ImChannelRow;
    event: ParsedInboundEvent;
    eventId: string;
    conversationId: string;
    at: Date;
  }): Promise<void> {
    const conversation = await deps.conversations.findById({ conversationId: input.conversationId });
    if (!conversation) return;

    const target: ImSessionTarget = {
      channelId: input.channel.id,
      conversationId: conversation.id,
      organizationId: input.channel.organizationId,
      ownerUserId: input.channel.userId,
      agentConfigId: conversation.agentConfigId,
      rcsSessionId: conversation.rcsSessionId,
      acpSessionId: conversation.acpSessionId,
    };

    let opened: ImSessionOpenOutcome;
    try {
      opened = await input.bridge.open(target);
    } catch (error) {
      const lastError = error instanceof ImSessionBridgeError ? error.code : "COLD_START_FAILED";
      try {
        await deps.events.markFailed({ eventId: input.eventId, lastError, at: input.at });
      } catch (markError) {
        logError("IM 事件失败状态写入失败", markError instanceof Error ? markError : undefined);
      }
      await deps.notifyFailure?.({
        channel: input.channel,
        chatType: input.event.chatType,
        chatId: input.event.chatId,
        senderId: input.event.senderId,
        text: BUSY_NOTICE,
      });
      return;
    }

    if (opened.kind === "warm") {
      deps.dispatcher.enqueue({ eventId: input.eventId, conversationId: conversation.id });
      return;
    }

    try {
      await markPromptDelivered({
        channel: input.channel,
        conversation,
        acpSessionId: opened.acpSessionId,
        at: input.at,
      });
    } catch (error) {
      // prompt 已被接受，状态写入失败不能把一次成功的投递改判为失败。
      logError("IM 冷启动后状态写入失败", error instanceof Error ? error : undefined);
    }
  }

  function runInBackground(task: Promise<void>): void {
    void task.catch((error) => {
      logError("IM 入站投递任务失败", error instanceof Error ? error : undefined);
    });
  }

  return {
    async handle(input) {
      const channel = await deps.channels.findById({ channelId: input.channelId });
      // 非 langbot 通道按不存在处理：不暴露平台还有哪些通道类型。
      if (channel?.platform !== "langbot") return { kind: "rejected", reason: "channel_missing" };
      if (!channel.enabled) return { kind: "rejected", reason: "channel_disabled" };

      const parsed = parseEvent(input.payload, readBotUuid(channel.credentials));
      if (!parsed.ok) return { kind: "rejected", reason: parsed.reason };
      const event = parsed.event;
      const at = now();

      const outcome = await transaction(() => recordAndRoute(channel, event, at));

      if (outcome.kind === "accepted") {
        // 实例启动与会话打开都在响应后异步执行（规格 §4.3.6）；没有桥时才退化为直接入队。
        if (!deps.bridge) {
          deps.dispatcher.enqueue({ eventId: outcome.eventId, conversationId: outcome.conversationId });
        } else {
          const task = deliverAccepted({
            bridge: deps.bridge,
            channel,
            event,
            eventId: outcome.eventId,
            conversationId: outcome.conversationId,
            at,
          });
          (deps.afterResponse ?? runInBackground)(task);
        }
      } else if (outcome.kind === "skipped" && outcome.reason === "non_text") {
        void deps.notifyUnsupported?.({
          channel,
          chatType: event.chatType,
          chatId: event.chatId,
          senderId: event.senderId,
          text: TEXT_ONLY_NOTICE,
        });
      }

      return outcome;
    },
  };
}
