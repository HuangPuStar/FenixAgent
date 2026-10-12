/**
 * Trace 观测资源包的服务端公开入口。
 *
 * 交付物形状：`/web/agents/:environmentId/sessions/:sessionId/traces*` 三个只读接口的路由装配面（守卫与环境
 * 归属由宿主注入，理由见 `./server/routes/dependencies`），以及部署配置读取与只读薄客户端。
 *
 * 测试 seam（`setTraceReadServiceForTests`）留在路由模块文件上，不进本入口——它不是公共契约，包内用例按相对
 * 路径直接引用模块。浏览器能力走 `./web`。
 */

export type { TraceModule } from "./module";
export { createTraceModule } from "./module";
export { createTraceWebRoutes } from "./server/assembly";
export type { LangfuseConnection, TraceModuleConfig } from "./server/config";
export { getTraceConfig, resolveLangfuseConnection } from "./server/config";
export type { WebTraceRouteDependencies } from "./server/routes/dependencies";
export * from "./server/schemas/traces";
export type {
  LangfuseClient,
  LangfuseCursorPage,
  LangfuseFailureKind,
  LangfuseObservationListParams,
  LangfuseTraceListParams,
  LangfuseTracePage,
} from "./server/services/langfuse-client";
export { createLangfuseClient, LangfuseReadError } from "./server/services/langfuse-client";
export type { TraceReadPorts, TraceReadService } from "./server/services/trace-read";
export { createTraceReadService } from "./server/services/trace-read";
export type { TraceSessionLookup } from "./server/services/trace-session";
export { traceSessionLookup } from "./server/services/trace-session";
