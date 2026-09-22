import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";

/**
 * Memory 资源模块描述符。
 *
 * Hindsight 长期记忆的唯一 owner：记忆可用性判定（系统级 + Agent 级）、Hindsight MCP server 与 bank 的
 * 幂等登记、`agent_memory_config` 的读写（唯一数据访问点），以及 `/web/hindsight/**` 代理路由。
 * 服务端交付物集中在 `@fenix/resource-memory/server`（`src/server.ts`）：判定入口
 * `shouldEnableAgentMemory()`、插件默认参数 `HINDSIGHT_PLUGIN_DEFAULTS`、bank 登记 `ensureHindsightMcpServer()`
 * 与转发出口 `proxyToHindsight()`，路由以工厂导出 `createWebHindsightRoutes({ authGuardPlugin })`
 * （宿主 `apps/server/src/routes/web/index.ts` 挂载，属任务 1.3 §4 的共享文件改动）。
 * 浏览器面在 `@fenix/resource-memory/web`（`web/index.ts`：页面、`hindsightApi`、i18n 资源）。
 *
 * `dependsOn: []`：本包服务端生产代码（`src/**`，排除 `__tests__`）没有任何指向已注册模块的值导入。
 * 唯一的 workspace 导入是 `src/server/services/hindsight.ts` 的 `@fenix/platform-sdk/server`
 * （`getIdentityDirectory().resolveMembershipId()` 解析 Hindsight bank ID，以及
 * `getModuleConfig("memory")` 读取部署配置）——platform-sdk 是跨域契约包、不注册模块，不产生装配边。
 * 本包 `src/**` 对宿主的内部导入自 §1.7 B10 起**归零**（原先那一处是
 * `src/server/repositories/agent-memory-config.ts` 的 `@server/db/schema` 表定义），台账 `apps-boundary`
 * 的条目随之删除。系统托管 MCP server 的写入（`@fenix/resource-mcp` 的系统路径）经
 * `ensureHindsightMcpServer()` 的参数注入，不构成模块边。
 * `db/schema.ts`（§1.7 B10 新增）是唯一的例外面：它按外键目标导入 `@fenix/agent-config/db` 的
 * `agentConfig` 列对象，已写入 `package.json` 的 `dependencies`，但**不进** `dependsOn`——生成器的
 * 装配依赖校验（`assertDependsOnComplete`）只扫 `src/**`，且表定义表达的是「列对象来自谁的迁移链」，
 * 不是运行期耦合（同口径：`@fenix/resource-knowledge` 的 `dependsOn` 也未列 agent-config / identity，
 * agent-config 的 `dependsOn` 也未列 machine / model-management）。
 *
 * 不声明消费者侧的反向边：唯一的入边是
 * `packages/resources/agent-config/src/server/services/agent-associations.ts`（记忆开关读写，由
 * agent-config 的 manifest 声明该边）；启动参数的记忆 env 自任务 1.4 W4b 起也组装在 agent-config
 * （`src/server/services/agent-launch-spec/memory-env.ts`），与前一处同包、同一条已声明的边。
 * `@fenix/agent-runtime` 曾有一条越界入边（旧 `src/services/launch-spec-builder.ts`，台账
 * `agent-runtime-not-to-resources`，owner 1.4），W4b 随「启动前取数搬出」删除该文件后一并消除；
 * 编码成装配依赖会让 profile 同时启用两者时装配循环失败。硬约束还来自生成器的
 * `assertDependsOnDeclared`：`dependsOn` 的每条都必须在 `package.json` 的 `dependencies` 里能找到
 * `workspace:` 区间，而本包的 workspace 依赖只有 `@fenix/platform-sdk`（基础契约）与
 * `@fenix/agent-config`（B10 起的表定义外键目标，非装配依赖），写入任何模块 ID 仍会以「未声明编译依赖」
 * 失败。
 *
 * `create`：惰性组合根（`src/module.ts` 的 `createMemoryModule()`），模块索引层只 import 本文件，
 * 装配期才加载 `./server` 图。
 *
 * 声明 `contributions`（1.5e）：`/web/hindsight` 的路由实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web"` 指明挂宿主 `/web` 聚合面——
 * 路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与 `create`
 * 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 声明 `web`（§1.6 已定型）：`contribution` 是该包浏览器载荷的惰性**入口说明符字符串**——WebShell 生成器
 * 只对 manifest 做 AST 静态读取、不执行它，所以入口只能是「声明」而不是「推断」，取值必须是字符串字面量。
 * 它**不是**浏览器依赖：`lucide-react` / React 载荷只存在于 `@fenix/resource-memory/web/contribution` 导出
 * 的值里，不会沿 registry 进入服务端装配图（server 侧拿到的只有这一条字符串）。
 *
 * 声明 `envDefinitions`（任务 1.7 C 块，路线 A）：只登记 `HINDSIGHT_MCP_URL` 一键——它是本模块**唯一**只由
 * 本模块消费的部署变量，三处消费点（`/web/hindsight/**` 代理的上游基址、系统级记忆可用性判据
 * `isHindsightAvailable()`、Hindsight MCP server 的登记地址）全在本包 `src/server/**`，宿主只负责投影
 * （`apps/server/src/bootstrap/module-configs.ts` 的 `memory: { hindsightMcpUrl: env.HINDSIGHT_MCP_URL }`），
 * 没有第二个读原始 env 的消费者。模块声明与宿主 schema 同名即启动期抛错（`apps/server/src/env-loader.ts` 的
 * `assertNoHostKeyOverride`），因此把本键从宿主 `apps/server/src/env.ts` 的「可选：Hindsight 记忆 MCP」段
 * 删除是这条声明的另一半，两处必须同批。
 *
 * 契约逐字照抄宿主同名行（`z.string().optional()`），因此**省略** `defaultValue`：宿主那一行本就没有默认值，
 * 补 `.default("")` 会让 `loadDeclaredEnv` 从 `schema.parse(rawValue)` 转到 `schema.parse(defaultValue)`
 * 分支，把「未部署记忆」的取值从 `undefined` 改成空串。空串归一（docker-compose 的 `${HINDSIGHT_MCP_URL:-}`
 * 在 .env 未设置时透传空串）是**消费侧**的责任，留在 `src/server/config.ts` 的 `MemoryModuleConfigSchema` 与
 * `src/server/services/hindsight.ts`，声明处不再叠加第二套归一。
 *
 * `secret: false`（值是 MCP 服务地址而非凭据材料：它本就出现在 `/web/hindsight` 的响应体里）、
 * `restartRequired: true`（值在装配期投影进模块配置后即冻结，`getModuleConfig("memory")` 取的是启动期快照，
 * 运行期改环境变量不生效）。两个字段目前没有运行期消费者（`assertDefinitions` 只比较其跨模块一致性），
 * 按声明语义填写供后续 preflight / readiness 消费。
 *
 * 不迁的同族键 `HINDSIGHT_API_TOKEN`：它的唯一运行期消费者是 agent-config——宿主
 * `apps/server/src/bootstrap/host-startup.ts` 在启动期读出后经 launch spec 端口注入 agent 进程，本包只消费
 * 派生结果（`getHindsightConfig().url`）。按「键归唯一模块」的口径由该模块声明，本包不重复：两处声明意味着
 * 同一契约的校验强度与默认值语义要维护两份，而 `assertDefinitions` 只在逐字段完全一致时才放行。
 */
export const moduleManifest = {
  id: "memory",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.memory"],
  envDefinitions: [
    {
      moduleId: "memory",
      key: "HINDSIGHT_MCP_URL",
      // 与宿主 apps/server/src/env.ts 的同名行逐字等价（z.string().optional()）；省略 defaultValue 的理由见文件头。
      schema: z.string().optional(),
      secret: false,
      restartRequired: true,
      description:
        "Hindsight 长期记忆 MCP 服务地址；无默认值——未设置（含 docker-compose 透传的空串）即「记忆能力整体未启用」。" +
        '装配期由宿主投影为 memory 模块配置，本包在启动后经 getModuleConfig("memory") 读取，用于 /web/hindsight ' +
        "代理上游、系统级记忆可用性判据与 Hindsight MCP server 的登记。",
    },
  ],
  web: {
    id: "memory",
    contribution: "@fenix/resource-memory/web/contribution",
  },
  contributions: [
    {
      id: "memory.web",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createMemoryWebRoutes(host)),
    },
  ],
  create: () => import("./src/module").then((module) => module.createMemoryModule()),
} satisfies ModuleManifest;
