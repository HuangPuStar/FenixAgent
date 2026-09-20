/**
 * Memory 资源包服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server`、`@fenix/agent-config`（记忆开关读写）与 `@fenix/agent-runtime`
 * （启动参数里的记忆插件与开关判定）是合法消费者。路由一律以工厂形式导出，守卫与系统侧写入由宿主
 * 注入（理由见 `./server/routes/dependencies`）。本入口不导出浏览器代码（浏览器面在 `./web`）。
 */

export type { MemoryModuleConfig } from "./server/config";
export { getMemoryConfig } from "./server/config";
export type { MemoryDatabase } from "./server/db";
export { getMemoryDatabase } from "./server/db";
export * from "./server/repositories/agent-memory-config";
export type { WebHindsightRouteDependencies } from "./server/routes/dependencies";
export { createWebHindsightRoutes } from "./server/routes/web/hindsight";
export * from "./server/schemas/hindsight.schema";
export * from "./server/services/agent-memory";
export * from "./server/services/hindsight";
