import { type ChannelModuleConfig, getChannelConfig } from "./config";
import { ChannelControlError } from "./contracts";
import { createLangBotChannelFacade, type LangBotChannelFacadeApi } from "./facades/langbot-channel-facade";
import { type ChannelAgentConfigLookup, getChannelAgentConfigLookup } from "./ports/agent-config-lookup";
import { getImSessionPort, type ImSessionPort } from "./ports/im-session";
import { createImChannelRepository } from "./repositories/im-channel";
import { createImChannelConversationRepository } from "./repositories/im-channel-conversation";
import { createImChannelEventRepository } from "./repositories/im-channel-event";
import { createImChannelRouteRepository } from "./repositories/im-channel-route";
import { createImMcpService, type ImMcpService } from "./services/im-mcp/service";
import { type ChannelService, createChannelService } from "./services/langbot/channel-service";
import { createLangBotClient, type LangBotClient } from "./services/langbot/client";
import { type ConversationService, createConversationService } from "./services/langbot/conversation-service";
import { createDeliveryDispatcher, type DeliveryDispatcher } from "./services/langbot/delivery-dispatcher";
import { createImSessionBridge, type ImSessionBridge } from "./services/langbot/im-session-bridge";
import { createInboundService, type InboundService } from "./services/langbot/inbound-service";
import { createImOutboundService, type ImOutboundService } from "./services/langbot/outbound-service";
import { type ChannelRouteService, createChannelRouteService } from "./services/langbot/route-service";

/**
 * Channel 资源包组合根。
 *
 * 依赖由注入方提供：LangBot 客户端（测试注入 fetch 替身）与 Agent 配置可用性端口（宿主启动期绑定）。
 * 本包不 import 宿主实现，也不在模块内部保存可变单例——一次装配产出一个实例集。
 *
 * LangBot 客户端是**惰性**的：配置在每次调用时经 `getChannelConfig()` 读取。原因有两条：
 * 1. 未配置 LangBot 的部署仍必须能启动服务，缺配置只应让控制面端点返回 503，而不是让装配失败；
 * 2. 测试与运维可以在同一进程里替换模块配置，客户端必须跟着当前的已校验值走，不能缓存第一次的结果。
 */

export interface ChannelModuleDeps {
  /** 测试注入：完整的客户端替身（优先于 `fetcher`）。 */
  readonly langbotClient?: LangBotClient;
  /** 测试注入：只替换底层 `fetch`，仍走真实的请求/响应映射。 */
  readonly fetcher?: typeof fetch;
  /** 测试注入：Agent 配置可用性端口；生产由宿主在装配后绑定。 */
  readonly agentConfigLookup?: ChannelAgentConfigLookup;
  /** 测试注入：IM 会话端口；生产由宿主启动期绑定，模块在调用时取值。 */
  readonly imSessionPort?: ImSessionPort;
  /** 测试注入：完整桥接替身（优先于 `imSessionPort`）。 */
  readonly imSessionBridge?: ImSessionBridge;
}

export interface ChannelServerModule {
  readonly facade: LangBotChannelFacadeApi;
  readonly service: ChannelService;
  readonly routeService: ChannelRouteService;
  readonly client: LangBotClient;
  /**
   * 数据面能力；控制面用例的模块替身可以省略。
   *
   * 省略时 Webhook 路由会显式报「未装配」，而不是让端点以 404/500 的业务外观静默消失。
   */
  readonly dataPlane?: ChannelDataPlane;
}

/** IM 数据面的进程级协作对象；dispatcher 必须单例，否则同一会话会出现多条重试路径。 */
export interface ChannelDataPlane {
  readonly conversationService: ConversationService;
  readonly inbound: InboundService;
  readonly outbound: ImOutboundService;
  readonly dispatcher: DeliveryDispatcher;
  /** 冷启动桥接；入站接受事件后经它确保专属实例并决定 prompt / 通知。 */
  readonly bridge: ImSessionBridge;
  /**
   * `/mcp/im` 的领域服务。
   *
   * 可选：控制面用例的模块替身不需要它；装配后缺失时 MCP 路由显式报「未装配」，而不是返回空结果。
   */
  readonly mcp?: ImMcpService;
}

