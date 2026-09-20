/**
 * Sandbox 资源包服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server` 与 `@fenix/agent-runtime` 是合法消费者；路由一律以工厂形式导出，
 * 守卫由宿主注入（理由见 `./server/routes/dependencies`）。本入口不导出浏览器代码。
 */

export type { SandboxModuleConfig } from "./server/config";
export { getSandboxConfig } from "./server/config";
// 路由目录是 `src/server/routes/**`（计划 §2.3 的包内树），不再放在 `src/routes/**`：
// 目录层级本身就是依赖方向声明（routes 只经 services / schemas / repositories 触达领域），
// 平铺在 `src/` 下会让「路由与服务端实现同级」的读法成立，也与其他 12 个资源包的形状分叉。
// `mapSandboxClusterAdminError` 由 `./server/error-mapping` 再导出，而不是从某个 route 模块：
// 两个 route 都要用它，从其中一方导入会形成 §1.3(2) 禁止的 route → route 依赖边。
export { mapSandboxClusterAdminError } from "./server/error-mapping";
export * from "./server/repositories/sandbox-instance-repository";
export * from "./server/repositories/sandbox-pool-repository";
export { createApiSandboxRoutes, mapSandboxApiError } from "./server/routes/api/sandbox";
export { createApiSandboxClusterRoutes } from "./server/routes/api/sandbox-cluster";
export { createApiSandboxServerRoutes } from "./server/routes/api/sandbox-server";
export type { SystemApiSandboxRouteDependencies, WebSandboxRouteDependencies } from "./server/routes/dependencies";
export { createWebSandboxPoolsRoutes } from "./server/routes/web/sandbox-pools";
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
