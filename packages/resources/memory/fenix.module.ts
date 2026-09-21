import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";

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
 * 其余导入全部落在宿主应用内部，均由台账 `apps-boundary` 登记、不是模块边：仅
 * `src/server/repositories/agent-memory-config.ts` 的 `@server/db/schema`（`agent_memory_config`
 * 表定义，迁出归 §1.7）一处。系统托管 MCP server 的写入（`@fenix/resource-mcp` 的系统路径）经
 * `ensureHindsightMcpServer()` 的参数注入，不构成模块边。
 *
 * 不声明消费者侧的反向边：唯一的入边是
 * `packages/resources/agent-config/src/server/services/agent-associations.ts`（记忆开关读写，由
 * agent-config 的 manifest 声明该边）；启动参数的记忆 env 自任务 1.4 W4b 起也组装在 agent-config
 * （`src/server/services/agent-launch-spec/memory-env.ts`），与前一处同包、同一条已声明的边。
 * `@fenix/agent-runtime` 曾有一条越界入边（旧 `src/services/launch-spec-builder.ts`，台账
 * `agent-runtime-not-to-resources`，owner 1.4），W4b 随「启动前取数搬出」删除该文件后一并消除；
 * 编码成装配依赖会让 profile 同时启用两者时装配循环失败。硬约束还来自生成器的
 * `assertDependsOnDeclared`：`dependsOn` 的每条都必须在 `package.json` 的 `dependencies` 里能找到
 * `workspace:` 区间，而本包只声明了 `@fenix/platform-sdk`，写入任何模块 ID 都会以「未声明编译依赖」失败。
 *
 * `create`：惰性组合根（`src/module.ts` 的 `createMemoryModule()`），模块索引层只 import 本文件，
 * 装配期才加载 `./server` 图。
 *
 * 声明 `contributions`（1.5e）：`/web/hindsight` 的路由实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web"` 指明挂宿主 `/web` 聚合面——
 * 路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与 `create`
 * 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 不声明 `web`：消费方是 §1.6 的 WebShell 装配，形状必须与消费端同时定型。
 */
export const moduleManifest = {
  id: "memory",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.memory"],
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
