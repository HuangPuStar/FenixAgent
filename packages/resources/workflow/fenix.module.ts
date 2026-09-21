import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";

/**
 * Workflow 资源模块描述符。
 *
 * 工作流定义 / 版本 / 运行 / 触发的唯一 owner。装配面上的服务端交付物是五组 `/web/workflow-*` 路由
 * （defs、runs、engine action、SSE 事件流、custom-tools）、`/api/workflows/:workflowId/execute`、
 * `/workflow-ui` 静态代理与 Webhook 接收路由 `createHookRoutes`（`/hooks/:publicHash`，另见
 * `handleWebhookRequest`）；消费者是宿主 `apps/server`（`main.ts` 与 `routes/web/index.ts`）。
 *
 * `dependsOn: []`：本包服务端生产代码（`src/**`）没有任何对已注册 `resource` 模块的值导入，是叶子模块。
 * 现有跨包导入都属于「不构成装配依赖」的四类边，故不声明：
 * - `@fenix/agent-runtime/runtime`：`src/server/services/workflow/index.ts:14` 取运行 port 后调
 * `stopInstance` 清理 run 创建的实例、`workflow-events.ts` 经 `session.getEventBus` 取事件总线、
 * `agent-chat-transport.ts` 经 port 做实例启动/心跳/停止（1.4 W6b 前这三处都从 `./server` 取，
 * 观测面与总线归位后不再有装配面取数）。agent-runtime 是
 * 基础类别，在 assembly profile 里是固定槽位（`requireFoundation`），跨类别边由 §2.3 依赖矩阵负责；
 * - `@fenix/workflow-engine` 与 `@fenix/plugin-sdk`（后者在 `agent-chat-transport.ts:26` 仅 `import type`，
 * 编译期擦除）：两者都未注册为模块，写进 `dependsOn` 会被 registry 生成器以「引用了未注册模块」拒绝；
 * - `@fenix/chat-channel`（1.4 W6a 新增，`agent-chat-transport.ts` 取 `extractJsonRpc`）：同属未注册为
 * 模块的基础类别包，理由同上；本包私有 JSON-RPC 副本删除后，帧解析统一由该包协议层提供；
 * - `@server/db/schema`：`src/**` 生产代码只剩这一条宿主内部依赖（表定义，§5 残留，owner 1.7 迁出），
 * 它不构成装配依赖；原先的 `@server/db`、`@server/config`、`@server/plugins/auth` 反向依赖已在本任务
 * 切片内切断（分别改为 `getWorkflowDatabase()`、`getModuleConfig("workflow")`、路由工厂注入守卫）。
 *
 * `create` 指向 `src/module.ts` 的组合根（返回包内既有进程级单例，不新建第二套 engine 缓存）；
 * 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Elysia、Drizzle 与 workflow-engine 拖进模块图。
 *
 * 声明 `contributions`（1.5e）：`/web/workflow-defs`、`-custom-tools`、`-engine`、`-sse`、`-runs` 五条路由
 * 实例由本模块以惰性构造函数 `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web"` 指明
 * 挂宿主 `/web` 聚合面——路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性
 * import 与 `create` 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。五条贡献的声明
 * 序就是挂载序（与迁移前宿主手写序列一致）。
 *
 * 1.5f 追加一条 `api` 槽贡献：`/api/workflows/:workflowId/execute`。`/workflow/*` 静态代理（
 * `createWorkflowStaticApp`）、MCP 与 hooks 入口不走本槽——它们各自带独立前缀与认证口径，挂宿主顶层
 * `app` 槽。
 *
 * 不声明 `web`：消费方是 §1.6 的 WebShell 装配，形状必须与消费端同时定型；`envDefinitions` 与 preflight
 * 收敛在任务 1.7。
 */
export const moduleManifest = {
  id: "workflow",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.workflow"],
  contributions: [
    {
      id: "workflow.web-defs",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowWebDefsRoutes(host)),
    },
    {
      id: "workflow.web-custom-tools",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowWebCustomToolsRoutes(host)),
    },
    {
      id: "workflow.web-engine",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowWebEngineRoutes(host)),
    },
    {
      id: "workflow.web-sse",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowWebSseRoutes(host)),
    },
    {
      id: "workflow.web-runs",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowWebRunsRoutes(host)),
    },
    {
      id: "workflow.api",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowApiRoutes(host)),
    },
  ],
  create: () => import("./src/module").then((module) => module.createWorkflowModule()),
} satisfies ModuleManifest;
