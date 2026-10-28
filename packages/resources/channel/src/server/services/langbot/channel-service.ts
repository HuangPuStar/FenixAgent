import { error as logError } from "@fenix/logger";
import { ChannelControlError } from "../../contracts";
import type { ImChannelRepository, ImChannelRow, ImChannelUpdatePatch } from "../../repositories/im-channel";
import type {
  ImChannelConversationRepository,
  ImChannelConversationRow,
} from "../../repositories/im-channel-conversation";
import type { ImChannelRouteRepository } from "../../repositories/im-channel-route";
import type { LangBotClient } from "./client";
import type { LangBotBot, LangBotSendMessageInput, LangBotStatus } from "./types";
import { readBotUuid } from "./types";

/**
 * Bot 与平台通道的编排。
 *
 * 跨系统写顺序固定为「先 LangBot、后平台库」，并为每一步定义失败语义：
 * - 远端创建成功、本地写入失败 → 补偿删除远端；补偿失败时保留原 cause 与**可定位的 Bot UUID**（UUID 不是
 *   秘密，`config` 才是），让运维能在 LangBot WebUI 里手工清理。
 * - 远端更新成功、本地写入失败 → 返回 `CHANNEL_PERSIST_FAILED`；远端已是新值，重试 PATCH 是安全的。
 * - 远端删除失败 → **保留**平台通道并标记 `enabled = false` 与 `lastError`。删除顺序按规格 §4.2：先删平台
 *   侧关联（路由、会话），再删 LangBot Bot；关联已删而远端删除失败时，通道行仍可用于人工重试。
 *
 * `config` 只在请求 → LangBot 的单向上行路径里出现：不落库、不读回、不写日志。
 */

const PLATFORM = "langbot";
/** `lastError` 是可展示摘要，不是完整堆栈；截断避免一次上游异常把列撑爆。 */
const MAX_LAST_ERROR_LENGTH = 500;

export interface BotChannelSnapshot {
  readonly channel: ImChannelRow;
  readonly botUuid: string | null;
  readonly boundRouteCount: number;
}

export interface BotListResult {
  readonly bots: readonly LangBotBot[];
  readonly channels: readonly BotChannelSnapshot[];
}

export interface BotDetail {
  readonly bot: LangBotBot | null;
  readonly channel: ImChannelRow;
  readonly boundRouteCount: number;
}

export interface ConversationListResult {
  readonly items: readonly ImChannelConversationRow[];
  readonly total: number;
}

export interface ChannelService {
  status(): Promise<LangBotStatus>;
  /** 按组织取通道；门面在写路由前用它确定执行身份（通道所有者）。 */
  getChannel(input: { organizationId: string; channelId: string }): Promise<ImChannelRow>;
  /**
   * 按 Bot UUID 取本组织的通道。
   *
   * 写操作的归属判定用它，而不是 `getBot`：后者要读 LangBot，上游故障会把「无权修改」变成 5xx。
   */
  getChannelByBotUuid(input: { organizationId: string; botUuid: string }): Promise<ImChannelRow>;
  listBots(input: { organizationId: string }): Promise<BotListResult>;
  getBot(input: { organizationId: string; botUuid: string }): Promise<BotDetail>;
  createBot(input: {
    organizationId: string;
    ownerUserId: string;
    name: string;
    adapter: string;
    config: Record<string, unknown>;
  }): Promise<BotDetail>;
  updateBot(input: {
    organizationId: string;
    botUuid: string;
    name?: string;
    adapter?: string;
    config?: Record<string, unknown>;
  }): Promise<BotDetail>;
  deleteBot(input: { organizationId: string; botUuid: string }): Promise<void>;
  testSend(input: { organizationId: string; botUuid: string } & LangBotSendMessageInput): Promise<void>;
  listConversations(input: {
    organizationId: string;
    channelId?: string;
    page: number;
    pageSize: number;
  }): Promise<ConversationListResult>;
}

export interface ChannelServiceDeps {
  readonly client: LangBotClient;
  readonly channels: ImChannelRepository;
  readonly routes: ImChannelRouteRepository;
  readonly conversations: ImChannelConversationRepository;
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知错误";
  return message.slice(0, MAX_LAST_ERROR_LENGTH);
}

