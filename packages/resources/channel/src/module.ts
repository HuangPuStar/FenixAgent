import { bindAcpEventBusPort, getAcpEventBusPort, resetAcpEventBusPort } from "./server/services/acp-event-bus-port";
import { getHermesClient, initHermesClient, resetHermesClient } from "./server/services/hermes-client";

/**
 * Channel 模块的运行时表面。
 *
 * 只暴露需要「对象身份」的能力：Hermes 客户端与 ACP 事件总线端口都是**进程级单例**——
 * 前者持有唯一的网关 WebSocket 与订阅集合，后者是 Machine 事件总线的唯一绑定点。两份实例
 * 会让同一批通道绑定开两条回投路径、或让出站路由读到未绑定的端口，因此组合根返回包内既有
 * 单例的入口，而不是新建一套。
 *
 * 路由工厂与 `listChannelProviders` 之类的纯函数是宿主显式调用的入口，不经过模块实例即可使用，
 * 故不在这里重复包装；等 registry 驱动的装配落地（§1.5 的 `mountContribution`）需要统一拿到
 * 它们时再按需扩展（与 `@fenix/resource-sandbox` 的组合根同口径）。
 */
export interface ChannelModule {
  readonly id: "channel";
  /** Hermes 网关客户端单例：装配期初始化、运行期读取、释放时停连。 */
  readonly hermesClient: {
    readonly init: typeof initHermesClient;
    readonly get: typeof getHermesClient;
    readonly reset: typeof resetHermesClient;
  };
  /** Machine ACP 事件总线端口：装配期绑定；未绑定时 `get` fail-fast，禁止反向依赖 Machine。 */
  readonly acpEventBus: {
    readonly bind: typeof bindAcpEventBusPort;
    readonly get: typeof getAcpEventBusPort;
    readonly reset: typeof resetAcpEventBusPort;
  };
}

/** 创建 Channel 模块实例；返回的是包内既有单例的入口，不产生第二份运行期状态。 */
export function createChannelModule(): ChannelModule {
  return {
    id: "channel",
    hermesClient: { init: initHermesClient, get: getHermesClient, reset: resetHermesClient },
    acpEventBus: { bind: bindAcpEventBusPort, get: getAcpEventBusPort, reset: resetAcpEventBusPort },
  };
}
