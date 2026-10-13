import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";

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
 * 声明 `envDefinitions`（1.7 C 块，路线 A）：`HERMES_URL` / `HERMES_PLATFORMS` 两键从宿主
 * `apps/server/src/env.ts` 迁入本模块声明。归属依据是「唯一 owner」——两键全仓只有一处消费点，
 * 即本模块 Hermes 网关连接的装配（宿主 `bootstrap/host-startup.ts` 读出后经
 * `initHermesClient(url, { platforms })` 注入本包），没有任何第二个模块读它们，所以它们不是宿主
 * 的部署面而是本模块的部署面。路线 A 下 `envDefinitions` 只承担**启动期校验 + 汇总**：值仍由宿主在
 * 装配期读出后经 `initHermesClient(url, { platforms })` 注入（本包没有 `getModuleConfig()` 条目），
 * 本包的配置形态不变——本包不读 `process.env`，见 `src/server/services/hermes-client.ts` 的
 * `HermesClientOptions` 注释。
 *
 * 两键都**逐字保留宿主原文语义**：`z.string().optional()`、**不写 `defaultValue`**。这里省去默认值不是
 * 省略细节而是保住行为——`HERMES_PLATFORMS` 的「未给 / 空串」与「显式空清单」在
 * `hermes-client.ts` 的构造器里靠 `if (configuredPlatforms)` 分流：前者回落内置常见平台清单，后者
 * （例如 `" , "`）表示**不订阅任何平台**。补一个 `defaultValue: ""` 会把「未配置」折叠成「显式空」，
 * 一次部署配置的收窄会变成静默放宽；`HERMES_URL` 同理，补默认地址会让每台未配置网关的部署都去连一个
 * 并不存在的地址（宿主侧本就用 `if (hermesUrl)` 决定是否初始化客户端）。
 *
 * `secret: false`：网关地址与平台清单不是密钥材料，可以出现在日志与错误文案里；Hermes 侧的凭据若有，
 * 走的是通道绑定而不是这两个变量。`restartRequired: true`：两个值都由宿主 `host-startup.ts` 在启动期经
 * `readDeclaredEnv` 从合并 env 读一次并传进 `initHermesClient()`，之后 `resetHermesClient()` 重装配用的仍是
 * 那一份启动期闭包值——`loadServerEnv()` 的结果在进程存活期不会重建，改 env 必须重启才生效。
 *
 * 不迁的兄弟键：无。Hermes 域只有这两键（宿主 schema 里它们同属「── 可选：Hermes ──」分组，无第三键）。
 *
 * 不声明 `web`：字段形状必须与 §1.6 的 WebShell 装配同时定型，单方面发明会返工（实施记录 §四.2）。
 * 包侧已具备 `./web` 出口与浏览器安全守卫，缺的只是 registry 侧的消费方式。
 */
export const moduleManifest = {
  id: "channel",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.channel"],
  envDefinitions: [
    {
      moduleId: "channel",
      key: "HERMES_URL",
      // 逐字照抄宿主原文（`apps/server/src/env.ts` 的 `HERMES_URL: z.string().optional()`），只去掉宿主
      // 自定义的 error message；`.optional()` 与「无默认值」必须同时保留，理由见文件头注释。
      schema: z.string().optional(),
      secret: false,
      restartRequired: true,
      description:
        "Hermes IM 网关的 WebSocket 地址。无默认值且未配置即视为不启用通道能力（宿主只在取到值时才初始化 Hermes 客户端），补默认地址会让未配置网关的部署去连一个不存在的地址。由宿主在装配期读出后经 `initHermesClient(url, { platforms })` 注入本模块。",
    },
    {
      moduleId: "channel",
      key: "HERMES_PLATFORMS",
      // 与宿主原文 `HERMES_PLATFORMS: z.string().optional()` 逐字等价。**不得**补 `defaultValue`：本包
      // `hermes-client.ts` 用 `if (configuredPlatforms)` 区分「未给 / 空串 → 内置常见平台清单」与
      // 「显式给出但解析为空 → 不订阅任何平台」，写空串默认值会改写这层语义。
      schema: z.string().optional(),
      secret: false,
      restartRequired: true,
      description:
        "Hermes 连接后订阅的平台清单，逗号分隔（逐项 trim 并丢弃空项）。无默认值且空串与未配置同义（都回落内置常见平台清单）；显式给出但解析为空（例如只写了逗号或空格）表示不订阅任何平台，两种语义在 `HermesClient` 构造器里分流。由宿主在装配期读出后随网关地址一并注入本模块。",
    },
  ],
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
