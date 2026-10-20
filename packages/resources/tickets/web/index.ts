/**
 * 工单控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 导出面按**包外真实消费点**收敛：宿主 i18n 经 `./web/i18n` 子路径取字典；两个宿主薄路由经本入口懒加载
 * `AgentTicketsPage` / `AgentTicketDetailPage`，管理台薄路由懒加载 `AdminTicketsPage`（系统 key 管理面，
 * 挂宿主 `/admin/tickets`）。其余页面级组件（筛选条、列表表格、创建弹窗、管理面的列表容器）是页面的
 * 内部视图，今天没有第二个消费者，不导出——提前导出只会让内部视图的 props 形状变成对外契约。
 *
 * 服务端能力走 `./server`，不得从这里转出；浏览器面 = 本文件的整条值导入图里不出现 `node:` 内建、
 * `@server/*` 或宿主别名。
 */

export * from "./api/system-tickets";
export * from "./api/ticket-projects";
export * from "./api/tickets";
export { TICKETS_NS, type TicketsResources, ticketsResources } from "./i18n";
export { AdminTicketsPage } from "./pages/admin/AdminTicketsPage";
export { AgentTicketDetailPage } from "./pages/agent-panel/pages/AgentTicketDetailPage";
export { AgentTicketsPage } from "./pages/agent-panel/pages/AgentTicketsPage";