export function createChannelService(deps: ChannelServiceDeps): ChannelService {
  const { client, channels, routes, conversations } = deps;

  /** 按 Bot UUID 定位本组织的通道；跨组织命中按不存在处理。 */
  async function requireChannelByBotUuid(input: { organizationId: string; botUuid: string }): Promise<ImChannelRow> {
    const rows = await channels.findManyByOrganization({ organizationId: input.organizationId });
    const channel = rows.find((row) => row.platform === PLATFORM && readBotUuid(row.credentials) === input.botUuid);
    if (!channel) throw new ChannelControlError("NOT_FOUND", 404, "通道不存在");
    return channel;
  }

  async function requireChannel(input: { organizationId: string; channelId: string }): Promise<ImChannelRow> {
    const channel = await channels.findByIdForOrganization(input);
    if (!channel) throw new ChannelControlError("NOT_FOUND", 404, "通道不存在");
    return channel;
  }

  /** 状态写入失败不能覆盖原始失败原因：记录日志后由调用方抛出原错误。 */
  async function patchChannelBestEffort(channelId: string, patch: ImChannelUpdatePatch): Promise<void> {
    try {
      await channels.updateById({ channelId, patch });
    } catch (error) {
      logError("IM 通道状态写入失败", error instanceof Error ? error : undefined);
    }
  }

  async function markChannelFailure(channelId: string, error: unknown): Promise<void> {
    const code = error instanceof ChannelControlError ? error.code : undefined;
    await patchChannelBestEffort(channelId, {
      status: "error",
      lastError: summarizeError(error),
      // 删除失败必须停用：否则数据面会继续向一个已被判定不健康的 Bot 投递。
      ...(code === "CHANNEL_PERSIST_FAILED" ? {} : { enabled: false }),
    });
  }

  async function readBotSafely(botUuid: string): Promise<LangBotBot | null> {
    try {
      return await client.getBot(botUuid);
    } catch (error) {
      // 详情读取失败只意味着无法展示上游字段；通道本身仍由平台行表达。
      if (error instanceof ChannelControlError && error.code === "LANGBOT_BOT_NOT_FOUND") return null;
      throw error;
    }
  }

  async function boundRouteCounts(channelIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return routes.countByChannels({ channelIds });
  }

  return {
    status() {
      return client.status();
    },

    getChannel: requireChannel,

    getChannelByBotUuid: requireChannelByBotUuid,

    async listBots(input) {
      const [rows, bots] = await Promise.all([
        channels.findManyByOrganization({ organizationId: input.organizationId }),
        client.listBots(),
      ]);
      const platformChannels = rows.filter((row) => row.platform === PLATFORM);
      const counts = await boundRouteCounts(platformChannels.map((row) => row.id));
      return {
        bots,
        channels: platformChannels.map((channel) => ({
          channel,
          botUuid: readBotUuid(channel.credentials),
          boundRouteCount: counts.get(channel.id) ?? 0,
        })),
      };
    },

    async getBot(input) {
      const channel = await requireChannelByBotUuid(input);
      const botUuid = readBotUuid(channel.credentials);
      if (!botUuid) throw new ChannelControlError("NOT_FOUND", 404, "通道没有关联的 LangBot Bot");
      const bot = await readBotSafely(botUuid);
      const counts = await boundRouteCounts([channel.id]);
      return { bot, channel, boundRouteCount: counts.get(channel.id) ?? 0 };
    },

    async createBot(input) {
      const botUuid = await client.createBot({
        name: input.name,
        adapter: input.adapter,
        config: input.config,
      });

      let channel: ImChannelRow;
      try {
        channel = await channels.insert({
          userId: input.ownerUserId,
          organizationId: input.organizationId,
          name: input.name,
          platform: PLATFORM,
          credentials: { botUuid },
          status: "connected",
        });
      } catch (error) {
        try {
          await client.deleteBot(botUuid);
        } catch (compensationError) {
          logError(
            `LangBot Bot ${botUuid} 创建后平台写入失败，补偿删除也失败；需在 LangBot 侧手工清理`,
            compensationError instanceof Error ? compensationError : undefined,
          );
          throw new ChannelControlError(
            "CHANNEL_PERSIST_FAILED",
            500,
            `通道写入失败，LangBot Bot ${botUuid} 未能回滚`,
            { cause: error },
          );
        }
        throw new ChannelControlError("CHANNEL_PERSIST_FAILED", 500, "通道写入失败，已回滚 LangBot Bot", {
          cause: error,
        });
      }

      const bot = await readBotSafely(botUuid);
      return {
        bot: bot ?? {
          uuid: botUuid,
          name: input.name,
          adapter: input.adapter,
          createdAt: null,
          updatedAt: null,
        },
        channel,
        boundRouteCount: 0,
      };
    },

    async updateBot(input) {
      const channel = await requireChannelByBotUuid(input);
      const botUuid = readBotUuid(channel.credentials);
      if (!botUuid) throw new ChannelControlError("NOT_FOUND", 404, "通道没有关联的 LangBot Bot");

      await client.updateBot(botUuid, {
        name: input.name,
        adapter: input.adapter,
        config: input.config,
      });

      try {
        const updated = await channels.updateById({
          channelId: channel.id,
          patch: {
            ...(input.name === undefined ? {} : { name: input.name }),
            status: "connected",
            lastError: null,
          },
        });
        if (!updated) throw new ChannelControlError("NOT_FOUND", 404, "通道不存在");
      } catch (error) {
        throw new ChannelControlError("CHANNEL_PERSIST_FAILED", 500, "LangBot 已更新，但平台记录写入失败", {
          cause: error,
        });
      }

      const bot = await readBotSafely(botUuid);
      const counts = await boundRouteCounts([channel.id]);
      return {
        bot,
        channel: { ...channel, name: input.name ?? channel.name },
        boundRouteCount: counts.get(channel.id) ?? 0,
      };
    },

    async deleteBot(input) {
      const channel = await requireChannelByBotUuid(input);
      const botUuid = readBotUuid(channel.credentials);
      if (!botUuid) throw new ChannelControlError("NOT_FOUND", 404, "通道没有关联的 LangBot Bot");

      // 规格 §4.2：先删平台侧关联（路由、会话），再删 LangBot Bot。关联删除失败时通道与远端 Bot 都保留，
      // 由 last_error 暴露故障；否则会出现「Bot 已删、路由仍指向已失效通道」的悬挂引用。
      try {
        await routes.deleteByChannel({ channelId: channel.id });
        await conversations.deleteByChannel({ channelId: channel.id });
      } catch (error) {
        await markChannelFailure(channel.id, error);
        throw new ChannelControlError("CHANNEL_PERSIST_FAILED", 500, "通道关联删除失败，LangBot Bot 未删除", {
          cause: error,
        });
      }

      try {
        await client.deleteBot(botUuid);
      } catch (error) {
        await markChannelFailure(channel.id, error);
        throw error;
      }

      try {
        const deleted = await channels.deleteById({ channelId: channel.id });
        if (!deleted) throw new ChannelControlError("NOT_FOUND", 404, "通道不存在");
      } catch (error) {
        await markChannelFailure(channel.id, error);
        throw new ChannelControlError("CHANNEL_PERSIST_FAILED", 500, "LangBot Bot 已删除，但平台记录删除失败", {
          cause: error,
        });
      }
    },

    async testSend(input) {
      const channel = await requireChannelByBotUuid(input);
      const botUuid = readBotUuid(channel.credentials);
      if (!botUuid) throw new ChannelControlError("NOT_FOUND", 404, "通道没有关联的 LangBot Bot");

      try {
        await client.sendMessage(botUuid, {
          targetType: input.targetType,
          targetId: input.targetId,
          text: input.text,
        });
        await patchChannelBestEffort(channel.id, { status: "connected", lastError: null });
      } catch (error) {
        const unreachable =
          error instanceof ChannelControlError &&
          (error.code === "LANGBOT_UNREACHABLE" || error.code === "LANGBOT_UNAUTHORIZED");
        await patchChannelBestEffort(channel.id, {
          // 目标不存在等业务失败不代表通道故障，只有「连不上 / 密钥被拒」才把通道标成 error。
          ...(unreachable ? { status: "error" } : {}),
          lastError: summarizeError(error),
        });
        throw error;
      }
    },

    async listConversations(input) {
      const scopedChannels = input.channelId
        ? [await requireChannel({ organizationId: input.organizationId, channelId: input.channelId })]
        : await channels.findManyByOrganization({ organizationId: input.organizationId });
      const channelIds = scopedChannels.map((channel) => channel.id);
      const [items, total] = await Promise.all([
        conversations.findManyByChannels({
          channelIds,
          limit: input.pageSize,
          offset: (input.page - 1) * input.pageSize,
        }),
        conversations.countByChannels({ channelIds }),
      ]);
      return { items, total };
    },
  };
}
