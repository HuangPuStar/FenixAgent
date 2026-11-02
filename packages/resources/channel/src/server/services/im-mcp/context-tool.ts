import type { ImChatType } from "@fenix/resource-channel/db";
import type { ImChannelConversationRow } from "../../repositories/im-channel-conversation";

/**
 * `im_context` 的脱敏投影（规格 §4.4）。
 *
 * 只给 Agent 足够的会话自我认知：通道名、聊天类型、掩码后的聊天与会话标识、Agent 名与待处理数。
 * 不返回 chat_id 原文、LangBot 配置、token 或平台内部 ID；掩码不可逆推。
 */

export interface ImContextResult {
  readonly channelName: string;
  readonly chatType: ImChatType;
  readonly chatIdMasked: string;
  readonly agentName: string | null;
  readonly sessionIdMasked: string;
  readonly pendingCount: number;
}

export function maskImIdentifier(value: string): string {
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function buildImContext(input: {
  channelName: string;
  conversation: ImChannelConversationRow;
  agentName: string | null;
  pendingCount: number;
}): ImContextResult {
  return {
    channelName: input.channelName,
    chatType: input.conversation.chatType,
    chatIdMasked: maskImIdentifier(input.conversation.chatId),
    agentName: input.agentName,
    sessionIdMasked: maskImIdentifier(input.conversation.rcsSessionId),
    pendingCount: input.pendingCount,
  };
}
