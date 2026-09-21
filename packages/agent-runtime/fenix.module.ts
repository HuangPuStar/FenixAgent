import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";

/**
 * Agent Runtime 的静态装配描述符。
 *
 * `dependsOn` 为空：Runtime 只允许依赖 platform-sdk、四个基础运行包以及 Machine/Sandbox 的
 * 专用公开运行入口，不依赖 AccessControl、Identity 或任何资源模块。Runtime 接受的是已经
 * 授权的通用启动输入，不解释 actor/role/visibility。
 *
 * 工厂按需加载运行组合根（`src/runtime.ts`），使生成的 registry 保持为轻量 manifest 索引，
 * 不把 Elysia、Drizzle 与 relay 全量拖进任何导入 registry 的位置。
 *
 * `create` 返回收敛后的运行 port（`AgentRuntimeModule.runtime`），不是服务端公开入口的整体
 * 表面（1.4 W3 前的临时形态）：端口的目标是让 registry 驱动的装配能拿到唯一的实例/环境
 * 生命周期入口，而宿主装配面（`./server` 的注入 port、路由工厂）由宿主显式调用。
 *
 * 声明 `contributions`（1.5e）：`/web/control`、`/web/environments`、`/web/instances` 的路由实例由本模块
 * 以惰性构造函数 `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web"` 指明挂宿主
 * `/web` 聚合面——路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。**基础模块
 * 同样参与贡献挂载**：装配的 mount 阶段遍历全部解析出的模块（`orderContributions`），不区分类别。惰性
 * import 与 `create` 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 1.5f 追加两条 `api` 槽贡献：实例接入（`/api/agents/:agentId/instances/connect`）与 OpenAI 兼容对话
 * （`/api/agents/:agentId/v1/chat/completions`）。两者与 `/web` 面共用同一份会话守卫，实例接入另需宿主
 * 请求错误日志（读 `request` 上的 requestId，包内没有来源）。
 */
export const moduleManifest = {
  id: "agent-runtime",
  kind: "agent-runtime",
  dependsOn: [],
  capabilities: ["runtime.agent"],
  contributions: [
    {
      id: "agent-runtime.web-control",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentRuntimeWebControlRoutes(host)),
    },
    {
      id: "agent-runtime.web-environments",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentRuntimeWebEnvironmentsRoutes(host)),
    },
    {
      id: "agent-runtime.web-instances",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentRuntimeWebInstancesRoutes(host)),
    },
    {
      id: "agent-runtime.api-instances",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentRuntimeApiInstanceRoutes(host)),
    },
    {
      id: "agent-runtime.api-openai-chat",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createAgentRuntimeOpenaiChatRoutes(host)),
    },
  ],
  create: () => import("./src/runtime").then((module) => module.createAgentRuntimeModule()),
} satisfies ModuleManifest;
