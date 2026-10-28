/**
 * Channel 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；服务端能力走
 * `./server`，不得从这里转出。页面由宿主路由壳懒加载，页面内的组件与 API 不另开窄出口。
 */

export * from "./api/langbot";
export { CHANNELS_NS, type ChannelResources, channelsResources } from "./i18n";
export { AgentChannelsPage } from "./pages/agent-panel/pages/AgentChannelsPage";
