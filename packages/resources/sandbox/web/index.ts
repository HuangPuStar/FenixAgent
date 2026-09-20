/**
 * Sandbox 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名，
 * 由 `web/__tests__/sandbox-browser-surface.test.ts` 静态走值导入图守护（参照 chat-channel 的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 */

export { SANDBOX_NS, type SandboxResources, sandboxResources } from "./i18n";
export * from "./src/api/sandbox-pools";
export * from "./src/api/system-organizations";
export * from "./src/api/system-sandbox";
export { clearAdminKey, getAdminKey, setAdminKey } from "./src/lib/admin-key";
export { AdminSandboxPage } from "./src/pages/admin/AdminSandboxPage";
export { MasterKeyGate } from "./src/pages/admin/components/MasterKeyGate";
export { RemoteSandboxPanel } from "./src/pages/admin/components/RemoteSandboxPanel";
export {
  SearchableUsageFilter,
  type SearchableUsageFilterOption,
} from "./src/pages/admin/components/SearchableUsageFilter";
export * from "./src/pages/admin/utils";
