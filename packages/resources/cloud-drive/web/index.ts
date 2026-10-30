/**
 * 云盘控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；跨包引用会经
 * 对方 `exports` 递归进入后一并检查。因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，
 * 不得从这里转出。字典资源走 `./web/i18n` 子路径——宿主在启动期求值，从根入口导入会把页面拉进首屏。
 *
 * 当前导出面：宿主路由壳只需要页面；`cloudDriveApi` 与 DTO 类型供后续跨包消费（当前无第二消费者，
 * 保持窄口）。
 */

export { cloudDriveApi } from "./api/cloud-drive";
export { CloudDrivePage } from "./pages/cloud-drive-page";
export type * from "./types/cloud-drive";
