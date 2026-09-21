import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { agentConfigResource } from "./src/server/access/agent-config-resource";

/**
 * AgentConfig 资源模块描述符。
 *
 * Agent 配置（`agent_config`）的资源行、授权入口、关联绑定（Skill / MCP / 知识库 / 记忆）与站点应用
 * （`agent_site_app`）的唯一 owner。装配面上的消费者是宿主 `apps/server`（装配授权与身份目录后挂载
 * `/web/config/agents`、`/web/agent-sites`、`/web/sidebar-config`、`/api/agents` 与站点代理
 * `/web/site/deploy`，并注入 `AgentConfigServerModule`）以及其它资源模块（machine 解析 AgentNode、
 * model-management 与 observer 读取 Agent 配置）。
 *
 * `dependsOn: ["knowledge","mcp","memory","skill"]` 的四条边都由 `src/**` 的值导入证明——绑定表分散在
 * 各自资源包，本模块只做读写编排，因此这是「成套启用」的真实耦合，而不是可选软依赖：
 * - knowledge：`src/server/services/agent-associations.ts` 读写 Agent 的知识库绑定，
 *   `src/server/services/config/agent-config.ts` 取 `resolveAgentKnowledgePolicy` 解析知识库策略，
 *   `src/server/routes/api/agents.ts` 把 `InvalidKnowledgeBindingError` 映射成协议错误；
 * - mcp：`src/server/services/agent-associations.ts` 的 `listAgentMcpIds` / `syncAgentMcps`；
 * - memory：同文件的 `isAgentMemoryEnabled` / `setAgentMemoryEnabled`（记忆开关归 memory）；
 * - skill：同文件的 `listAgentSkillIds` / `syncAgentSkills`，`src/server/services/skill-directory.ts`
 *   经 Skill Facade 取可见 Skill 投影，`src/server/services/meta-agent.ts` 用 Skill 归档与 frontmatter
 *   解析装载内置 Skill。
 *
 * 不声明其它反向边：machine、model-management、observer 各自导入 `@fenix/agent-config/server`，方向固定为
 * 它们 → 本模块，写进本模块会反转装配方向并成环；`sandbox` 同样不声明——`use-agent-editor.ts` 导入的是
 * `@fenix/resource-sandbox/web`，浏览器贡献不进入服务端装配顺序（反向校验只扫 `src/**` 的值导入）。
 *
 * 声明 `accessControlBindings`：`agentConfigResource.storage` 是本模块主表（`agent_config`）的归属列
 * 声明，由 `access-control` 的工厂经 `ModuleFactoryContext.declarations` 汇总。静态导入资源注册文件是
 * 有意的取舍——绑定是值而不是类型，只能来自静态导出；本模块**不得**为这条边把 `access-control` 写进
 * `dependsOn`，否则授权模块与资源模块会互相等待（理由与加载代价见 `@fenix/resource-mcp` 的同类说明）。
 *
 * 声明 `create`（惰性）：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与 agent-runtime
 * 拖进模块图。工厂产出 `src/server/module.ts` 的 `createAgentConfigServerModule(deps)` 构造的真实例并
 * 装入进程级槽位，依赖取自 registry 的装配声明——详见 `src/module.ts`。
 *
 * 声明 `contributions`（1.5e）：五条路由的实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot` 指明挂宿主哪一面——路由路径是相对
 * 形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与 `create` 同因：registry 会
 * 被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 一条挂 `web-config`（`/web/config/agents`），四条挂 `web`。`/web/sidebar-config` 的工厂不消费 host：
 * 该端点在登录页也要可用，刻意不声明 `sessionAuth`，故不需要宿主注入守卫。
 *
 * 不声明 `web` / `envDefinitions`：消费方分别是 §1.6 WebShell 装配与 §1.7 的宿主 env 登记，形状必须与
 * 消费端同时定型。
 */
export const moduleManifest = {
  id: "agent-config",
  kind: "resource",
  dependsOn: ["knowledge", "mcp", "memory", "skill"],
  capabilities: ["resource.agent-config"],
  accessControlBindings: [agentConfigResource.storage],
  contributions: [
    {
      id: "agent-config.web-config-agents",
      kind: "app-route",
      slot: "web-config",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentConfigWebConfigRoutes(host)),
    },
    {
      id: "agent-config.web-sidebar-config",
      kind: "app-route",
      slot: "web",
      value: () =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentConfigWebSidebarConfigRoutes()),
    },
    {
      id: "agent-config.web-agent-sites",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentConfigWebAgentSitesRoutes(host)),
    },
    {
      id: "agent-config.web-agent-generation",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentConfigWebAgentGenerationRoutes(host)),
    },
    {
      id: "agent-config.web-meta-agent",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentConfigWebMetaAgentRoutes(host)),
    },
  ],
  create: (context) => import("./src/module").then((module) => module.createAgentConfigModule(context)),
} satisfies ModuleManifest;
