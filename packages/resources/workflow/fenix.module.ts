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
 * 现有跨包导入都属于「不构成装配依赖」的三类边，故不声明：
 * - `@fenix/agent-runtime/server`：`src/server/services/workflow/index.ts:14` 导入 `stopInstance`
 * 清理 run 创建的实例、`src/server/services/workflow/workflow-events.ts:8` 导入事件总线、
 * `src/server/services/workflow/agent-chat-transport.ts:24` 导入实例启动/心跳/停止。agent-runtime 是
 * 基础类别，在 assembly profile 里是固定槽位（`requireFoundation`），跨类别边由 §2.3 依赖矩阵负责；
 * - `@fenix/workflow-engine` 与 `@fenix/plugin-sdk`（后者在 `agent-chat-transport.ts:26` 仅 `import type`，
 * 编译期擦除）：两者都未注册为模块，写进 `dependsOn` 会被 registry 生成器以「引用了未注册模块」拒绝；
 * - `@server/**`：`src/server/repositories/workflow-def.ts:8` 取 `db`、`src/server/routes/web/workflow-defs.ts:32`
 * 取 `authGuardPlugin` 等宿主内部反向依赖，已由架构台账登记为 `apps-boundary`（owner 1.5）。这类边必须
 * 消除，不能编码成装配依赖——否则两个模块在 profile 里成套启用时装配顺序会因循环失败。
 *
 * 不声明 `create`：`getTeamEngine()` 的进程级单例（按 organizationId 缓存 engine + transport）尚未收敛为
 * 模块组合根 `src/module.ts`，工厂入口由 W2 切片落地。不声明 `contributions` / `web` / `envDefinitions`：
 * 前两者的消费方分别是 §1.5 宿主挂载与 §1.6 WebShell 装配，形状必须与消费端同时定型，单方面发明会返工；
 * `envDefinitions` 与 preflight 收敛在任务 1.7。
 */
export const moduleManifest = {
  id: "workflow",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.workflow"],
} satisfies ModuleManifest;
