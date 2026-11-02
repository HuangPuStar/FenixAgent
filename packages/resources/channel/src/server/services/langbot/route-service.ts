import type { ImChatType } from "@fenix/resource-channel/db";
import { ChannelControlError } from "../../contracts";
import type { ImChannelRepository } from "../../repositories/im-channel";
import type { ImChannelRouteRepository, ImChannelRouteRow } from "../../repositories/im-channel-route";
import { buildImInstanceName } from "./im-instance-name";

/**
 * 通道路由规则：匹配语义与 CRUD 编排。
 *
 * `matchRoute` 是纯函数，数据面（入站消息）与控制面（列表解释）共用同一份优先级规则——精确优先、其次
 * 通配、`enabled = false` 不参与。把它放在仓储之外是刻意的：仓储只按三列 WHERE 取行，优先级属于领域规则。
 *
 * 写路径的组织边界一律先经 `im_channel` 校验：路由行没有 `organization_id`，若只按 `routeId` 取行再更新，
 * 跨组织写会成功。这里把「路由 → 通道 → 组织」写死成唯一入口。
 */

/** 匹配所需的最小行投影；泛型保留调用方的行类型（数据面要拿 `agentConfigId`）。 */
export interface RouteMatchCandidate {
  readonly channelId: string;
  readonly chatType: ImChatType;
  readonly chatId: string | null;
  readonly enabled: boolean;
}

export interface RouteMatchTarget {
  readonly channelId: string;
  readonly chatType: ImChatType;
  readonly chatId: string;
}

/** 精确 → 通配；未命中返回 null（调用方据此把事件标记 skipped）。 */
export function matchRoute<T extends RouteMatchCandidate>(routes: readonly T[], target: RouteMatchTarget): T | null {
  const candidates = routes.filter(
    (route) => route.enabled && route.channelId === target.channelId && route.chatType === target.chatType,
  );
  return (
    candidates.find((route) => route.chatId === target.chatId) ??
    candidates.find((route) => route.chatId === null) ??
    null
  );
}

export interface RouteInstanceRef {
  readonly conversationId: string;
  readonly instanceName: string;
}

export interface RouteInstanceConversation {
  readonly id: string;
  readonly channelId: string;
  readonly chatType: ImChatType;
  readonly chatId: string;
}

/**
 * 反推每条路由当前服务的实例：匹配复用 matchRoute，因此列表里显示的实例就是真正在处理入站消息的那个。
 * 没有路由认领的会话（例如路由全部停用）不产出任何条目。
 */
export function groupInstancesByRoute(
  routes: readonly (RouteMatchCandidate & { readonly id: string })[],
  conversations: readonly RouteInstanceConversation[],
): ReadonlyMap<string, readonly RouteInstanceRef[]> {
  const grouped = new Map<string, RouteInstanceRef[]>();
  for (const conversation of conversations) {
    const route = matchRoute(routes, {
      channelId: conversation.channelId,
      chatType: conversation.chatType,
      chatId: conversation.chatId,
    });
    if (!route) continue;
    const refs = grouped.get(route.id) ?? [];
    refs.push({ conversationId: conversation.id, instanceName: buildImInstanceName(conversation.id) });
    grouped.set(route.id, refs);
  }
  return grouped;
}

/**
 * 按精确 → 通配的顺序读取当前生效的路由。
 *
 * 数据面（入站、出站）与控制面列表共用同一条优先级规则；仓储只按列取行，优先级留在这里，避免两处各写
 * 一份「精确优先」。
 */
export async function findActiveRoute(
  routes: ImChannelRouteRepository,
  target: RouteMatchTarget,
): Promise<ImChannelRouteRow | null> {
  const exact = await routes.findExact({
    channelId: target.channelId,
    chatType: target.chatType,
    chatId: target.chatId,
  });
  if (exact?.enabled) return exact;
  const wildcard = await routes.findWildcard({ channelId: target.channelId, chatType: target.chatType });
  return wildcard?.enabled ? wildcard : null;
}

export interface ChannelRouteCreateInput {
  readonly organizationId: string;
  readonly channelId: string;
  readonly chatType: ImChatType;
  readonly chatId?: string | null;
  readonly agentConfigId: string;
  readonly enabled?: boolean;
}

