import type { ActorContext } from "@fenix/platform-sdk";
import type { ImChatType } from "@fenix/resource-channel/db";
import { type ChannelActionResult, ChannelControlError } from "../contracts";
import {
  type ChannelAgentConfigLookup,
  ChannelAgentConfigUnavailableError,
  getChannelAgentConfigLookup,
} from "../ports/agent-config-lookup";
import type { ImChannelRow } from "../repositories/im-channel";
import type { ChannelService } from "../services/langbot/channel-service";
import type { ChannelRouteService } from "../services/langbot/route-service";
import type { LangBotSendMessageInput } from "../services/langbot/types";
import {
  type BotView,
  type ConversationPageView,
  type LangBotStatusView,
  type RouteView,
  toBotListView,
  toBotView,
  toConversationView,
  toRouteView,
  toStatusView,
} from "../views/channel-view";

/**
 * LangBot 通道控制面的唯一应用入口。
 *
 * 职责边界：
 * 1. **租户边界**：组织取自 `actor.activeOrganizationId`，绝不读请求参数；跨组织资源一律 404，避免存在性探测。
 * 2. **管理权限**：变更类操作（通道更新/删除、路由增删改、测试发送）限通道创建者与组织管理员；读取类
 *    组织内可见，创建通道任意成员可做（创建者成为 owner）。
 * 3. **执行身份**：路由绑定 Agent 时校验的是**通道所有者**（`im_channel.userId`）的 `use` 权限，不是操作者
 *    自己的权限——IM 消息以所有者身份执行，管理员不能把路由绑到自己能看到、所有者看不到的 Agent。
 * 4. **协议映射**：把领域错误归一成 {@link ChannelControlError}，路由只按 `status` / `code` 出信封。
 *
 * 不负责：Bot 启停与流水线绑定（LangBot 没有公开 API）、会话重置（会话长期复用）、事件列表（规格 §4.2
 * 没有该端点）。
 */

export interface BotCreateInput {
  readonly name: string;
  readonly adapter: string;
  readonly config: Record<string, unknown>;
}

export interface BotUpdateInput {
  readonly name?: string;
  readonly adapter?: string;
  readonly config?: Record<string, unknown>;
}

export interface RouteCreateInput {
  readonly channelId: string;
  readonly chatType: ImChatType;
  readonly chatId?: string | null;
  readonly agentConfigId: string;
  readonly enabled?: boolean;
}

export interface RouteUpdateInput {
  readonly chatType?: ImChatType;
  readonly chatId?: string | null;
  readonly agentConfigId?: string;
  readonly enabled?: boolean;
}

export interface LangBotChannelFacadeApi {
  status(actor: ActorContext | null): Promise<ChannelActionResult<LangBotStatusView>>;
  listBots(actor: ActorContext | null): Promise<BotView[]>;
  getBot(actor: ActorContext | null, botUuid: string): Promise<BotView>;
  createBot(actor: ActorContext | null, input: BotCreateInput): Promise<ChannelActionResult<BotView>>;
  updateBot(actor: ActorContext | null, botUuid: string, input: BotUpdateInput): Promise<BotView>;
  deleteBot(actor: ActorContext | null, botUuid: string): Promise<void>;
  testSend(actor: ActorContext | null, botUuid: string, input: LangBotSendMessageInput): Promise<void>;
  listRoutes(actor: ActorContext | null, query: { channelId?: string }): Promise<RouteView[]>;
  createRoute(actor: ActorContext | null, input: RouteCreateInput): Promise<ChannelActionResult<RouteView>>;
  updateRoute(actor: ActorContext | null, routeId: string, input: RouteUpdateInput): Promise<RouteView>;
  deleteRoute(actor: ActorContext | null, routeId: string): Promise<void>;
  listConversations(
    actor: ActorContext | null,
    query: { channelId?: string; page: number; pageSize: number },
  ): Promise<ConversationPageView>;
}

export interface LangBotChannelFacadeDeps {
  readonly service: ChannelService;
  readonly routes: ChannelRouteService;
  /** 测试注入；生产按调用时读取宿主绑定。 */
  readonly agentConfigLookup?: () => ChannelAgentConfigLookup;
}

interface ActorScope {
  readonly organizationId: string;
  readonly userId: string;
  /** 当前组织的 `owner` / `admin` 视为管理员（规格 §7.2.7 / §9.10）。 */
  readonly isOrganizationAdmin: boolean;
}

