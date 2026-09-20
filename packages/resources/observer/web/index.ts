/**
 * Observer 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；
 * 跨包引用会经对方 `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），
 * 由 `web/__tests__/observer-browser-surface.test.ts` 静态走值导入图守护（参照 chat-channel 与 sandbox 的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 *
 * 导出面 = 控制台消费方（宿主 `apps/web` 的 admin 路由与后续 WebShell）需要的全部符号：
 * 三个系统级 API client、三个 admin 页面组件、被页面复用的展示组件，以及本包命名空间的文案资源。
 * 组件内的纯展示细节（如 tree 的递归渲染）不单独导出，避免把「顺手导出」变成事实上的公共契约。
 */

export * from "./api/observer";
export * from "./api/system-logs";
export * from "./api/system-people-tree";
export { OBSERVER_NS, type ObserverResources, observerResources } from "./i18n";
export { AdminLogsPage } from "./pages/admin/AdminLogsPage";
export { AdminObserverPage } from "./pages/admin/AdminObserverPage";
export { AdminPeoplePage } from "./pages/admin/AdminPeoplePage";
export { ObserverFlatTable } from "./pages/admin/components/ObserverFlatTable";
export { ObserverIntegrityAlert } from "./pages/admin/components/ObserverIntegrityAlert";
export { ObserverMachineTree } from "./pages/admin/components/ObserverMachineTree";
export { ObserverOrgTree } from "./pages/admin/components/ObserverOrgTree";
