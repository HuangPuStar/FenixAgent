import { error as logError } from "@fenix/logger";
import type { IdentityDirectory } from "@fenix/platform-sdk";
import type { ImChatType } from "@fenix/resource-channel/db";
import type { ImChannelRow } from "../../repositories/im-channel";
import type { ImChannelConversationRow } from "../../repositories/im-channel-conversation";
import { type LangBotStatusView, maskSessionId, toStatusView } from "../../views/channel-view";
import type { ChannelService } from "./channel-service";
import type { LangBotClient } from "./client";
import { buildImInstanceName } from "./im-instance-name";
import { readBotUuid } from "./types";

/**
 * 系统管理面的通道拓扑：组织 → 用户 → 通道 → 实例。
 *
 * 这一份视图只服务系统 API Key 保护的 `/api/system/channels`，因此刻意跨组织、跨用户；用户面继续用
 * `listBots` / `listConversations` 那些带组织过滤的入口。
 *
 * 为什么把分组抽成纯函数：排序与「只有拥有通道的用户才出现」这两条规则决定排障者能否一眼定位，靠读代码
 * 验不出来；纯函数让它们可以在没有 DB、没有 LangBot 的用例里逐条钉住。
 *
 * 实例只表达「这个聊天映射到了哪个会话」，不查询运行状态：实例是否活着是 agent-runtime 的真相，通道表
 * 只能给出映射本身的创建与活跃时间。
 */

/** 一个 IM 聊天对应的长期实例。 */
export interface ChannelTopologyInstance {
  readonly conversationId: string;
  readonly instanceName: string;
  readonly chatType: ImChatType;
  readonly chatId: string;
  readonly agentConfigId: string;
  /** 已脱敏的 Chat 会话键；不返回 `rcs_session_id` 原文与 ACP session。 */
  readonly sessionId: string;
  readonly lastEventAt: string | null;
  readonly lastReplyAt: string | null;
}

/** 平台侧的一条 IM 通道（LangBot Bot）。 */
export interface ChannelTopologyChannel {
  readonly id: string;
  readonly name: string;
  /** LangBot Bot 的适配器标识；Bot 读不到时为 null（`im_channel` 不存适配器）。 */
  readonly adapter: string | null;
  readonly status: string;
  readonly botUuid: string | null;
  readonly createdAt: string;
  readonly instances: readonly ChannelTopologyInstance[];
}

/** 通道所有者；没有通道的用户不出现在树里。 */
export interface ChannelTopologyUser {
  readonly id: string;
  readonly name: string;
  /** 身份目录查不到该用户时为 null，与「有用户但没有邮箱」区分开。 */
  readonly email: string | null;
  readonly channels: readonly ChannelTopologyChannel[];
}

export interface ChannelTopologyOrganization {
  readonly id: string;
  readonly name: string;
  readonly users: readonly ChannelTopologyUser[];
}

export interface ChannelTopologyInput {
  readonly channels: readonly ImChannelRow[];
  readonly conversations: readonly ImChannelConversationRow[];
  readonly organizationNames: ReadonlyMap<string, string>;
  readonly users: ReadonlyMap<string, { readonly name: string; readonly email: string }>;
  /** Bot UUID → 适配器标识；缺失的 Bot 在通道节点上落到 null。 */
  readonly adapterByBotUuid: ReadonlyMap<string, string>;
}

function compareByName(
  left: { readonly id: string; readonly name: string },
  right: { readonly id: string; readonly name: string },
): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

/** 通道按创建时间升序：同一用户的通道顺序与它在控制面出现的顺序一致。 */
function compareChannels(left: ImChannelRow, right: ImChannelRow): number {
  const delta = left.createdAt.getTime() - right.createdAt.getTime();
  return delta !== 0 ? delta : left.id.localeCompare(right.id);
}

/** 最近事件倒序，未产生事件的实例排在最后；两个时间都由 `toISOString()` 产出，字典序即时间序。 */
function compareInstances(left: ChannelTopologyInstance, right: ChannelTopologyInstance): number {
  if (left.lastEventAt !== right.lastEventAt) {
    if (left.lastEventAt === null) return 1;
    if (right.lastEventAt === null) return -1;
    return right.lastEventAt.localeCompare(left.lastEventAt);
  }
  return left.conversationId.localeCompare(right.conversationId);
}

function toInstance(conversation: ImChannelConversationRow): ChannelTopologyInstance {
  return {
    conversationId: conversation.id,
    instanceName: buildImInstanceName(conversation.id),
    chatType: conversation.chatType,
    chatId: conversation.chatId,
    agentConfigId: conversation.agentConfigId,
    sessionId: maskSessionId(conversation.rcsSessionId),
    lastEventAt: conversation.lastEventAt?.toISOString() ?? null,
    lastReplyAt: conversation.lastReplyAt?.toISOString() ?? null,
  };
}

