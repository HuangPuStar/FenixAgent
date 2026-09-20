/**
 * ProdView 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；跨包引用会经对方
 * `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），由
 * `web/__tests__/prod-view-browser-surface.test.ts` 静态走值导入图守护（参照 chat-channel / sandbox 的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 *
 * 导出面的口径是「宿主与其它包真实需要的符号」：
 *   - `ProdViewsPanel` / `AgentProdViewsPage`：宿主 ArtifactsPanel 与 `/agent/_panel/views` 路由挂载；
 *   - `ProdViewPage`：`/view/$prodViewId` 公开路由；
 *   - api 与类型：`ProdViewModulesConfig` 被宿主 ArtifactsPanel 与 chat-channel 的 ChatArea 用作
 *     modulesConfig 的类型契约；
 *   - i18n：宿主 `apps/web/src/i18n/index.ts` 统一注册，走 `./web/i18n` 子路径（见 web/i18n/index.ts）。
 *
 * 内部实现细节（`web/lib/prod-view-modules` 的构建/解析辅助函数、`web/api` 之外的模块）不从这里转出：
 * 它们服务本包页面，转出会形成无人消费的公共面。
 */

export * from "./api/prod-views";
export { PROD_VIEWS_NS, type ProdViewsResources, prodViewsResources } from "./i18n";
export { ProdViewsPanel } from "./pages/agent-panel/ProdViewsPanel";
export { AgentProdViewsPage } from "./pages/agent-panel/pages/AgentProdViewsPage";
export { ProdViewPage } from "./pages/prod-view/ProdViewPage";
