import type { ImChatType } from "@fenix/resource-channel/db";
import { createLangBotChannelFacade, type LangBotChannelFacadeApi } from "../server/facades/langbot-channel-facade";
import type { ChannelServerModule } from "../server/module";
import type { ChannelAgentConfigLookup, ChannelAgentConfigLookupResult } from "../server/ports/agent-config-lookup";
import { ChannelAgentConfigUnavailableError } from "../server/ports/agent-config-lookup";
import type { ImChannelRepository, ImChannelRow } from "../server/repositories/im-channel";
import type {
  ImChannelConversationInsertInput,
  ImChannelConversationRepository,
  ImChannelConversationRow,
} from "../server/repositories/im-channel-conversation";
import type { ImChannelRouteRepository, ImChannelRouteRow } from "../server/repositories/im-channel-route";
import { installChannelModule, resetChannelModule } from "../server/runtime";
import { type ChannelService, createChannelService } from "../server/services/langbot/channel-service";
import type { LangBotClient } from "../server/services/langbot/client";
import { type ChannelRouteService, createChannelRouteService } from "../server/services/langbot/route-service";

/**
 * 控制面用例的共享设施。
 *
 * 用**内存仓储 + 真实服务层 + 真实门面**，而不是给 Facade 打桩：跨组织 404、补偿顺序、视图脱敏这些行为
 * 恰恰在服务层与门面的协作里，替身 Facade 只能测到路由的转发。
 *
 * 所有数据都刻意不含真实凭据；`config` 里的哨兵值由用例自己生成。
 */

const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

function nextId(): string {
  return crypto.randomUUID();
}

