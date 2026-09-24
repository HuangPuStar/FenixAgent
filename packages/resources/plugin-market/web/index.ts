/**
 * 插件市场控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；跨包引用会经对方
 * `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），由
 * `web/__tests__/plugin-market-browser-surface.test.ts` 静态走值导入图守护（参照 mcp / sandbox 的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 *
 * 跨包消费面（当前实测）：宿主 `apps/web` 的插件市场路由懒加载 `PluginMarketPage`；页面自身消费
 * `pluginMarketApi` 与 `plugin-market-utils` 的过滤、展示与冲突解析助手。三者都在这里转出，避免消费方
 * 进入 `web/pages/**` 这类实现路径。
 */

export * from "./api/plugin-market";
export type * from "./api/plugin-market-types";
export { PLUGIN_MARKET_NS, type PluginMarketResources, pluginMarketResources } from "./i18n";
export { PluginMarketPage } from "./pages/agent-panel/pages/plugin-market-page";
export * from "./pages/agent-panel/pages/plugin-market-utils";
