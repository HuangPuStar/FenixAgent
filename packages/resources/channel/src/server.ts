/**
 * Channel 资源包服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server` 是合法消费者；路由一律以工厂形式导出，守卫与 Environment 归属
 * 查询由宿主注入（理由见 `./server/routes/dependencies`）。本入口不导出浏览器代码——浏览器面走
 * `@fenix/resource-channel/web`。
 */

export type { ChannelEnvironmentLookup, WebChannelRouteDependencies } from "./server/routes/dependencies";
export { createWebChannelsRoutes } from "./server/routes/web/channels";
export * from "./server/services/acp-event-bus-port";
export * from "./server/services/channel-binding";
export type { HermesClientOptions } from "./server/services/hermes-client";
export { getHermesClient, initHermesClient, resetHermesClient } from "./server/services/hermes-client";