export function makeChannel(overrides: Partial<ImChannelRow> = {}): ImChannelRow {
  return {
    id: nextId(),
    userId: "owner-1",
    organizationId: "org-1",
    name: "飞书机器人",
    description: null,
    platform: "langbot",
    credentials: { botUuid: "bot-1" },
    status: "connected",
    lastError: null,
    enabled: true,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export function makeRoute(overrides: Partial<ImChannelRouteRow> = {}): ImChannelRouteRow {
  return {
    id: nextId(),
    channelId: "channel-1",
    chatType: "person" as ImChatType,
    chatId: "user-a",
    agentConfigId: "agent-1",
    enabled: true,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export function makeConversation(overrides: Partial<ImChannelConversationRow> = {}): ImChannelConversationRow {
  return {
    id: nextId(),
    channelId: "channel-1",
    chatType: "person" as ImChatType,
    chatId: "user-a",
    agentConfigId: "agent-1",
    rcsSessionId: "rcs_abcdefghijklmnop",
    acpSessionId: "ses_1234567890",
    lastEventAt: CREATED_AT,
    lastReplyAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export interface InMemoryChannelRepository extends ImChannelRepository {
  readonly rows: ImChannelRow[];
}

export function createInMemoryChannelRepository(initial: ImChannelRow[] = []): InMemoryChannelRepository {
  const rows = [...initial];
  return {
    rows,
    async findById({ channelId }) {
      return rows.find((row) => row.id === channelId);
    },
    async findByIdForOrganization({ channelId, organizationId }) {
      return rows.find((row) => row.id === channelId && row.organizationId === organizationId);
    },
    async findManyByOrganization({ organizationId }) {
      return rows
        .filter((row) => row.organizationId === organizationId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    },
    async findAll() {
      return [...rows].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    },
    async insert(input) {
      const now = new Date();
      const row = makeChannel({
        id: nextId(),
        userId: input.userId,
        organizationId: input.organizationId,
        name: input.name,
        description: input.description ?? null,
        platform: input.platform,
        credentials: input.credentials,
        status: input.status ?? "disconnected",
        lastError: input.lastError ?? null,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      });
      rows.push(row);
      return row;
    },
    async updateById({ channelId, patch }) {
      const index = rows.findIndex((row) => row.id === channelId);
      if (index < 0) return;
      const next: ImChannelRow = { ...rows[index]!, ...patch, updatedAt: new Date() };
      rows[index] = next;
      return next;
    },
    async deleteById({ channelId }) {
      const index = rows.findIndex((row) => row.id === channelId);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
  };
}

export interface InMemoryRouteRepository extends ImChannelRouteRepository {
  readonly rows: ImChannelRouteRow[];
}

export function createInMemoryRouteRepository(initial: ImChannelRouteRow[] = []): InMemoryRouteRepository {
  const rows = [...initial];
  return {
    rows,
    async findById({ routeId }) {
      return rows.find((row) => row.id === routeId);
    },
    async findExact({ channelId, chatType, chatId }) {
      return rows.find((row) => row.channelId === channelId && row.chatType === chatType && row.chatId === chatId);
    },
    async findWildcard({ channelId, chatType }) {
      return rows.find((row) => row.channelId === channelId && row.chatType === chatType && row.chatId === null);
    },
    async findManyByChannel({ channelId }) {
      return rows.filter((row) => row.channelId === channelId);
    },
    async countByChannels({ channelIds }) {
      const result = new Map<string, number>();
      for (const row of rows) {
        if (!channelIds.includes(row.channelId)) continue;
        result.set(row.channelId, (result.get(row.channelId) ?? 0) + 1);
      }
      return result;
    },
    async insert(input) {
      const now = new Date();
      const row = makeRoute({
        id: nextId(),
        channelId: input.channelId,
        chatType: input.chatType,
        chatId: input.chatId ?? null,
        agentConfigId: input.agentConfigId,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      });
      rows.push(row);
      return row;
    },
    async updateById({ routeId, patch }) {
      const index = rows.findIndex((row) => row.id === routeId);
      if (index < 0) return;
      const next: ImChannelRouteRow = { ...rows[index]!, ...patch, updatedAt: new Date() };
      rows[index] = next;
      return next;
    },
    async deleteById({ routeId }) {
      const index = rows.findIndex((row) => row.id === routeId);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
    async deleteByChannel({ channelId }) {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index]!.channelId === channelId) rows.splice(index, 1);
      }
      return before - rows.length;
    },
  };
}

export interface InMemoryConversationRepository extends ImChannelConversationRepository {
  readonly rows: ImChannelConversationRow[];
}

export function createInMemoryConversationRepository(
  initial: ImChannelConversationRow[] = [],
): InMemoryConversationRepository {
  const rows = [...initial];

  function findRow(channelId: string, chatType: ImChatType, chatId: string): ImChannelConversationRow | undefined {
    return rows.find((row) => row.channelId === channelId && row.chatType === chatType && row.chatId === chatId);
  }

  function insertRow(input: ImChannelConversationInsertInput): ImChannelConversationRow {
    const now = new Date();
    const row = makeConversation({
      id: input.id ?? nextId(),
      channelId: input.channelId,
      chatType: input.chatType,
      chatId: input.chatId,
      agentConfigId: input.agentConfigId,
      rcsSessionId: input.rcsSessionId,
      acpSessionId: input.acpSessionId ?? null,
      lastEventAt: null,
      lastReplyAt: null,
      createdAt: now,
      updatedAt: now,
    });
    rows.push(row);
    return row;
  }

  function patchRow(
    conversationId: string,
    patch: Partial<ImChannelConversationRow>,
  ): ImChannelConversationRow | undefined {
    const index = rows.findIndex((row) => row.id === conversationId);
    const current = rows[index];
    if (!current) return;
    const next: ImChannelConversationRow = { ...current, ...patch };
    rows[index] = next;
    return next;
  }

  return {
    rows,
    async findById({ conversationId }) {
      return rows.find((row) => row.id === conversationId);
    },
    async findByChat({ channelId, chatType, chatId }) {
      return findRow(channelId, chatType, chatId);
    },
    async findManyByChannels({ channelIds, limit, offset }) {
      return rows.filter((row) => channelIds.includes(row.channelId)).slice(offset, offset + limit);
    },
    async findAllByChannels({ channelIds }) {
      return rows.filter((row) => channelIds.includes(row.channelId));
    },
    async countByChannels({ channelIds }) {
      return rows.filter((row) => channelIds.includes(row.channelId)).length;
    },
    async insert(input) {
      return insertRow(input);
    },
    async insertIfAbsent(input) {
      // 真实仓储靠唯一键冲突返回 undefined；这里按同一唯一键模拟，避免用例误以为能并发插入两条。
      if (findRow(input.channelId, input.chatType, input.chatId)) return;
      return insertRow(input);
    },
    async resetForAgent({ conversationId, agentConfigId, rcsSessionId }) {
      return patchRow(conversationId, { agentConfigId, rcsSessionId, acpSessionId: null, lastReplyAt: null });
    },
    async updateAcpSession({ conversationId, acpSessionId }) {
      return patchRow(conversationId, { acpSessionId });
    },
    async touchLastEventAt({ conversationId, at }) {
      patchRow(conversationId, { lastEventAt: at, updatedAt: at });
    },
    async touchLastReplyAt({ conversationId, at }) {
      patchRow(conversationId, { lastReplyAt: at, updatedAt: at });
    },
    async deleteByChannel({ channelId }) {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index]!.channelId === channelId) rows.splice(index, 1);
      }
      return before - rows.length;
    },
  };
}

/** LangBot 客户端替身：未显式覆盖的方法一律失败，用来证明某条路径没有访问 LangBot。 */
export function createStubLangBotClient(overrides: Partial<LangBotClient> = {}): LangBotClient {
  const unexpected = (name: string) => async (): Promise<never> => {
    throw new Error(`未预期的 LangBot 调用: ${name}`);
  };
  return {
    status: overrides.status ?? unexpected("status"),
    listBots: overrides.listBots ?? unexpected("listBots"),
    getBot: overrides.getBot ?? unexpected("getBot"),
    createBot: overrides.createBot ?? unexpected("createBot"),
    updateBot: overrides.updateBot ?? unexpected("updateBot"),
    deleteBot: overrides.deleteBot ?? unexpected("deleteBot"),
    sendMessage: overrides.sendMessage ?? unexpected("sendMessage"),
  };
}

export interface RecordingAgentConfigLookup {
  readonly lookup: ChannelAgentConfigLookup;
  readonly requests: { organizationId: string; ownerUserId: string; agentConfigId: string }[];
}

/** 记录门面传给端口的执行身份；`unavailable` 为 true 时模拟「所有者不可用」。 */
export function createRecordingAgentConfigLookup(
  options: { unavailable?: boolean; result?: ChannelAgentConfigLookupResult } = {},
): RecordingAgentConfigLookup {
  const requests: { organizationId: string; ownerUserId: string; agentConfigId: string }[] = [];
  const result = options.result ?? { id: "agent-1", name: "Agent", engineType: null };
  return {
    requests,
    lookup: {
      async requireUsable(input) {
        requests.push({ ...input });
        if (options.unavailable) throw new ChannelAgentConfigUnavailableError();
        return result;
      },
    },
  };
}

export interface ChannelTestContext {
  readonly channels: InMemoryChannelRepository;
  readonly routes: InMemoryRouteRepository;
  readonly conversations: InMemoryConversationRepository;
  readonly client: LangBotClient;
  readonly service: ChannelService;
  readonly routeService: ChannelRouteService;
  readonly facade: LangBotChannelFacadeApi;
  readonly module: ChannelServerModule;
}

/** 构造真实服务与门面并装入进程槽位；调用方在 `afterEach` 里执行 `resetChannelModule()`。 */
export function createChannelTestContext(
  input: {
    channels?: ImChannelRow[];
    routes?: ImChannelRouteRow[];
    conversations?: ImChannelConversationRow[];
    client?: Partial<LangBotClient>;
    agentConfigLookup?: ChannelAgentConfigLookup;
  } = {},
): ChannelTestContext {
  const channels = createInMemoryChannelRepository(input.channels);
  const routes = createInMemoryRouteRepository(input.routes);
  const conversations = createInMemoryConversationRepository(input.conversations);
  const client = createStubLangBotClient(input.client);
  const routeService = createChannelRouteService({ channels, routes });
  const service = createChannelService({ client, channels, routes, conversations });
  const lookup = input.agentConfigLookup ?? createRecordingAgentConfigLookup().lookup;
  const facade = createLangBotChannelFacade({
    service,
    routes: routeService,
    agentConfigLookup: () => lookup,
  });
  const module: ChannelServerModule = { facade, service, routeService, client };
  installChannelModule(module);
  return { channels, routes, conversations, client, service, routeService, facade, module };
}

export { resetChannelModule };
