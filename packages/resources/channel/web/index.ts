/**
 * Channel 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；
 * 跨包引用会经对方 `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），
 * 由 `web/__tests__/channel-browser-surface.test.ts` 静态走值导入图守护（参照 sandbox 的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 */

export * from "./api/channels";
export { CHANNELS_NS, type ChannelResources, channelsResources } from "./i18n";
export { AgentChannelsPage } from "./pages/agent-panel/pages/AgentChannelsPage";
