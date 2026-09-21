import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { providerResource } from "./src/server/access/provider-resource";

/**
 * Provider / Model 资源模块描述符。
 *
 * Provider / Model 资源聚合根与模型网关（凭据隔离、预算、用量、密钥管理）的唯一 owner。装配面上的
 * 消费者是宿主 `apps/server`：`main.ts` 用 `createModelGatewayRuntime` 装配网关运行时，并挂载
 * `/api/models` 与 `/api/system/model-gateway`；`routes/web/index.ts`、`routes/web/config/index.ts`
 * 分别挂载 `/web/model-gateway`、`/web/config/providers`、`/web/config/models`。
 *
 * `dependsOn: ["agent-config"]`：`src/server/model-gateway/runtime.ts` 值导入
 * `@fenix/agent-config/server` 的 `findAgentConfigNamesByIds`，把网关凭据映射里的 `agentConfigId`
 * 解析成 Agent 名称（用量列表与密钥管理列表两处都要用），两者必须成套启用。
 *
 * 不声明 `resource-sandbox`：只有 `web/pages/admin/AdminModelGatewayPage.tsx` 值导入
 * `@fenix/resource-sandbox/web` 复用 `MasterKeyGate` / `SearchableUsageFilter`，本包 `src/**` 无该
 * 导入；浏览器侧的模块依赖由装配 profile 的 web 列表表达（§1.6），不进入服务端装配顺序。
 * 不声明平台基础模块（`identity` / `access-control`）：它们在 profile 里是固定槽位，本包只经
 * `@fenix/platform-sdk` 的窄契约（`IdentityDirectory`、`AccessControlModule`）使用。
 * 不声明 `chat-channel`：`src/services/peri-task-detail-store.ts` 值导入它（Peri 任务详情读取
 * `DocManager` 与任务映射），但该包尚未提供 manifest、当前不在资源包装配集内；它注册为 resource
 * 模块的那一刻，生成器的装配依赖反向校验会强制补上这条边。
 *
 * 声明 `accessControlBindings`：`providerResource.storage` 是本模块主表（`provider`）的归属列声明，
 * 由 `access-control` 的工厂经 `ModuleFactoryContext.declarations` 汇总。静态导入资源注册文件是有意的
 * 取舍——绑定是值而不是类型，只能来自静态导出；本模块**不得**为这条边把 `access-control` 写进
 * `dependsOn`，否则授权模块与资源模块会互相等待（理由与加载代价见 `@fenix/resource-mcp` 的同类说明）。
 *
 * `create` 是惰性组合根（`src/module.ts`）：由 registry 注入装配声明，构造
 * `createModelManagementServerModule(deps)` 的真实例并装入进程级槽位。模型网关服务集
 * （`setModelGatewayServices`）不在本工厂内构造——它依赖宿主进程级的凭据与预算装配，归宿主的
 * `initModelGateway`（§1.5 裁定：registry 不接管启动序）。
 *
 * 声明 `contributions`（1.5e）：六条路由的实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot` 指明挂宿主哪一面——路由路径是相对
 * 形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与 `create` 同因：registry 会
 * 被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 两条挂 `web-config`（`/web/config/models`、`/web/config/providers`），两条挂 `web`
 * （`/web/model-gateway`、`/web/agents/:environmentId/sessions/:sessionId/peri-tasks/:taskId/detail`）。
 * 后者要校验 Environment 归属，消费宿主 `verifyEnvironmentOwnership` 端口。
 *
 * 1.5f 追加两条挂 `api`：`/api/models`（会话守卫，与 `/web` 面同一份实例）与
 * `/api/system/model-gateway`（系统 API 守卫，与普通请求认证互不相关）。
 *
 * 声明 `web`（§1.6 已定型）：`contribution` 是该包浏览器载荷的惰性**入口说明符字符串**——WebShell 生成器
 * 只对 manifest 做 AST 静态读取、不执行它，所以入口只能是「声明」而不是「推断」，取值必须是字符串字面量。
 * 它**不是**浏览器依赖：`lucide-react` / React 载荷只存在于 `@fenix/model-management/web/contribution` 导出
 * 的值里，不会沿 registry 进入服务端装配图（server 侧拿到的只有这一条字符串）。
 */
export const moduleManifest = {
  id: "model-management",
  kind: "resource",
  dependsOn: ["agent-config"],
  capabilities: ["resource.model-management"],
  web: {
    id: "model-management",
    contribution: "@fenix/model-management/web/contribution",
  },
  accessControlBindings: [providerResource.storage],
  contributions: [
    {
      id: "model-management.web-config-models",
      kind: "app-route",
      slot: "web-config",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createModelManagementWebConfigModelsRoutes(host)),
    },
    {
      id: "model-management.web-config-providers",
      kind: "app-route",
      slot: "web-config",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) =>
          assembly.createModelManagementWebConfigProvidersRoutes(host),
        ),
    },
    {
      id: "model-management.web-model-gateway",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createModelManagementWebGatewayRoutes(host)),
    },
    {
      id: "model-management.web-peri-task-details",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) =>
          assembly.createModelManagementWebPeriTaskDetailsRoutes(host),
        ),
    },
    {
      id: "model-management.api-models",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createModelManagementApiModelsRoutes(host)),
    },
    {
      id: "model-management.api-system-model-gateway",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) =>
          assembly.createModelManagementApiSystemModelGatewayRoutes(host),
        ),
    },
  ],
  create: (context) => import("./src/module").then((module) => module.createModelManagementModule(context)),
} satisfies ModuleManifest;
