import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Workflow 资源模块描述符。
 *
 * 工作流定义 / 版本 / 运行 / 触发的唯一 owner。装配面上的服务端交付物是五组 `/web/workflow-*` 路由
 * （defs、runs、engine action、SSE 事件流、custom-tools）、`/api/workflows/:workflowId/execute`、
 * `/workflow-ui` 静态代理与 Webhook 处理函数 `handleWebhookRequest`；消费者是宿主 `apps/server`
 * （`main.ts` 与 `routes/web/index.ts`、`routes/hooks.ts`）。
 *
 * `dependsOn: []`：本包服务端生产代码（`src/**`）没有任何对已注册 `resource` 模块的值导入，是叶子模块。
 * 现有跨包导入都属于「不构成装配依赖」的四类边，故不声明：
 * - `@fenix/agent-runtime/server`：`src/server/services/workflow/index.ts:14` 导入 `stopInstance`
 * 清理 run 创建的实例、`src/server/services/workflow/workflow-events.ts:8` 导入事件总线、
 * `src/server/services/workflow/agent-chat-transport.ts:24` 导入实例启动/心跳/停止。agent-runtime 是
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
 * 不声明 `contributions` / `web` / `envDefinitions`：前两者的消费方分别是 §1.5 宿主挂载与 §1.6 WebShell
 * 装配，形状必须与消费端同时定型，单方面发明会返工；`envDefinitions` 与 preflight 收敛在任务 1.7。
 */
export const moduleManifest = {
  id: "workflow",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.workflow"],
  create: () => import("./src/module").then((module) => module.createWorkflowModule()),
} satisfies ModuleManifest;
