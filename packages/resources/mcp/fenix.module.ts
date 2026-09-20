import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * MCP 资源模块描述符。
 *
 * 受控 MCP Server 资源（增删改查、启停、远程检测、tool 缓存与 Agent 绑定）的唯一 owner。装配面上的
 * 服务端交付物是 `@fenix/resource-mcp/server`：资源注册 `mcpServerResource`、唯一应用入口
 * `McpServerFacade`、组合根 `createMcpServerServerModule`，以及 `/web/config/mcp`、`/api/mcp` 与
 * 内部协议入口 `/mcp/knowledge`。宿主的系统初始化路径经 `./server/runtime` 的
 * `installMcpServerModule` / `getMcpServerModule` 读写同一份装配结果，不另开一条接线。
 *
 * `dependsOn: ["knowledge"]`：`src/server/routes/mcp/knowledge.ts` 值导入
 * `@fenix/resource-knowledge/server` 的 `searchKnowledgeDetailedForAgent` /
 * `readKnowledgeResourceForAgent` / `getKnowledgeGraphForAgent`，把 Agent 已绑定的知识库能力暴露成
 * `kb_search` / `kb_read` / `kb_graph_get` 三个 MCP tools；`package.json` 已声明
 * `"@fenix/resource-knowledge": "workspace:*"`。方向是资源包 → 对方根入口公开的 service，与 §2.3
 * 依赖矩阵一致。这条边不可降级为可选：知识库能力缺席时该协议入口只剩鉴权壳。
 *
 * 不声明 `agent-runtime`：知识库路由还值导入 `@fenix/agent-runtime/runtime` 的 `getBoundAgentRuntime()`
 * （经 `getEnvironmentBySecret` 用 Bearer token 解析调用方 environment），但 agent-runtime 是 profile 的
 * 固定基础槽位——`createModuleRegistry` 的 `requireFoundation` 恒启用它并强制其提供工厂——跨类别
 * 方向由 §2.3 矩阵与架构台账管理，不是资源包之间需要成套启用的装配边。
 * `@fenix/platform-sdk` / `@fenix/logger` 是稳定契约与日志基础设施而非模块，同样不进 `dependsOn`。
 * 反向边不存在：knowledge 的服务端代码不导入本包，这条边是单边的，不构成装配环；knowledge 注册后
 * 生成器的 `assertDependsOnComplete` 会接管「值导入了已注册资源模块就必须声明」这半边的持续校验。
 *
 * 声明 `create`：指向 `src/module.ts` 的组合根 `createMcpModule()`（W2 落地）。工厂保持惰性——
 * registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与 MCP SDK 拖进模块图；组合根本身
 * 需要平台注入（授权、查询端口、身份目录），因此它只补 `id` 并把装配生命周期转出，构造仍由
 * `src/server/module.ts` 唯一实现（理由见 `src/module.ts`）。
 *
 * 不声明 `contributions` / `web` / `envDefinitions`：`contributions` 与 `web` 的消费方分别是
 * §1.5 的宿主挂载与 §1.6 的 WebShell 装配，形状必须与消费端同时定型；本包不读 `process.env`、
 * 没有独立部署级变量，`envDefinitions` 归 §1.7 的 env 收敛。
 */
export const moduleManifest = {
  id: "mcp",
  kind: "resource",
  dependsOn: ["knowledge"],
  capabilities: ["resource.mcp"],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与 MCP SDK 拖进模块图。
  create: () => import("./src/module").then((module) => module.createMcpModule()),
} satisfies ModuleManifest;
