/**
 * Sandbox 资源包服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server` 与 `@fenix/agent-runtime` 是合法消费者；路由一律以工厂形式导出，
 * 守卫由宿主注入（理由见 `./routes/dependencies`）。本入口不导出浏览器代码。
 */

export { createApiSandboxRoutes, mapSandboxApiError } from "./routes/api/sandbox";
export { createApiSandboxClusterRoutes, mapSandboxClusterAdminError } from "./routes/api/sandbox-cluster";
export { createApiSandboxServerRoutes } from "./routes/api/sandbox-server";
export type { SystemApiSandboxRouteDependencies, WebSandboxRouteDependencies } from "./routes/dependencies";
export { createWebSandboxPoolsRoutes } from "./routes/web/sandbox-pools";
export type { SandboxModuleConfig } from "./server/config";
export { getSandboxConfig } from "./server/config";
export * from "./server/repositories/sandbox-instance-repository";
export * from "./server/repositories/sandbox-pool-repository";
export * from "./server/schemas/api-sandbox.schema";
export * from "./server/schemas/api-sandbox-cluster.schema";
export * from "./server/schemas/api-sandbox-server.schema";
export * from "./server/services/index";
export * from "./server/services/sandbox-admin-service";
export * from "./server/services/sandbox-cluster-admin-service";
export * from "./server/services/sandbox-config";
export * from "./server/services/sandbox-default-pool";
export * from "./server/services/sandbox-errors";
export * from "./server/services/sandbox-execution-handler";
export * from "./server/services/sandbox-manager";
export * from "./server/services/sandbox-provider-registry";
export * from "./server/services/sandbox-server-admin-service";
