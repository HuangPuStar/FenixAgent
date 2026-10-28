import type { ImChannelRow } from "../repositories/im-channel";
import type { ImChannelConversationRow } from "../repositories/im-channel-conversation";
import type { ImChannelRouteRow } from "../repositories/im-channel-route";
import type { BotListResult } from "../services/langbot/channel-service";
import type { LangBotBot, LangBotStatus } from "../services/langbot/types";
import { readBotUuid } from "../services/langbot/types";

/**
 * 控制面视图映射。
 *
 * 视图是独立的协议对象，不复用 Drizzle 行或服务层快照：`im_channel.credentials` 与 LangBot 的 `config`
 * 都不得出现在响应里，若直接把行展开给协议层，任何一次「多带一个字段」的改动都会变成密钥泄漏。
 *
 * `lastEventAt` / `lastReplyAt` 保留 ISO 字符串；`sessionId` 一律脱敏后再展示（规格 §4.2 的会话列表只
 * 需要识别同一会话，不需要完整键）。
 */

export interface LangBotStatusView {
  readonly reachable: boolean;
  readonly version: string | null;
  readonly edition: string | null;
  readonly wizardStatus: string | null;
}

export interface BotView {
  readonly botUuid: string | null;
  readonly name: string;
  readonly adapter: string | null;
  readonly channelId: string | null;
  readonly channelName: string | null;
  readonly status: string | null;
  readonly boundRouteCount: number;
  /** 平台有记录但 LangBot 已没有这个 Bot（漂移），或反过来没有平台记录。 */
  readonly missingInLangbot: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface RouteView {
  readonly id: string;
  readonly channelId: string;
  readonly chatType: string;
  readonly chatId: string | null;
  readonly agentConfigId: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationView {
  readonly id: string;
  readonly channelId: string;
  readonly chatType: string;
  readonly chatId: string;
  readonly agentConfigId: string;
  /** 脱敏后的会话键；不返回 `rcs_session_id` 原文与 ACP session。 */
  readonly sessionId: string;
  readonly lastEventAt: string | null;
  readonly lastReplyAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationPageView {
  readonly items: readonly ConversationView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/** 会话键脱敏：只暴露首尾各 4 个字符；短值整体遮蔽。 */
export function maskSessionId(sessionId: string): string {
  if (sessionId.length <= 8) return "***";
  return `${sessionId.slice(0, 4)}…${sessionId.slice(-4)}`;
}

export function toStatusView(status: LangBotStatus): LangBotStatusView {
  return {
    reachable: status.reachable,
    version: status.version,
    edition: status.edition,
    wizardStatus: status.wizardStatus,
  };
}

export function toBotView(input: {
  readonly bot: LangBotBot | null;
  readonly channel: ImChannelRow | null;
  readonly boundRouteCount: number;
}): BotView {
  const { bot, channel } = input;
  return {
    botUuid: bot?.uuid ?? readBotUuid(channel?.credentials),
    name: bot?.name ?? channel?.name ?? "",
    adapter: bot?.adapter ?? null,
    channelId: channel?.id ?? null,
    channelName: channel?.name ?? null,
    status: channel?.status ?? null,
    boundRouteCount: input.boundRouteCount,
    missingInLangbot: bot === null && channel !== null,
    createdAt: bot?.createdAt ?? channel?.createdAt.toISOString() ?? null,
    updatedAt: bot?.updatedAt ?? channel?.updatedAt.toISOString() ?? null,
  };
}

/** 列表并集：先按 LangBot 顺序输出两侧都存在的 Bot，再追加只有平台记录的漂移行。 */
export function toBotListView(result: BotListResult): BotView[] {
  const remaining = new Map<string | null, (typeof result.channels)[number]>();
  for (const snapshot of result.channels) remaining.set(snapshot.botUuid, snapshot);

  const views: BotView[] = [];
  for (const bot of result.bots) {
    const snapshot = remaining.get(bot.uuid);
    remaining.delete(bot.uuid);
    views.push(
      toBotView({
        bot,
        channel: snapshot?.channel ?? null,
        boundRouteCount: snapshot?.boundRouteCount ?? 0,
      }),
    );
  }
  for (const snapshot of remaining.values()) {
    views.push(
      toBotView({
        bot: null,
        channel: snapshot.channel,
        boundRouteCount: snapshot.boundRouteCount,
      }),
    );
  }
  return views;
}

export function toRouteView(row: ImChannelRouteRow): RouteView {
  return {
    id: row.id,
    channelId: row.channelId,
    chatType: row.chatType,
    chatId: row.chatId,
    agentConfigId: row.agentConfigId,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toConversationView(row: ImChannelConversationRow): ConversationView {
  return {
    id: row.id,
    channelId: row.channelId,
    chatType: row.chatType,
    chatId: row.chatId,
    agentConfigId: row.agentConfigId,
    sessionId: maskSessionId(row.rcsSessionId),
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    lastReplyAt: row.lastReplyAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
