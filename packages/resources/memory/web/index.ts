/**
 * Hindsight 记忆控制台的浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名 `@/...`；
 * 跨包引用会经对方 `exports` 递归进入后一并检查，由 `web/__tests__/memory-browser-surface.test.ts`
 * 静态走值导入图守护（口径与 `@fenix/resource-sandbox/web` 的同名守卫一致）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 *
 * 导出面对齐真实消费方：宿主 `apps/web` 取 `MemoriesPage` 与语言资源（§1.6 接线），
 * `@fenix/agent-config` 的 Agent 编辑器取 `hindsightApi.getStatus()` 判断记忆开关。
 */

export { hindsightApi } from "./api/hindsight";
export { HINDSIGHT_NS, type HindsightResources, hindsightResources } from "./i18n";
export { MemoriesPage } from "./pages/hindsight/MemoriesPage";
export * from "./pages/hindsight/types";
