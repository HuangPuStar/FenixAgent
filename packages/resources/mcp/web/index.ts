/**
 * MCP 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；跨包引用会经
 * 对方 `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），由
 * `web/__tests__/mcp-browser-surface.test.ts` 静态走值导入图守护（参照 sandbox 的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 *
 * 跨包消费面（当前实测）：宿主 `apps/web` 的 mcp 路由懒加载 `AgentMcpPage`，其纯逻辑用例取用
 * `mcp-resource-access` 的授权视图助手；页面自身消费 `mcpApi` 与 `agent-mcp-utils` 的编辑器转换。
 * 三者都在这里转出，避免消费方进入 `web/pages/**` 这类实现路径。
 */

export * from "./api/mcp";
export { MCP_NS, type McpResources, mcpResources } from "./i18n";
export * from "./lib/mcp-resource-access";
export { AgentMcpPage } from "./pages/agent-panel/pages/AgentMcpPage";
export * from "./pages/agent-panel/pages/agent-mcp-utils";