export function createLangBotChannelFacade(deps: LangBotChannelFacadeDeps): LangBotChannelFacadeApi {
  const { service, routes } = deps;
  const lookup = deps.agentConfigLookup ?? getChannelAgentConfigLookup;

  function requireScope(actor: ActorContext | null): ActorScope {
    if (!actor?.activeOrganizationId) {
      throw new ChannelControlError("UNAUTHORIZED", 401, "请求缺少组织上下文");
    }
    const organizationId = actor.activeOrganizationId;
    // 角色取成员表当前值，不用凭据快照：成员被降级后旧会话必须立刻失去管理权。
    const role = actor.memberships.find((membership) => membership.organizationId === organizationId)?.role;
    return {
      organizationId,
      userId: actor.userId,
      isOrganizationAdmin: role === "owner" || role === "admin",
    };
  }

  /**
   * 变更类操作的归属判定：通道创建者或组织管理员。
   *
   * 读取类不做该判定（组织内可见），创建通道也不做（任意成员都能创建，创建者即 owner）。
   */
  function requireChannelManager(scope: ActorScope, channel: ImChannelRow): void {
    if (channel.userId === scope.userId || scope.isOrganizationAdmin) return;
    throw new ChannelControlError("FORBIDDEN", 403, "只有通道创建者或组织管理员可以修改通道");
  }

  /** 校验目标 Agent 对通道所有者可用；端口故障（DB 等）原样上抛，不伪装成权限问题。 */
  async function requireUsableAgent(input: {
    organizationId: string;
    ownerUserId: string;
    agentConfigId: string;
  }): Promise<void> {
    try {
      await lookup().requireUsable(input);
    } catch (error) {
      if (error instanceof ChannelAgentConfigUnavailableError) {
        throw new ChannelControlError("AGENT_CONFIG_UNAVAILABLE", 400, "目标 Agent 配置对通道所有者不可用", {
          cause: error,
        });
      }
      throw error;
    }
  }

  return {
    async status(actor) {
      requireScope(actor);
      return { status: 200, data: toStatusView(await service.status()) };
    },

    async listBots(actor) {
      const scope = requireScope(actor);
      return toBotListView(await service.listBots({ organizationId: scope.organizationId }));
    },

    async getBot(actor, botUuid) {
      const scope = requireScope(actor);
      const detail = await service.getBot({ organizationId: scope.organizationId, botUuid });
      return toBotView(detail);
    },

    async createBot(actor, input) {
      const scope = requireScope(actor);
      const detail = await service.createBot({
        organizationId: scope.organizationId,
        ownerUserId: scope.userId,
        name: input.name,
        adapter: input.adapter,
        config: input.config,
      });
      return { status: 201, data: toBotView(detail) };
    },

    async updateBot(actor, botUuid, input) {
      const scope = requireScope(actor);
      const channel = await service.getChannelByBotUuid({ organizationId: scope.organizationId, botUuid });
      requireChannelManager(scope, channel);
      const detail = await service.updateBot({
        organizationId: scope.organizationId,
        botUuid,
        name: input.name,
        adapter: input.adapter,
        config: input.config,
      });
      return toBotView(detail);
    },

    async deleteBot(actor, botUuid) {
      const scope = requireScope(actor);
      const channel = await service.getChannelByBotUuid({ organizationId: scope.organizationId, botUuid });
      requireChannelManager(scope, channel);
      await service.deleteBot({ organizationId: scope.organizationId, botUuid });
    },

    async testSend(actor, botUuid, input) {
      const scope = requireScope(actor);
      const channel = await service.getChannelByBotUuid({ organizationId: scope.organizationId, botUuid });
      requireChannelManager(scope, channel);
      await service.testSend({
        organizationId: scope.organizationId,
        botUuid,
        targetType: input.targetType,
        targetId: input.targetId,
        text: input.text,
      });
    },

    async listRoutes(actor, query) {
      const scope = requireScope(actor);
      const rows = await routes.list({
        organizationId: scope.organizationId,
        channelId: query.channelId,
      });
      return rows.map(toRouteView);
    },

    async createRoute(actor, input) {
      const scope = requireScope(actor);
      const channel = await service.getChannel({
        organizationId: scope.organizationId,
        channelId: input.channelId,
      });
      requireChannelManager(scope, channel);
      await requireUsableAgent({
        organizationId: scope.organizationId,
        ownerUserId: channel.userId,
        agentConfigId: input.agentConfigId,
      });
      const row = await routes.create({ organizationId: scope.organizationId, ...input });
      return { status: 201, data: toRouteView(row) };
    },

    async updateRoute(actor, routeId, input) {
      const scope = requireScope(actor);
      const current = await routes.require({ organizationId: scope.organizationId, routeId });
      const channel = await service.getChannel({
        organizationId: scope.organizationId,
        channelId: current.channelId,
      });
      requireChannelManager(scope, channel);
      if (input.agentConfigId !== undefined) {
        await requireUsableAgent({
          organizationId: scope.organizationId,
          ownerUserId: channel.userId,
          agentConfigId: input.agentConfigId,
        });
      }
      const row = await routes.update({ organizationId: scope.organizationId, routeId, patch: input });
      return toRouteView(row);
    },

    async deleteRoute(actor, routeId) {
      const scope = requireScope(actor);
      const current = await routes.require({ organizationId: scope.organizationId, routeId });
      const channel = await service.getChannel({
        organizationId: scope.organizationId,
        channelId: current.channelId,
      });
      requireChannelManager(scope, channel);
      await routes.delete({ organizationId: scope.organizationId, routeId });
    },

    async listConversations(actor, query) {
      const scope = requireScope(actor);
      const result = await service.listConversations({
        organizationId: scope.organizationId,
        channelId: query.channelId,
        page: query.page,
        pageSize: query.pageSize,
      });
      return {
        items: result.items.map(toConversationView),
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
      };
    },
  };
}
