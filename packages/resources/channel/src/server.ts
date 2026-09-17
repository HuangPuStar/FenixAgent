/** Channel 资源包的服务端公开入口。 */

export { default as webChannelsRoutes } from "./server/routes/web/channels";
export * from "./server/services/acp-event-bus-port";
export * from "./server/services/channel-binding";
export { getHermesClient, initHermesClient, resetHermesClient } from "./server/services/hermes-client";