export interface ChannelRouteUpdatePatch {
  readonly chatType?: ImChatType;
  readonly chatId?: string | null;
  readonly agentConfigId?: string;
  readonly enabled?: boolean;
}

export interface ChannelRouteService {
  list(input: { organizationId: string; channelId?: string }): Promise<ImChannelRouteRow[]>;
  create(input: ChannelRouteCreateInput): Promise<ImChannelRouteRow>;
  update(input: {
    organizationId: string;
    routeId: string;
    patch: ChannelRouteUpdatePatch;
  }): Promise<ImChannelRouteRow>;
  delete(input: { organizationId: string; routeId: string }): Promise<void>;
  /** 按组织取路由；不存在或属于别的组织都返回 NOT_FOUND（跨组织不暴露存在性）。 */
  require(input: { organizationId: string; routeId: string }): Promise<ImChannelRouteRow>;
}

export interface ChannelRouteServiceDeps {
  readonly channels: ImChannelRepository;
  readonly routes: ImChannelRouteRepository;
}

/** PostgreSQL 唯一约束冲突；预检之后的并发写仍会落到这里。 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

function conflict(): ChannelControlError {
  return new ChannelControlError("ROUTE_CONFLICT", 409, "同一通道下已存在相同聊天目标的路由");
}

export function createChannelRouteService(deps: ChannelRouteServiceDeps): ChannelRouteService {
  const { channels, routes } = deps;

  async function requireChannel(input: { organizationId: string; channelId: string }) {
    const channel = await channels.findByIdForOrganization(input);
    if (!channel) throw new ChannelControlError("NOT_FOUND", 404, "通道不存在");
    return channel;
  }

  async function requireRoute(input: { organizationId: string; routeId: string }): Promise<ImChannelRouteRow> {
    const route = await routes.findById({ routeId: input.routeId });
    if (!route) throw new ChannelControlError("NOT_FOUND", 404, "路由不存在");
    await requireChannel({ organizationId: input.organizationId, channelId: route.channelId });
    return route;
  }

  async function assertNoConflict(input: {
    channelId: string;
    chatType: ImChatType;
    chatId: string | null;
    excludeRouteId?: string;
  }): Promise<void> {
    const existing =
      input.chatId === null
        ? await routes.findWildcard({ channelId: input.channelId, chatType: input.chatType })
        : await routes.findExact({ channelId: input.channelId, chatType: input.chatType, chatId: input.chatId });
    if (existing && existing.id !== input.excludeRouteId) throw conflict();
  }

  return {
    async list(input) {
      const scopedChannels = input.channelId
        ? [await requireChannel({ organizationId: input.organizationId, channelId: input.channelId })]
        : await channels.findManyByOrganization({ organizationId: input.organizationId });
      const lists = await Promise.all(
        scopedChannels.map((channel) => routes.findManyByChannel({ channelId: channel.id })),
      );
      return lists.flat().sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    },

    async create(input) {
      await requireChannel({ organizationId: input.organizationId, channelId: input.channelId });
      const chatId = input.chatId ?? null;
      await assertNoConflict({ channelId: input.channelId, chatType: input.chatType, chatId });
      try {
        return await routes.insert({
          channelId: input.channelId,
          chatType: input.chatType,
          chatId,
          agentConfigId: input.agentConfigId,
          enabled: input.enabled ?? true,
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict();
        throw error;
      }
    },

    async update(input) {
      const current = await requireRoute({ organizationId: input.organizationId, routeId: input.routeId });
      const chatType = input.patch.chatType ?? current.chatType;
      // `undefined` = 不改这一项，`null` = 改成通配；两者不能折叠。
      const chatId = input.patch.chatId === undefined ? current.chatId : input.patch.chatId;
      await assertNoConflict({ channelId: current.channelId, chatType, chatId, excludeRouteId: current.id });
      try {
        const updated = await routes.updateById({ routeId: current.id, patch: input.patch });
        if (!updated) throw new ChannelControlError("NOT_FOUND", 404, "路由不存在");
        return updated;
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict();
        throw error;
      }
    },

    async delete(input) {
      const current = await requireRoute({ organizationId: input.organizationId, routeId: input.routeId });
      const deleted = await routes.deleteById({ routeId: current.id });
      if (!deleted) throw new ChannelControlError("NOT_FOUND", 404, "路由不存在");
    },

    require: requireRoute,
  };
}
