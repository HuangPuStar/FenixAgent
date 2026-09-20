/**
 * Observer 资源包服务端公开入口。
 *
 * 交付物形状：三个 `/api/system/*` 只读接口的路由工厂（守卫由宿主注入，理由见
 * `./server/routes/dependencies`）、观察面领域实现、人员树与日志服务。本入口不导出浏览器代码，
 * 浏览器能力走 `./web`。测试用 seam（`setSystemLogServiceForTests` 等）留在路由模块文件上，
 * 不进本入口——它们不是公共契约，包内用例按相对路径直接引用模块。
 */

export type { ObserverModule } from "./module";
export { createObserverModule } from "./module";
export { createApiSystemLogsRoutes } from "./server/routes/api/system-logs";
export { createApiSystemObserverRoutes } from "./server/routes/api/system-observer";
export { createApiSystemPeopleTreeRoutes } from "./server/routes/api/system-people-tree";
export type { SystemApiObserverRouteDependencies } from "./server/routes/dependencies";
export * from "./server/schemas/api-system-logs.schema";
export * from "./server/schemas/api-system-observer.schema";
export * from "./server/schemas/api-system-people-tree.schema";
export * from "./server/services/observer";
export * from "./server/services/system-log-service";
export * from "./server/services/system-people-tree-service";
