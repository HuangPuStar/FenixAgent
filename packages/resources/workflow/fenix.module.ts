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
 * 现有跨包导入都属于「不构成装配依赖」的三类边，故不声明：
 * - `@fenix/agent-runtime/runtime`：`src/server/services/workflow/index.ts:14` 取运行 port 后调
 * `stopInstance` 清理 run 创建的实例、`workflow-events.ts` 经 `session.getEventBus` 取事件总线、
 * `agent-chat-transport.ts` 经 port 做实例启动/心跳/停止（1.4 W6b 前这三处都从 `./server` 取，
 * 观测面与总线归位后不再有装配面取数）。agent-runtime 是
 * 基础类别，在 assembly profile 里是固定槽位（`requireFoundation`），跨类别边由 §2.3 依赖矩阵负责；
 * - `@fenix/workflow-engine` 与 `@fenix/plugin-sdk`（后者在 `agent-chat-transport.ts:26` 仅 `import type`，
 * 编译期擦除）：两者都未注册为模块，写进 `dependsOn` 会被 registry 生成器以「引用了未注册模块」拒绝；
 * - `@fenix/chat-channel`（1.4 W6a 新增，`agent-chat-transport.ts` 取 `extractJsonRpc`）：同属未注册为
 * 模块的基础类别包，理由同上；本包私有 JSON-RPC 副本删除后，帧解析统一由该包协议层提供。
 *
 * 原先四类中的第四类（`@server/db/schema` 的宿主表定义）已随任务 1.7 B6（2026-09-22）消失：九张领域表
 * 迁入本包 `db/schema.ts` 后，`src/**` 生产代码对 `@server/**` **零命中**（机器证据是 `apps-boundary
 * @fenix/resource-workflow → @fenix/server-app` 台账条目被 `architecture:check` 的 stale 检测判为过期）。
 * 更早在本任务切片内切断的三条反向依赖仍是同一结论的成因：`@server/db` → `getWorkflowDatabase()`、
 * `@server/config` → `getModuleConfig("workflow")`、`@server/plugins/auth` → 路由工厂注入守卫。
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
 * 1.5f 追加一条 `api` 槽贡献：`/api/workflows/:workflowId/execute`。1.5f-1b 再追加两条顶层 `app` 槽贡献：
 * `/workflow-ui/*` 静态代理（`createWorkflowStaticApp`，会话守卫面但与 `/web` 不同前缀）与
 * `/hooks/:publicHash` Webhook 接收（无认证——`publicHash` 即凭据）。三条 `app` 槽路由各自带独立前缀与
 * 认证口径，因此单列一槽而不是塞进 `/web` 或 `/api`（两条都在本模块声明序末尾）。
 *
 * 声明 `web`（§1.6 已定型）：`contribution` 是该包浏览器载荷的惰性**入口说明符字符串**——WebShell 生成器
 * 只对 manifest 做 AST 静态读取、不执行它，所以入口只能是「声明」而不是「推断」，取值必须是字符串字面量。
 * 它**不是**浏览器依赖：`lucide-react` / React 载荷只存在于 `@fenix/resource-workflow/web/contribution`
 * 导出的值里，不会沿 registry 进入服务端装配图（server 侧拿到的只有这一条字符串）。
 *
 * `envDefinitions` 与 preflight 收敛在任务 1.7。
 */
export const moduleManifest = {
  id: "workflow",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.workflow"],
  web: {
    id: "workflow",
    contribution: "@fenix/resource-workflow/web/contribution",
  },
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
    {
      id: "workflow.app-static",
      kind: "app-route",
      slot: "app",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowStaticAppRoutes(host)),
    },
    {
      id: "workflow.app-hooks",
      kind: "app-route",
      slot: "app",
      // 工厂不消费 host：无认证是 Webhook 端点的协议语义，没有守卫可注入。
      value: () => import("./src/server/assembly").then((assembly) => assembly.createWorkflowHooksAppRoutes()),
    },
  ],
  create: () => import("./src/module").then((module) => module.createWorkflowModule()),
} satisfies ModuleManifest;
