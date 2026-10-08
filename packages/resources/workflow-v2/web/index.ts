/**
 * Workflow V2 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名。因此这里只导出可在
 * 浏览器执行的模块；服务端能力走 `./server`，组合根走 `./module`，两者都不从这里转出。
 *
 * 面按「消费方实际需要」收敛：控制台的两个页面（列表页、画布宿主页）经本入口发布——没有包外消费方时提前
 * 铺开会把内部结构固化成公共契约（CLAUDE.md 原则 7），宿主 route adapter 也不穿透到 `web/pages/**`；
 * `web/api/**`（`workflows` / `canvas-session`）同样只服务包内页面，页面自己按相对路径取用，不出现在这里。
 * 全部用显式命名导出而不是 `export *`：入口是被守护的契约面，新增导出必须是一次显式决定。
 */

export { webContribution } from "./contribution";
export { WORKFLOW_NS, type WorkflowResources, workflowResources } from "./i18n";
export { WorkflowCanvasHostPage, type WorkflowCanvasHostPageProps } from "./pages/canvas/canvas-host-page";
export { WorkflowListPage } from "./pages/list/workflow-list-page";
