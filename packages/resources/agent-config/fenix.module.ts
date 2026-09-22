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
 * `dependsOn: ["knowledge","mcp","memory","skill"]` 的四条边都由 `src/**` 的值导入证明——被关联资源的
 * 读取一律走各自 owner 的公开出口，本模块只做读写编排，因此这是「成套启用」的真实耦合，而不是可选软依赖。
 * 绑定表本身的归属是另一件事：`agent_config_mcp` 与 `agent_config_skill` 已随 Agent 配置聚合归本包
 * （1.7 B7，表在 `db/schema.ts`、读写在本包 `src/server/repositories/`），它们的读写不再构成对 mcp /
 * skill 包的导入边：
 * - knowledge：`src/server/services/agent-associations.ts` 读写 Agent 的知识库绑定，
 *   `src/server/services/config/agent-config.ts` 取 `resolveAgentKnowledgePolicy` 解析知识库策略，
 *   `src/server/routes/api/agents.ts` 把 `InvalidKnowledgeBindingError` 映射成协议错误；
 * - mcp：`src/server/services/agent-related-resources.ts` 经 `@fenix/resource-mcp/server/config` 取
 *   `findMcpServerLabelsByIds` 做关联 id 的标签投影（关联边自身由本包
 *   `src/server/repositories/agent-config-mcp.ts` 的 `listAgentMcpIds` / `syncAgentMcps` 读写）；
 * - memory：`src/server/services/agent-associations.ts` 的 `isMemoryEnabled` / `setMemoryEnabled` 转发
 *   memory 的 `isAgentMemoryEnabled` / `setEnabled`（记忆开关归 memory）；
 * - skill：`src/server/services/skill-directory.ts` 经 `@fenix/resource-skill/server/runtime` 的
 *   `getSkillServerModule` 取可见 Skill 投影，`src/server/services/meta-agent.ts` 与
 *   `src/server/services/agent-launch-spec/skill-resolution.ts` 用 `@fenix/resource-skill/server/content`
 *   的归档与 frontmatter 解析装载内置 Skill，`src/server/services/agent-related-resources.ts` 另经
 *   `@fenix/resource-skill/server/config` 取 `findSkillLabelsByIds`（关联边自身由本包
 *   `src/server/repositories/agent-config-skill.ts` 的 `listAgentSkillIds` / `syncAgentSkills` 读写）。
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
 * 声明 `contributions`（1.5e）：六条路由的实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot` 指明挂宿主哪一面——路由路径是相对
 * 形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与 `create` 同因：registry 会
 * 被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 一条挂 `web-config`（`/web/config/agents`），四条挂 `web`，一条挂 `api`（`/api/agents`，1.5f），两条挂
 * 顶层 `app`（`/web/site/deploy/:appId/*` 与 `/app-*` 兜底，1.5f-1b）。`/web/sidebar-config` 的工厂不消费
 * host：该端点在登录页也要可用，刻意不声明 `sessionAuth`，故不需要宿主注入守卫。站点代理两条都不走
 * `sessionAuth`——它要区分「未登录」与「已登录但无权限」并分别重定向，改用宿主的 `authenticateRequest`
 * 投影（`SiteRequestIdentity`）。
 *
 * 声明 `web`（§1.6 已定型）：`contribution` 是该包浏览器载荷的惰性**入口说明符字符串**——WebShell 生成器
 * 只对 manifest 做 AST 静态读取、不执行它，所以入口只能是「声明」而不是「推断」，取值必须是字符串字面量。
 * 它**不是**浏览器依赖：`lucide-react` / React 载荷只存在于 `@fenix/agent-config/web/contribution` 导出的值
 * 里，不会沿 registry 进入服务端装配图（server 侧拿到的只有这一条字符串）。
 *
 * `envDefinitions` 的留白保持不变：消费方是 §1.7 的宿主 env 登记，形状必须与消费端同时定型。
 */
export const moduleManifest = {
  id: "agent-config",
  kind: "resource",
  dependsOn: ["knowledge", "mcp", "memory", "skill"],
  capabilities: ["resource.agent-config"],
  web: {
    id: "agent-config",
    contribution: "@fenix/agent-config/web/contribution",
  },
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
    {
      id: "agent-config.api-agents",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentConfigApiRoutes(host)),
    },
    {
      id: "agent-config.app-site-deploy",
      kind: "app-route",
      slot: "app",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentConfigAgentSitesProxyRoutes(host)),
    },
    {
      id: "agent-config.app-site-compat",
      kind: "app-route",
      slot: "app",
      // 兜底路由：通配 `/*` 必须最后注册，否则会遮蔽同槽里后挂的具体路由。`order` 在这里就是「本贡献
      // 必须排在其它贡献之后」的自证（默认 0，取任意正数即可）。
      order: 100,
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentConfigAgentSitesCompatRoutes(host)),
    },
  ],
  create: (context) => import("./src/module").then((module) => module.createAgentConfigModule(context)),
} satisfies ModuleManifest;
