import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";

/**
 * Trace（LLM 观测）资源模块描述符。
 *
 * 唯一 owner：会话观测的**只读**链路。Agent 侧的观测写入不在这里——peri 进程按 `LANGFUSE_*` 直连兼容后端
 * 上报，主服务只透传凭据（`@fenix/agent-config` 的 launch-spec 组装器），本模块只是同一份数据在控制台侧的
 * 读取方：`/web/agents/:environmentId/sessions/:sessionId/traces*` 三条只读接口，把 Session Doc 里的活跃 ACP
 * 会话映射成 Langfuse `sessionId` 过滤条件，再经薄客户端取 trace / observation。
 *
 * `dependsOn: []`：`src/**` 的跨包值导入只有 `@fenix/chat-channel`（`createDeterministicRcsSessionId` 与
 * DocManager 单例）。该包是 standalone 契约包而非装配模块，没有模块 ID 可声明；平台契约包（platform-sdk）与
 * 工具包同理。诊断端口（`getOwnedEnvironment` / `authGuardPlugin`）由宿主在装配处注入，不构成模块间依赖边。
 *
 * 不声明 `envDefinitions`：观测连接三键（`LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`）
 * 的声明 owner 是 `@fenix/agent-config`（该包 manifest 逐键写明了判定依据）。本模块是同一份部署值的第二个
 * **读取**消费者，值由宿主 `bootstrap/module-configs.ts` 从 `config.langfuse*` 投影为本模块配置
 * （`langfuseBaseUrl` / `langfusePublicKey` / `langfuseSecretKey`）；同名键两处声明会被宿主 env-loader 的
 * `assertNoHostKeyOverride` 在启动期直接拒绝。
 *
 * 不声明 `web`：本模块的浏览器载荷是**面板组件**（由宿主 `apps/web/src/pages/agent-panel/artifacts/` 直接
 * 装配，与 prod-view 的面板同口径）。`WebAppContribution` 契约只表达侧栏导航与路由前缀，没有面板插槽，写了
 * 反而会把一个无消费方的贡献塞进生成器。
 *
 * 声明 `contributions`：一条 `slot: "web"` 的路由贡献，路径自带 `/agents/...` 前缀（前缀由宿主聚合实例决定，
 * 包内不写 `/web`）。工厂保持惰性（`import("./src/server/assembly")`）：registry 会被大量位置导入，不能在
 * 索引层把 Elysia 拖进模块图。
 */
export const moduleManifest = {
  id: "trace",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.trace"],
  contributions: [
    {
      id: "trace.web",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createTraceWebRoutes(host)),
    },
  ],
  create: () => import("./src/module").then((module) => module.createTraceModule()),
} satisfies ModuleManifest;
