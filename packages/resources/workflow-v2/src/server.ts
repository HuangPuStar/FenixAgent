/**
 * Workflow V2 资源包的服务端公开入口。
 *
 * 全部导出都是**具名**的（没有 default export）：宿主按需求组装，模块注册表按 `./module` 取组合根，
 * 三条消费路径互不干扰。
 *
 * 路由以工厂形式导出并要求宿主注入会话守卫（`WorkflowV2RouteDependencies`）：Elysia 的 `macro` / `state`
 * 是实例作用域的，父实例无法向已构造的子实例回填，守卫必须与宿主的认证解析是同一份实例。`web` 与 `api`
 * 两个槽的路由都消费它；两条 `app` 槽路由（画布透传面、画布静态反代）不带守卫，凭据是请求头票据与同源
 * iframe 身份（冻结 §2.1）。
 *
 * 服务函数（`callUpstream` / `getUpstreamSession` / 票据签发 / 注册表）不在本入口导出：它们是冻结 §4 的**包内**
 * 跨任务契约，消费方是包内的路由与 Facade，包外没有任何调用者——提前铺开会让内部实现细节固化成公共契约。
 * 测试与后续任务经包内相对路径取用，模块级入口只留「宿主真的要用」的那几个。
 */

export type { WorkflowV2Config, WorkflowV2ModuleConfigInput } from "./server/config";
export { getWorkflowV2Config } from "./server/config";
export { createWorkflowV2ServerModule, type WorkflowV2ServerModule } from "./server/module";
export { createApiWorkflowV2Routes } from "./server/routes/api/workflows";
export { createCanvasBffRoutes } from "./server/routes/canvas/bff";
export { createCanvasStaticRoutes } from "./server/routes/canvas/static-proxy";
export type { WorkflowV2ActorContext, WorkflowV2RouteDependencies } from "./server/routes/dependencies";
export { createWebWorkflowV2Routes } from "./server/routes/web";
