import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Channel 资源模块描述符。
 *
 * IM 通道能力的唯一 owner：通道平台（微信 / 飞书）描述、Hermes 网关连接与消息匹配、通道绑定的领域
 * 规则。装配面上的服务端交付物是 `@fenix/resource-channel/server`——宿主 `apps/server` 用它初始化
 * Hermes 单例（`initHermesClient`）、把 Machine 的 ACP 事件总线绑进本模块（`bindAcpEventBusPort`），
 * 并挂载 `/web/channels/*` 路由（浏览器页面经 vite alias 单独消费，见 README「边界外的已知项」）。
 *
 * `dependsOn: []`：本包是叶子模块，装配上不要求任何其它资源模块同批启用，故此处没有逐条依赖证据。
 * `src/**` 生产代码里唯一跨包的值导入是 `@fenix/agent-runtime/server`（`services/hermes-client.ts` 的
 * `findRunningInstanceByEnvironment` / `sendToAgentWs` / `sendToInstanceRelay`，`routes/web/channels.ts`
 * 的 `environmentRepo`），属 profile 固定槽位的 `agent-runtime` 类别，不是资源模块之间的装配边：生成器
 * 的装配依赖校验（`assertDependsOnComplete`）只对 `resource` 类别之间的值导入做强制，补进 `dependsOn`
 * 反而会把固定槽位编码成可选依赖。
 *
 * 不声明 `dependsOn: ["machine"]`：对 Machine 的运行期依赖走端口注入而非导入——`services/acp-event-bus-port.ts`
 * 只定义 `AcpEventBusPort` 契约，由宿主在装配期 `bindAcpEventBusPort()` 绑定机器侧的事件总线，未绑定时
 * `getAcpEventBusPort()` fail-fast。这条边若写成装配依赖，两个模块必须成套启用，方向与 §2.3「资源不得
 * 反向调用 Runtime 基础设施」冲突；宿主的显式绑定是当前唯一接线路径，不构成第二套装配方式。
 *
 * 不声明 `create`：模块组合根（`src/module.ts` 的进程级单例）属任务 1.3 W2 切片；Hermes 客户端单例
 * 当前仍由 `services/hermes-client.ts` 的模块级变量持有。
 * 不声明 `contributions` 与 `web`：消费方分别是 §1.5 的宿主挂载与 §1.6 的 WebShell 装配，形状必须与
 * 消费端同时定型；`web/` 目前只有页面、API client 与语言资源，包级浏览器出口（`web/index.ts`）尚未建立。
 */
export const moduleManifest = {
  id: "channel",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.channel"],
} satisfies ModuleManifest;
