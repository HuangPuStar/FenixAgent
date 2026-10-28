import { error as logError } from "@fenix/logger";
import type { ImChatType } from "@fenix/resource-channel/db";
import { getChannelConfig } from "../../config";
import { ChannelControlError } from "../../contracts";
import type { ImChannelRepository, ImChannelRow } from "../../repositories/im-channel";
import type {
  ImChannelConversationRepository,
  ImChannelConversationRow,
} from "../../repositories/im-channel-conversation";
import type { ImChannelEventRepository } from "../../repositories/im-channel-event";
import type { ImChannelRouteRepository } from "../../repositories/im-channel-route";
import type { LangBotClient } from "./client";
import { verifyImToken } from "./im-token";
import { findActiveRoute } from "./route-service";
import { readBotUuid } from "./types";

/**
 * IM 出站回复（规格 §4.4 / §6.2）。
 *
 * `im_reply` 的唯一实现：连接 token 决定 conversation，工具参数不接受 `chat_id`。职责边界：
 * 1. 只发 Agent 给的文本，不聚合、不改写、不替它排序。
 * 2. 按 4000 字符切片，@ 只拼在第一片，避免后续每片都提醒一次。
 * 3. 群聊只允许 @ 该会话近期事件里出现过的 sender，`@all` 一类保留词直接拒绝；私聊不加 At。
 * 4. `send_message` 没有幂等键：只在客户端判定为可重试的失败（上游 5xx / 429 / 连接失败）时立即重试一次
 *    （此时请求是否已被接受未知，规格 §6.3 接受这一窗口）；4xx、业务拒绝与参数错误不重试。同一
 *    conversation + 相同文本 5 秒内重复调用返回上次成功结果（best effort，进程内）。
 *
 * 错误一律结构化返回，消息里不含 LangBot 响应体、API Key 或 token。
 */

export const IM_REPLY_CHUNK_SIZE = 4_000;
/** 单次回复最多切片数：防止模型一次输出把通道打成无界发送循环。 */
export const IM_REPLY_MAX_CHUNKS = 20;
const MENTION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;
const MENTION_LOOKBACK_LIMIT = 200;
const DUPLICATE_WINDOW_MS = 5_000;
const DUPLICATE_CACHE_SIZE = 200;
/** 每个分片的最多尝试次数（首次 + 一次重试）。 */
const SEND_ATTEMPTS = 2;

/** 只有上游标记为可重试的失败（5xx / 429 / 连接失败）再试一次；4xx 与业务拒绝重试无意义。 */
function isRetryableSendError(error: unknown): boolean {
  return error instanceof ChannelControlError && error.retryable;
}

/** 规格 §4.4.5 的错误码；`TOKEN_INVALID` 由 MCP 层映射为 401。 */
export type ImReplyErrorCode = "TOKEN_INVALID" | "MENTION_NOT_ALLOWED" | "LANGBOT_UNREACHABLE" | "SEND_FAILED";

export interface ImReplySuccess {
  readonly ok: true;
}

export interface ImReplyFailure {
  readonly ok: false;
  readonly error: { readonly code: ImReplyErrorCode; readonly message: string };
}

export type ImReplyResult = ImReplySuccess | ImReplyFailure;

export interface ImOutboundService {
  reply(input: { token: string; text: string; mentionUserId?: string | null }): Promise<ImReplyResult>;
  /**
   * 已认证连接（MCP `im_reply`）直接按 conversation 回复。
   *
   * 调用方必须从连接凭据解析 conversationId：本方法不参与鉴权，只复用同一套通道、路由、@ 校验与分片。
   */
  replyToConversation(input: {
    conversationId: string;
    text: string;
    mentionUserId?: string | null;
  }): Promise<ImReplyResult>;
  /** 非文本事件的固定提示；失败只记日志，不影响入站响应。 */
  notifyUnsupported(input: {
    channel: ImChannelRow;
    chatType: ImChatType;
    chatId: string;
    senderId: string | null;
    text: string;
  }): Promise<void>;
}