function requireLangBotConfig(config: ChannelModuleConfig): { baseUrl: string; apiKey: string } {
  if (!config.langbotBaseUrl || !config.langbotApiKey) {
    throw new ChannelControlError(
      "LANGBOT_NOT_CONFIGURED",
      503,
      "LangBot 未配置：需要 LANGBOT_BASE_URL 与 LANGBOT_API_KEY",
    );
  }
  return { baseUrl: config.langbotBaseUrl, apiKey: config.langbotApiKey };
}

/** 每次调用读取当前配置并构造客户端；构造本身无 I/O，缓存只会引入配置漂移。 */
function createLazyLangBotClient(fetcher?: typeof fetch): LangBotClient {
  const resolve = (): LangBotClient => {
    const { baseUrl, apiKey } = requireLangBotConfig(getChannelConfig());
    return createLangBotClient({ baseUrl, apiKey, ...(fetcher ? { fetcher } : {}) });
  };
  return {
    status: () => resolve().status(),
    listBots: () => resolve().listBots(),
    getBot: (botUuid) => resolve().getBot(botUuid),
    createBot: (input) => resolve().createBot(input),
    updateBot: (botUuid, input) => resolve().updateBot(botUuid, input),
    deleteBot: (botUuid) => resolve().deleteBot(botUuid),
    sendMessage: (botUuid, input) => resolve().sendMessage(botUuid, input),
  };
}

/** 每次调用转发到当前绑定，兼容「模块先于宿主端口绑定构造」的装配顺序。 */
function createLazyImSessionPort(resolve: () => ImSessionPort): ImSessionPort {
  return {
    ensureInstance: (input) => resolve().ensureInstance(input),
    openSession: (input) => resolve().openSession(input),
    sendWakePrompt: (input) => resolve().sendWakePrompt(input),
    close: (session) => resolve().close(session),
  };
}

export function createChannelServerModule(deps: ChannelModuleDeps = {}): ChannelServerModule {
  const client = deps.langbotClient ?? createLazyLangBotClient(deps.fetcher);
  const channels = createImChannelRepository();
  const routes = createImChannelRouteRepository();
  const conversations = createImChannelConversationRepository();
  const events = createImChannelEventRepository();

  const routeService = createChannelRouteService({ channels, routes });
  const service = createChannelService({ client, channels, routes, conversations });
  const injectedLookup = deps.agentConfigLookup;
  const facade = createLangBotChannelFacade({
    service,
    routes: routeService,
    // 端口在宿主启动流程里晚于模块构造绑定，因此这里传取值函数而不是实例。
    ...(injectedLookup ? { agentConfigLookup: () => injectedLookup } : {}),
  });

  const conversationService = createConversationService({ conversations });
  const dispatcher = createDeliveryDispatcher({ events, conversations });
  const outbound = createImOutboundService({ client, channels, conversations, routes, events });
  const injectedImSessionPort = deps.imSessionPort;
  const bridge =
    deps.imSessionBridge ??
    createImSessionBridge({
      // 端口可能在模块构造之后才由宿主绑定，因此转发取值而不是捕获实例。
      port: createLazyImSessionPort(injectedImSessionPort ? () => injectedImSessionPort : getImSessionPort),
    });
  const inbound = createInboundService({
    channels,
    routes,
    conversations,
    events,
    conversationService,
    dispatcher,
    bridge,
    // 固定提示是平台代发，不是 Agent 回复；失败只记日志，不影响 Webhook 响应。
    notifyUnsupported: (input) => outbound.notifyUnsupported(input),
    notifyFailure: (input) => outbound.notifyUnsupported(input),
  });
  const mcp = createImMcpService({
    channels,
    conversations,
    events,
    outbound,
    dispatcher,
    // 端口在宿主启动流程里晚于模块构造绑定，因此这里传取值函数而不是实例。
    agentConfigLookup: () => injectedLookup ?? getChannelAgentConfigLookup(),
  });

  return {
    facade,
    service,
    routeService,
    client,
    dataPlane: { conversationService, inbound, outbound, dispatcher, bridge, mcp },
  };
}
