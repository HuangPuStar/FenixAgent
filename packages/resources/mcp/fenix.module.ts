import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { mcpServerResource } from "./src/server/access/mcp-server-resource";

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
 * 声明 `accessControlBindings`：`mcpServerResource.storage` 是本模块主表（`mcp_server`）的归属列声明，
 * 由 `access-control` 的工厂经 `ModuleFactoryContext.declarations` 汇总。这里静态导入资源注册文件是
 * 有意的取舍：绑定是值而不是类型，只能来自静态导出；代价是 registry 的加载图多了本包的资源注册
 * （含 `@server/db/schema` 的表定义），而消费 registry 的入口只有服务端的装配入口与宿主用例。
 * 本模块**不得**为这条边把 `access-control` 写进 `dependsOn`：授权模块要等声明齐全才能构造。
 *
 * 声明 `create`：指向 `src/module.ts` 的 `createMcpModule(context)`，由 registry 注入装配声明并装入
 * 组合根产出的实例。工厂保持惰性——registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与
 * MCP SDK 拖进模块图；构造仍由 `src/server/module.ts` 唯一实现。
 *
 * 声明 `contributions`（1.5e）：`/web/config/mcp` 的路由实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web-config"` 指明挂宿主 `/web/config`
 * 聚合面——路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与
 * `create` 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 不声明 `web` / `envDefinitions`：消费方分别是 §1.6 的 WebShell 装配与 §1.7 的宿主 env 登记；本包不读
 * `process.env`、没有独立部署级变量。
 */
export const moduleManifest = {
  id: "mcp",
  kind: "resource",
  dependsOn: ["knowledge"],
  capabilities: ["resource.mcp"],
  accessControlBindings: [mcpServerResource.storage],
  contributions: [
    {
      id: "mcp.web-config",
      kind: "app-route",
      slot: "web-config",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createMcpWebConfigRoutes(host)),
    },
  ],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与 MCP SDK 拖进模块图。
  create: (context) => import("./src/module").then((module) => module.createMcpModule(context)),
} satisfies ModuleManifest;
