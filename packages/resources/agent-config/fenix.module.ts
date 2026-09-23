import { DEFAULT_AGENT_SYSTEM_PROMPT } from "@fenix/agent-config/server/system-prompt";
import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";
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
 *   `getSkillServerModule` 取可见 Skill 投影，`src/server/services/builtin-skills.ts` 与
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
 * `envDefinitions`（1.7 C 块，路线 A 窄口径）承载本模块独有的部署变量。声明只承担「启动期校验 + 汇总」：
 * 值仍由宿主 `apps/server/src/bootstrap/module-configs.ts` 手工投影成模块配置，本包继续经
 * `getAgentConfigConfig()` 读取，config 形态与读取路径都不变。因此「本模块声明某键」与「宿主
 * `apps/server/src/env.ts` 删除该键」必须同批——同名两处声明会被宿主 env-loader 的
 * `assertNoHostKeyOverride` 在启动期直接拒绝，不存在「先声明、后删宿主」的过渡态。
 *
 * 归属判据是「唯一运行期消费者在本包」，逐键的落点与证据：
 * - `RCS_AGENT_SYSTEM_PROMPT`：默认值就是本包导出的 `DEFAULT_AGENT_SYSTEM_PROMPT`，迁入后默认值自然留在
 *   owner 包内；消费链是宿主 `@server/config` 的 `agentSystemPrompt` → `services/pre-launch-ports.ts` →
 *   本包 launch-spec 组装器（`services/agent-launch-spec/assembler.ts`）。默认值直接引用同一常量而不是
 *   复制字面量，避免两处默认值漂移。
 * - `HINDSIGHT_API_TOKEN`：运行期唯一消费者是本包 launch-spec 组装器的
 *   `services/agent-launch-spec/memory-env.ts`（把 token 注入 ccb 引擎的 `HINDSIGHT_API_TOKEN`），宿主经
 *   `services/pre-launch-ports.ts` 以「启动前取数端口」注入而非模块配置——密钥不随地址走。**同族的
 *   `HINDSIGHT_MCP_URL` 不归本包**：它是 memory 模块的领域配置（`getHindsightConfig()` 读的是 memory 的
 *   模块配置），地址的 owner 是 memory，由 memory 的 manifest 声明；本包与宿主都只是该地址的消费者。
 * - `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL`：观测透传三键，与 `HINDSIGHT_API_TOKEN`
 *   是**同一个** assembler `env` 参数的字段（宿主 `services/pre-launch-ports.ts` 的
 *   `env.langfuse.{publicKey,secretKey,baseUrl}`，派生自 `config.ts` 的 `langfuse*` 字段），唯一运行期消费者是
 *   本包 launch-spec 组装器的 `services/agent-launch-spec/memory-env.ts` `buildLangfuseEnv()`。宿主 `env.ts`
 *   的声明旁注释已写明「主服务声明后由 `@fenix/agent-config` 的 `agent-launch-spec` 经 launchSpec.env 透传」，
 *   故 owner 是本包。`LANGFUSE_USER_ID` **不在此列**：它是按实例注入的动态 user 维度，由 assembler 经
 *   `platformEnv` 生成，不是部署变量。
 * - `APP_HIDDEN_SIDEBAR_TABS` / `AGENT_SITES_BASE_URL` / `AGENT_SITES_MASTER_KEY` / `OPENAI_MODEL`：消费者
 *   都是本包自身的服务（侧边栏配置 / 站点代理 / 智能生成），全仓无第二个读取者。
 * - `OPENAI_API_KEY` 与 `OPENAI_BASE_URL` 是**补齐**：宿主 `env.ts` 从未声明这两键（只有一行注释说明它们
 *   由 OpenAI SDK 直读），而 `module-configs.ts` 一直以 `env.OPENAI_API_KEY` 作为「是否下发
 *   `agentGenerationModel`」的门控——该键不在任何声明里，门控恒为 falsy，智能生成因此实际不可用。本声明
 *   修好这条读取面（门控只在 Key 存在时下发模型名，Key 本身仍由 OpenAI SDK 从运行环境直读）；
 *   `OPENAI_BASE_URL` 则只为把该端点纳入启动期校验与部署文档面，值同样由 SDK 直读，本包既不投影也不消费它。
 *
 * 默认值语义照抄宿主形状，不「顺手归一」：`APP_HIDDEN_SIDEBAR_TABS` 与 `RCS_AGENT_SYSTEM_PROMPT` 在宿主有
 * 默认值，故写 `defaultValue`；其余键宿主是 `optional()` 无默认值，**省略 `defaultValue` 字段**（写 `null`
 * 会让 `loadDeclaredEnv` 走 `schema.parse(null)` 而不是 `schema.parse(undefined)`，默认值语义漂移）。
 * `AGENT_SITES_BASE_URL` 保留空串形状，不做 `"" → undefined` 归一：与宿主 `env.ts` 的 `optional()` 逐字等价，
 * 归一会把「宿主显式给了空串」与「宿主没给」在声明面抹平。`secret` 只标真正的密钥材料
 * （`AGENT_SITES_MASTER_KEY` / `HINDSIGHT_API_TOKEN` / `OPENAI_API_KEY` / `LANGFUSE_SECRET_KEY`）；
 * `restartRequired` 一律为 true——路线 A 下这些值都在启动期投影进模块配置或 launch-spec `env` 参数，
 * 改动不经热重载生效。
 */
