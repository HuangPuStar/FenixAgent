/**
 * 插件市场控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；跨包引用会经对方
 * `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），由
 * `web/__tests__/plugin-market-browser-surface.test.ts` 静态走值导入图守护（参照 mcp / sandbox 的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 *
 * 导出面按**包外真实消费点**收敛（实测 `git grep -n "@fenix/resource-plugin-market/web" -- apps` 命中三处）：
 *   - `apps/web/src/routes/agent/_panel/mcp.tsx` 懒加载 `PluginMarketPage`（控制台那一 tab，**只读**）；
 *   - `apps/web/src/routes/admin/plugin-market.tsx` 懒加载 `AdminPluginMarketPage`（管理台，凭据是 master key）；
 *   - 两条路径的 i18n 资源经 `./web/i18n` 子路径登记。
 * 其余页面、API 模块与纯逻辑助手都是这两个页面的内部件：今天没有第二个消费者，提前导出只会让它们的形状
 * 变成对外契约（与 task 包同一口径）。两条面的页面都在这里转出，消费方因此不必进入 `web/pages/**` 实现路径。
 */

export { PLUGIN_MARKET_NS, type PluginMarketResources, pluginMarketResources } from "./i18n";
export { AdminPluginMarketPage } from "./pages/admin/AdminPluginMarketPage";
export { PluginMarketPage } from "./pages/agent-panel/pages/plugin-market-page";