export interface ImOutboundServiceDeps {
  readonly client: LangBotClient;
  readonly channels: ImChannelRepository;
  readonly conversations: ImChannelConversationRepository;
  readonly routes: ImChannelRouteRepository;
  readonly events: ImChannelEventRepository;
  /** 测试注入；生产按调用时读取模块配置，配置缺失时校验必失败。 */
  readonly tokenSecret?: () => string | undefined;
  readonly now?: () => Date;
}

/** 按字符（不是 UTF-16 码元）切片，避免把 emoji 的代理对从中间切断。 */
export function splitImReplyText(text: string, limit = IM_REPLY_CHUNK_SIZE): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += limit) {
    chunks.push(characters.slice(offset, offset + limit).join(""));
  }
  return chunks;
}

/** `@all` / `@everyone` 等保留词，以及任何以 `@` 开头的伪 ID。 */
function isForbiddenMention(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("@") || ["all", "everyone", "here"].includes(normalized);
}

function failure(code: ImReplyErrorCode, message: string): ImReplyFailure {
  return { ok: false, error: { code, message } };
}

export function createImOutboundService(deps: ImOutboundServiceDeps): ImOutboundService {
  const now = deps.now ?? (() => new Date());
  const tokenSecret = deps.tokenSecret ?? (() => getChannelConfig().imTokenSecret);
  /** 进程内 best-effort 去重；跨进程不一致是规格允许的（§4.4.4）。 */
  const recentReplies = new Map<string, { at: number; result: ImReplySuccess }>();

  function remember(key: string, at: number): void {
    if (recentReplies.size >= DUPLICATE_CACHE_SIZE) {
      const oldest = recentReplies.keys().next().value;
      if (oldest !== undefined) recentReplies.delete(oldest);
    }
    recentReplies.set(key, { at, result: { ok: true } });
  }

  async function sendText(input: {
    channel: ImChannelRow;
    chatType: ImChatType;
    chatId: string;
    text: string;
    mentionUserId: string | null;
  }): Promise<ImReplyResult> {
    const botUuid = readBotUuid(input.channel.credentials);
    if (!botUuid) return failure("SEND_FAILED", "通道缺少 Bot 标识");
    const chunks = splitImReplyText(input.text);
    if (chunks.length === 0) return failure("SEND_FAILED", "回复内容为空");
    if (chunks.length > IM_REPLY_MAX_CHUNKS) return failure("SEND_FAILED", "回复内容过长");

    for (const [index, chunk] of chunks.entries()) {
      let sent = false;
      let lastError: unknown;
      for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt += 1) {
        try {
          await deps.client.sendMessage(botUuid, {
            targetType: input.chatType,
            targetId: input.chatId,
            text: chunk,
            mentionUserId: index === 0 ? input.mentionUserId : null,
          });
          sent = true;
          break;
        } catch (error) {
          lastError = error;
          // 重试不等待：工具调用有超时预算，一次立即重试足够覆盖上游瞬时 5xx。
          if (attempt + 1 >= SEND_ATTEMPTS || !isRetryableSendError(error)) break;
        }
      }
      if (!sent) {
        logError("IM 回复发送失败", lastError instanceof Error ? lastError : undefined);
        return lastError instanceof ChannelControlError && lastError.code === "LANGBOT_UNREACHABLE"
          ? failure("LANGBOT_UNREACHABLE", "LangBot 不可达")
          : failure("SEND_FAILED", "消息发送失败");
      }
    }
    return { ok: true };
  }

  async function replyForConversation(input: {
    conversation: ImChannelConversationRow;
    text: string;
    mentionUserId?: string | null;
  }): Promise<ImReplyResult> {
    try {
      const conversation = input.conversation;
      const channel = await deps.channels.findById({ channelId: conversation.channelId });
      if (channel?.platform !== "langbot" || !channel.enabled) {
        return failure("SEND_FAILED", "通道不可用");
      }

      // 路由改绑后旧会话不能继续以旧 Agent 身份回复；由下一条入站消息重建会话后再发。
      const route = await findActiveRoute(deps.routes, conversation);
      if (!route || route.agentConfigId !== conversation.agentConfigId) {
        return failure("SEND_FAILED", "会话对应的 Agent 配置已变更");
      }

      if (input.text.trim() === "") return failure("SEND_FAILED", "回复内容为空");

      let mentionUserId: string | null = null;
      if (conversation.chatType === "group") {
        const at = now();
        const recent = await deps.events.findRecentByChat({
          channelId: conversation.channelId,
          chatType: conversation.chatType,
          chatId: conversation.chatId,
          since: new Date(at.getTime() - MENTION_LOOKBACK_MS),
          limit: MENTION_LOOKBACK_LIMIT,
        });
        const candidate = (input.mentionUserId?.trim() || recent[0]?.senderId || "").trim();
        if (!candidate) return failure("MENTION_NOT_ALLOWED", "群回复必须 @ 触发者");
        if (isForbiddenMention(candidate)) return failure("MENTION_NOT_ALLOWED", "不允许 @ 全体成员");
        if (!recent.some((event) => event.senderId === candidate)) {
          return failure("MENTION_NOT_ALLOWED", "只能 @ 该会话近期出现过的成员");
        }
        mentionUserId = candidate;
      }

      const key = `${conversation.id}\n${mentionUserId ?? ""}\n${input.text}`;
      const cached = recentReplies.get(key);
      const at = now().getTime();
      if (cached && at - cached.at < DUPLICATE_WINDOW_MS) return cached.result;

      const result = await sendText({
        channel,
        chatType: conversation.chatType,
        chatId: conversation.chatId,
        text: input.text,
        mentionUserId,
      });
      if (!result.ok) return result;

      await deps.conversations.touchLastReplyAt({ conversationId: conversation.id, at: now() });
      remember(key, at);
      return result;
    } catch (error) {
      // 令牌校验、DB 读取等未预期失败统一收敛为结构化错误；原文只进日志。
      logError("IM 回复处理失败", error instanceof Error ? error : undefined);
      return failure("SEND_FAILED", "消息发送失败");
    }
  }

  return {
    async reply(input) {
      try {
        const conversationId = await verifyImToken(input.token, tokenSecret());
        if (!conversationId) return failure("TOKEN_INVALID", "连接 token 无效");

        const conversation = await deps.conversations.findById({ conversationId });
        if (!conversation) return failure("TOKEN_INVALID", "连接 token 无效");

        return await replyForConversation({
          conversation,
          text: input.text,
          ...(input.mentionUserId !== undefined ? { mentionUserId: input.mentionUserId } : {}),
        });
      } catch (error) {
        // 令牌校验、DB 读取等未预期失败统一收敛为结构化错误；原文只进日志。
        logError("IM 回复处理失败", error instanceof Error ? error : undefined);
        return failure("SEND_FAILED", "消息发送失败");
      }
    },

    async replyToConversation(input) {
      try {
        const conversation = await deps.conversations.findById({ conversationId: input.conversationId });
        if (!conversation) return failure("TOKEN_INVALID", "连接 token 无效");

        return await replyForConversation({
          conversation,
          text: input.text,
          ...(input.mentionUserId !== undefined ? { mentionUserId: input.mentionUserId } : {}),
        });
      } catch (error) {
        // 连接已通过鉴权，剩下的失败只可能来自持久化或发送；原文只进日志。
        logError("IM 回复处理失败", error instanceof Error ? error : undefined);
        return failure("SEND_FAILED", "消息发送失败");
      }
    },

    async notifyUnsupported(input) {
      try {
        const result = await sendText({
          channel: input.channel,
          chatType: input.chatType,
          chatId: input.chatId,
          text: input.text,
          // 固定提示不是 Agent 回复；群聊 @ 当前发送者只是为了让对方收到提醒，仍需通道侧先校验来源。
          mentionUserId: input.chatType === "group" ? input.senderId : null,
        });
        if (!result.ok) logError(`IM 非文本提示发送失败: ${result.error.code}`);
      } catch (error) {
        logError("IM 非文本提示发送失败", error instanceof Error ? error : undefined);
      }
    },
  };
}