export const moduleManifest = {
  id: "agent-config",
  kind: "resource",
  dependsOn: ["knowledge", "mcp", "memory", "skill"],
  capabilities: ["resource.agent-config"],
  // 本模块独有的部署变量；归属判据、默认值语义与不迁的兄弟键见上方 `envDefinitions` 说明。
  envDefinitions: [
    {
      moduleId: "agent-config",
      key: "APP_HIDDEN_SIDEBAR_TABS",
      schema: z.string().default(""),
      defaultValue: "",
      secret: false,
      restartRequired: true,
      description:
        "控制台侧边栏需要隐藏的 tab id 原始列表（逗号分隔，允许空串）。缺省空串＝不隐藏任何 tab；切分、trim 与去重的规则归本包 src/server/services/sidebar-config.ts，宿主只把已校验的原始字符串原样投影为模块配置，/web/sidebar-config 请求时读取。",
    },
    {
      moduleId: "agent-config",
      key: "AGENT_SITES_BASE_URL",
      schema: z.string().optional(),
      secret: false,
      restartRequired: true,
      description:
        "Agent Sites 平台基址（宿主 AGENT_SITES_BASE_URL）。未配置即 undefined，本包的站点链路按「未配置」快速失败；宿主投影为模块配置 agentSitesBaseUrl，站点代理每次请求时读取。刻意保留空串形状、不做归一。",
    },
    {
      moduleId: "agent-config",
      key: "AGENT_SITES_MASTER_KEY",
      schema: z.string().optional(),
      secret: true,
      restartRequired: true,
      description:
        "Agent Sites 的 master key（宿主 AGENT_SITES_MASTER_KEY）。只在服务端使用，不得返回浏览器、不得写入日志或错误文案；宿主投影为模块配置 agentSitesMasterKey，站点代理每次请求时读取，未配置即快速失败。",
    },
    {
      moduleId: "agent-config",
      key: "OPENAI_MODEL",
      schema: z.string().optional(),
      secret: false,
      restartRequired: true,
      description:
        "Agent 智能生成使用的模型名（宿主 OPENAI_MODEL）。宿主仅在 API Key 可用时把它投影为模块配置 agentGenerationModel，本包以「模型名是否存在」表达「生成功能是否已启用」（isGenerationConfigured()），因此未配置或 Key 缺失都表现为未启用。",
    },
    {
      moduleId: "agent-config",
      key: "OPENAI_API_KEY",
      schema: z.string().optional(),
      secret: true,
      restartRequired: true,
      description:
        "Agent 智能生成使用的 OpenAI 兼容 API Key（密钥：不得进入日志、响应或错误文案）。宿主 env schema 原先从未声明该键，而 module-configs.ts 一直以它为「是否下发模型名」的门控，本声明补齐该读取面；值同时由 OpenAI SDK 从运行环境直读，本包不投影、不落模块配置。",
    },
    {
      moduleId: "agent-config",
      key: "OPENAI_BASE_URL",
      schema: z.string().optional(),
      secret: false,
      restartRequired: true,
      description:
        "OpenAI 兼容端点的基址（宿主 OPENAI_BASE_URL）。声明只为把该端点纳入启动期校验与部署文档面：值仍由 OpenAI SDK 从运行环境直读，本包既不投影进模块配置也不消费它。",
    },
    {
      moduleId: "agent-config",
      key: "HINDSIGHT_API_TOKEN",
      schema: z.string().optional(),
      secret: true,
      restartRequired: true,
      description:
        "Hindsight 记忆 MCP 的 API token（密钥：不得进入日志、响应或错误文案）。运行期唯一消费者是本包 launch-spec 组装器的 memory-env.ts（注入 ccb 引擎的 HINDSIGHT_API_TOKEN），宿主经 services/pre-launch-ports.ts 的启动前取数端口注入而非模块配置；未配置时不注入该变量。同族的 HINDSIGHT_MCP_URL 归 memory 模块。",
    },
    {
      moduleId: "agent-config",
      key: "LANGFUSE_PUBLIC_KEY",
      schema: z.string().optional(),
      secret: false,
      restartRequired: true,
      description:
        "Langfuse 观测的 public key。由本包 launch-spec 组装器的 buildLangfuseEnv() 经 launchSpec.env 透传到 machine 上 agent 进程（peri 的 langfuse-client 直读同名变量）；未配置则不注入，extraEnv 同名变量仍优先。",
    },
    {
      moduleId: "agent-config",
      key: "LANGFUSE_SECRET_KEY",
      schema: z.string().optional(),
      secret: true,
      restartRequired: true,
      description:
        "Langfuse 观测的 secret key（密钥：不得进入日志、响应或错误文案，仅随受信 relay 通道传输）。透传路径同 LANGFUSE_PUBLIC_KEY；未配置则不注入。",
    },
    {
      moduleId: "agent-config",
      key: "LANGFUSE_BASE_URL",
      schema: z.string().optional(),
      secret: false,
      restartRequired: true,
      description:
        "自托管 Langfuse 的基址。透传路径同 LANGFUSE_PUBLIC_KEY；未配置则不注入，此时 peri 侧走其默认 SaaS 端点。",
    },
    {
      moduleId: "agent-config",
      key: "RCS_AGENT_SYSTEM_PROMPT",
      schema: z.string().min(1).default(DEFAULT_AGENT_SYSTEM_PROMPT),
      defaultValue: DEFAULT_AGENT_SYSTEM_PROMPT,
      secret: false,
      restartRequired: true,
      description:
        "下发到 Agent 运行时的系统提示词模板，默认值取自本包导出的 DEFAULT_AGENT_SYSTEM_PROMPT；min(1) 使空串视为配置错误。宿主经 @server/config 的 agentSystemPrompt → services/pre-launch-ports.ts 投影到本包 launch-spec 组装器，每次组装启动参数时读取。",
    },
  ],
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
