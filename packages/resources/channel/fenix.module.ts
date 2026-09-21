import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";

/**
 * Channel 资源模块描述符。
 *
 * IM 通道能力的唯一 owner：通道平台（微信 / 飞书）描述、Hermes 网关连接与消息匹配、通道绑定的领域
 * 规则。装配面上的服务端交付物是 `@fenix/resource-channel/server`——宿主 `apps/server` 用它初始化
 * Hermes 单例（`initHermesClient`）、把 Machine 的 ACP 事件总线绑进本模块（`bindAcpEventBusPort`），
 * 并挂载 `createWebChannelsRoutes({ authGuardPlugin, environmentLookup })` 到 `/web`（守卫与
 * Environment 归属查询由宿主注入，理由见 `src/server/routes/dependencies.ts`）。浏览器面是
 * `@fenix/resource-channel/web`，宿主 §1.6 的 WebShell 装配从那里取页面、API client 与语言资源。
 *
 * `dependsOn: []`：本包是叶子模块，装配上不要求任何其它资源模块同批启用，故此处没有逐条依赖证据。
 * `src/**` 生产代码里唯一跨包的值导入是 `@fenix/agent-runtime/runtime`（`services/hermes-client.ts` 的
 * `getBoundAgentRuntime()`，经它取 `findRunningInstanceByEnvironment` / `session.sendToAgentWs` /
 * `session.sendToInstanceRelay`），属 profile 固定槽位的
 * `agent-runtime` 类别，不是资源模块之间的装配边：生成器的装配依赖校验（`assertDependsOnComplete`）
 * 只对 `resource` 类别之间的值导入做强制，补进 `dependsOn` 反而会把固定槽位编码成可选依赖。
 *
 * 不声明 `dependsOn: ["machine"]`：对 Machine 的运行期依赖走端口注入而非导入——`services/acp-event-bus-port.ts`
 * 只定义 `AcpEventBusPort` 契约，由宿主在装配期 `bindAcpEventBusPort()` 绑定机器侧的事件总线，未绑定时
 * `getAcpEventBusPort()` fail-fast。这条边若写成装配依赖，两个模块必须成套启用，方向与 §2.3「资源不得
 * 反向调用 Runtime 基础设施」冲突；宿主的显式绑定是当前唯一接线路径，不构成第二套装配方式。
 *
 * 声明 `contributions`（1.5e）：`/web/channels` 的路由实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web"` 指明挂宿主 `/web` 聚合面——
 * 路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与 `create`
 * 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 不声明 `web`：字段形状必须与 §1.6 的 WebShell 装配同时定型，单方面发明会返工（实施记录 §四.2）。
 * 包侧已具备 `./web` 出口与浏览器安全守卫，缺的只是 registry 侧的消费方式。
 */
export const moduleManifest = {
  id: "channel",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.channel"],
  contributions: [
    {
      id: "channel.web",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createChannelWebRoutes(host)),
    },
  ],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Elysia、Hermes 客户端与 drizzle 拖进模块图。
  create: () => import("./src/module").then((module) => module.createChannelModule()),
} satisfies ModuleManifest;
