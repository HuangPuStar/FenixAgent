import type { ModuleManifest } from "@fenix/platform-sdk";

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
 * 声明 `create`（惰性）：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与 agent-runtime
 * 拖进模块图。工厂返回的是**进程级装配结果的入口**（`src/module.ts`）而不是自造实例——真正的组合仍是
 * `src/server/module.ts` 的 `createAgentConfigServerModule(deps)`，由宿主注入授权与身份目录后经
 * `installAgentConfigModule` 装入；理由同 `@fenix/resource-mcp` / `@fenix/resource-skill`。
 *
 * 不声明 `contributions` / `web` / `envDefinitions`：消费方分别是 §1.5 宿主挂载、§1.6 WebShell 装配与
 * §1.7 的宿主 env 登记，形状必须与消费端同时定型。
 */
export const moduleManifest = {
  id: "agent-config",
  kind: "resource",
  dependsOn: ["knowledge", "mcp", "memory", "skill"],
  capabilities: ["resource.agent-config"],
  create: () => import("./src/module").then((module) => module.createAgentConfigModule()),
} satisfies ModuleManifest;