function toChannel(
  channel: ImChannelRow,
  conversationsByChannel: ReadonlyMap<string, readonly ImChannelConversationRow[]>,
  adapterByBotUuid: ReadonlyMap<string, string>,
): ChannelTopologyChannel {
  const botUuid = readBotUuid(channel.credentials);
  return {
    id: channel.id,
    name: channel.name,
    adapter: botUuid === null ? null : (adapterByBotUuid.get(botUuid) ?? null),
    status: channel.status,
    botUuid,
    createdAt: channel.createdAt.toISOString(),
    instances: (conversationsByChannel.get(channel.id) ?? []).map(toInstance).sort(compareInstances),
  };
}

/**
 * 组装组织 → 用户 → 通道 → 实例四层树。
 *
 * 只输出「拥有至少一个通道」的用户与组织：没有通道的组织在这个页面上没有任何可操作对象，占位会让排障者
 * 误以为通道丢了。
 */
export function buildChannelTopology(input: ChannelTopologyInput): ChannelTopologyOrganization[] {
  const conversationsByChannel = new Map<string, ImChannelConversationRow[]>();
  for (const conversation of input.conversations) {
    const bucket = conversationsByChannel.get(conversation.channelId);
    if (bucket) bucket.push(conversation);
    else conversationsByChannel.set(conversation.channelId, [conversation]);
  }

  // 用户按组织归并：同一用户在两个组织里的通道属于两棵不同的树，不能合并到同一个节点。
  const usersByOrganization = new Map<string, Map<string, ImChannelRow[]>>();
  for (const channel of input.channels) {
    let users = usersByOrganization.get(channel.organizationId);
    if (!users) {
      users = new Map();
      usersByOrganization.set(channel.organizationId, users);
    }
    const bucket = users.get(channel.userId);
    if (bucket) bucket.push(channel);
    else users.set(channel.userId, [channel]);
  }

  const organizations: ChannelTopologyOrganization[] = [];
  for (const [organizationId, users] of usersByOrganization) {
    const userNodes: ChannelTopologyUser[] = [];
    for (const [userId, channels] of users) {
      const user = input.users.get(userId);
      userNodes.push({
        id: userId,
        name: user?.name ?? userId,
        email: user?.email ?? null,
        channels: [...channels]
          .sort(compareChannels)
          .map((channel) => toChannel(channel, conversationsByChannel, input.adapterByBotUuid)),
      });
    }
    organizations.push({
      id: organizationId,
      name: input.organizationNames.get(organizationId) ?? organizationId,
      users: userNodes.sort(compareByName),
    });
  }

  return organizations.sort(compareByName);
}

export interface ChannelTopologyDeps {
  readonly service: Pick<ChannelService, "listAllChannels" | "listConversationsByChannels">;
  readonly identity: Pick<IdentityDirectory, "listOrganizationNames" | "listUserDisplayInfo">;
  readonly client: Pick<LangBotClient, "listBots">;
}

/**
 * Bot UUID → 适配器标识。
 *
 * `im_channel` 只有 `platform` 列，适配器配置整体留在 LangBot，因此这里必须读一次 Bot 列表。读不到时退化
 * 为空表而不是抛错：适配器只是展示字段，不该让排障页失去通道与会话这些主体数据。
 */
async function readAdapterByBotUuid(client: Pick<LangBotClient, "listBots">): Promise<ReadonlyMap<string, string>> {
  try {
    const bots = await client.listBots();
    return new Map(bots.map((bot) => [bot.uuid, bot.adapter]));
  } catch (error) {
    logError("IM 通道拓扑读取 LangBot Bot 列表失败，适配器降级为 null", error instanceof Error ? error : undefined);
    return new Map();
  }
}

/** 取数并组装系统管理面的通道拓扑；组织名与用户展示信息来自身份目录的只读投影。 */
export async function loadChannelTopology(deps: ChannelTopologyDeps): Promise<ChannelTopologyOrganization[]> {
  const channels = await deps.service.listAllChannels();
  if (channels.length === 0) return [];

  const [conversations, adapterByBotUuid, organizationNames, users] = await Promise.all([
    deps.service.listConversationsByChannels({ channelIds: channels.map((channel) => channel.id) }),
    readAdapterByBotUuid(deps.client),
    deps.identity.listOrganizationNames([...new Set(channels.map((channel) => channel.organizationId))]),
    deps.identity.listUserDisplayInfo([...new Set(channels.map((channel) => channel.userId))]),
  ]);

  return buildChannelTopology({ channels, conversations, organizationNames, users, adapterByBotUuid });
}

/**
 * 探测 LangBot 状态。
 *
 * 未配置 LangBot 的部署会在这里抛 503；状态卡的用途正是展示「连不上 / 没配」，所以就地降级成不可达并
 * 保留日志，而不是让整张管理页 500。
 */
export async function readChannelStatus(service: Pick<ChannelService, "status">): Promise<LangBotStatusView> {
  try {
    return toStatusView(await service.status());
  } catch (error) {
    logError("IM 通道状态探测失败，按不可达返回", error instanceof Error ? error : undefined);
    return { reachable: false, version: null, edition: null, wizardStatus: null };
  }
}
