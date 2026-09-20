/**
 * ProdView 资源包服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server` 是当前唯一的服务端消费者。路由一律以工厂形式导出，守卫由宿主
 * 注入（理由见 `./server/routes/dependencies`）。本入口不导出浏览器代码，也不导出 DB 句柄
 * （`./server/db` 的 `getProdViewDatabase` 只服务包内仓储）。
 */

export * from "./server/repositories/prod-view";
export type { WebProdViewRouteDependencies } from "./server/routes/dependencies";
export { createWebConfigProdViewsRoutes } from "./server/routes/web/config/prod-views";
export { createWebProdViewsRoutes } from "./server/routes/web/prod-views";
export * from "./server/schemas/prod-view.schema";
export * from "./server/services/prod-view";
