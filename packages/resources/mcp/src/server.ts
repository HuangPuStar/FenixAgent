/**
 * MCP 资源包服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server`、`@fenix/resource-agent-config` 与 `@fenix/resource-memory` 是合法消费者
 * （后者经 `./server/runtime` 与 `./server/config` 子路径，避免 barrel 把 HTTP 路由拉进其依赖图）。
 * 会话鉴权路由一律以工厂形式导出，守卫由宿主注入（理由见 `./server/routes/dependencies`）；只有
 * `/mcp/knowledge` 是模块级单例（Bearer environment secret 自鉴权，无注入点，见该文件注释）。
 * 本入口不导出浏览器代码。
 */

export { MCP_SERVER_RESOURCE_TYPE, mcpServerResource } from "./server/access/mcp-server-resource";
export type { McpServerFacadeApi } from "./server/facades/mcp-server-facade";
export {
  createMcpServerServerModule,
  type McpServerModuleDeps,
  type McpServerServerModule,
} from "./server/module";
export { createApiMcpRoutes } from "./server/routes/api/mcp";
export type { McpRouteDependencies } from "./server/routes/dependencies";
export { default as knowledgeMcpRoutes } from "./server/routes/mcp/knowledge";
export { createWebMcpConfigRoutes } from "./server/routes/web/config/mcp";
export { getMcpServerModule, installMcpServerModule } from "./server/runtime";
export * from "./server/services/config/agent-config-mcp";
export * from "./server/services/config/mcp-config";
export * from "./server/services/mcp-inspector";
