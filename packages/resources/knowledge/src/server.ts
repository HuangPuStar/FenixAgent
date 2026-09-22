/**
 * Knowledge 资源包服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server`（挂载两条路由、启动期 `checkRagFlowHealth()`）、`@fenix/resource-mcp`、
 * `@fenix/agent-config`（绑定校验与知识策略）与 `@fenix/agent-runtime`（运行时检索）是合法消费者。
 * 路由一律以工厂形式导出，守卫由宿主注入（理由见 `./server/routes/dependencies`）；配置与 DB 句柄经
 * 本入口的读取函数取得（`getKnowledgeConfig()` / `getKnowledgeDatabase()`），不再暴露宿主单例。
 *
 * 本入口不导出浏览器代码（浏览器面在 `./web`）。三张领域表（`knowledge_base` / `knowledge_resource` /
 * `agent_knowledge_binding`）的定义自任务 1.7 B9 起由本包持有（`@fenix/resource-knowledge/db`），因此
 * 本包对宿主 `@server/**` 已零引用。跨包取知识库展示字段的消费方走 `./server/summaries` 窄出口。
 */

export type { KnowledgeModuleConfig } from "./server/config";
export { getKnowledgeConfig } from "./server/config";
export type { KnowledgeDatabase } from "./server/db";
export { getKnowledgeDatabase } from "./server/db";
export * from "./server/repositories/knowledge-base";
export { createApiKnowledgeBaseRoutes } from "./server/routes/api/knowledge-bases";
export type { KnowledgeRouteDependencies, SessionAuthContext } from "./server/routes/dependencies";
export { createWebKnowledgeBaseRoutes } from "./server/routes/web/knowledge-bases";
export * from "./server/services/agent-knowledge";
export * from "./server/services/knowledge-base";
export { checkRagFlowHealth } from "./server/services/knowledge-provider/ragflow";
export * from "./server/services/knowledge-runtime";
