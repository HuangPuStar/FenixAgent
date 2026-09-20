import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Memory 资源模块描述符。
 *
 * Hindsight 长期记忆的唯一 owner：记忆可用性判定（系统级 + Agent 级）、Hindsight MCP server 与 bank 的
 * 幂等登记，以及 `/web/hindsight/**` 代理路由。服务端交付物集中在 `@fenix/resource-memory/server`
 * （`src/server.ts`）：记忆开关 `shouldEnableAgentMemory()` 等判定入口、插件默认参数
 * `HINDSIGHT_PLUGIN_DEFAULTS`、`ensureHindsightMcpServer()`、转发出口 `proxyToHindsight()`，以及
 * default export 的路由实例 `webHindsightRoutes`（宿主 `apps/server/src/routes/web/index.ts` 以
 * `.use(webHindsight)` 挂载）。装配面上的另一类消费者是 `@fenix/agent-config`（读写 Agent 记忆开关）。
 *
 * `dependsOn: []`：本包服务端生产代码（`src/**`，排除 `__tests__`）没有任何指向已注册模块的值导入。
 * 唯一的 workspace 导入是 `src/server/services/hindsight.ts` 的 `@fenix/platform-sdk/server`
 * （`getIdentityDirectory().resolveMembershipId()` 解析 Hindsight bank ID）——platform-sdk 是跨域契约包、
 * 不注册模块，不产生装配边。其余导入全部落在宿主应用内部，均由台账 `apps-boundary` 登记、不是模块边：
 * `src/server/repositories/agent-memory-config.ts` 取 `@server/db` 与 `@server/db/schema`（`agent_memory_config`
 * 表定义，迁出归 §1.7）、`src/server/routes/web/hindsight.ts` 取 `@server/plugins/auth` 与
 * `@server/services/config-utils`、`src/server/services/hindsight.ts` 取 `@server/services/config`。
 *
 * 不声明消费者侧的反向边：本包的两条入边是
 * `packages/resources/agent-config/src/server/services/agent-associations.ts`（记忆开关读写，由
 * agent-config 的 manifest 声明该边）与 `packages/agent-runtime/src/services/launch-spec-builder.ts`
 * （启动参数，台账 `agent-runtime-not-to-resources`，owner 1.4，须消除）。后者属越界边，编码成装配依赖
 * 会让 profile 同时启用两者时装配循环失败。硬约束还来自生成器的 `assertDependsOnDeclared`：`dependsOn`
 * 的每条都必须在 `package.json` 的 `dependencies` 里能找到 `workspace:` 区间，而本包只声明了
 * `@fenix/platform-sdk`，写入任何模块 ID 都会以「未声明编译依赖」失败。
 *
 * 不声明 `create`：模块组合根（`src/module.ts` 的进程级单例）属任务 1.3 W2 切片，当前宿主按显式
 * `.use()` 装配。不声明 `contributions` 与 `web`：消费方分别是 §1.5 的宿主挂载与 §1.6 的 WebShell 装配，
 * 形状必须与消费端同时定型；本包当前也还没有 `web/index.ts` 浏览器出口。
 */
export const moduleManifest = {
  id: "memory",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.memory"],
} satisfies ModuleManifest;
