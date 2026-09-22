import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";
import { providerResource } from "./src/server/access/provider-resource";

/**
 * Provider / Model 资源模块描述符。
 *
 * Provider / Model 资源聚合根与模型网关（凭据隔离、预算、用量、密钥管理）的唯一 owner。装配面上的
 * 消费者是宿主 `apps/server`：`main.ts` 用 `createModelGatewayRuntime` 装配网关运行时，并挂载
 * `/api/models` 与 `/api/system/model-gateway`；`routes/web/index.ts`、`routes/web/config/index.ts`
 * 分别挂载 `/web/model-gateway`、`/web/config/providers`、`/web/config/models`。
 *
 * `dependsOn: ["agent-config"]`：两处值导入。`src/server/model-gateway/runtime.ts` 取
 * `findAgentConfigNamesByIds`，把网关凭据映射里的 `agentConfigId` 解析成 Agent 名称（用量列表与密钥管理
 * 列表两处都要用）；`src/server/repositories/subject-agent-search.ts` 取 `searchAgentConfigsSystem`，把
 * 预算主体选择器的检索交给 owner（任务 1.7 B7 起检索 SQL 与表定义都在 agent-config，本包只保留协议分页
 * `page` / `pageSize` → `limit` / `offset` 的换算）。两者必须成套启用。
 *
 * 不声明 `resource-sandbox`：只有 `web/pages/admin/AdminModelGatewayPage.tsx` 值导入
 * `@fenix/resource-sandbox/web` 复用 `SearchableUsageFilter`（同页的 Master Key 门 2026-09-22 起改取
 * `@fenix/ui-components/config/AdminKeyGate` 与 `@fenix/web-runtime/hooks/use-admin-key-gate`，
 * 不再经沙盒包），本包 `src/**` 无该
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
 *
 * 声明 `envDefinitions`（§1.7 路线 A）：`RCS_MODEL_GATEWAY_*` 八键就是 `ModelManagementModuleConfig`
 * 的完整部署面（`src/server/config.ts` 的 strictObject 只认这八个字段），全仓唯一读取点是宿主
 * `apps/server/src/config.ts:22-29` 的 `buildConfig`，再经 `bootstrap/module-configs.ts:110-118` 投影进
 * 本模块配置——包内既不直读 `process.env`，也没有第二个模块消费它们，因此唯一 owner 是本模块。八行宿主
 * 声明必须**同批**从 `apps/server/src/env.ts:33-48` 删除，否则 `assertNoHostKeyOverride` 会在启动期抛
 * 「同一变量只能有一个声明处」。没有留在宿主的兄弟键：这八个就是全部 `RCS_MODEL_GATEWAY_*`。
 *
 * 宿主 `bootstrap/host-startup.ts:151-157` 的兜底 Provider 投影也读 `modelGatewayPublicBaseUrl` /
 * `modelGatewayType`，但它读的是同一份宿主配置（不是第二处 env 读取），值最终仍落在模型网关域内，不改变
 * 归属。路线 A 的窄口径：`envDefinitions` 只承担启动期校验与汇总，值继续由宿主手工投影，本模块继续经
 * `getModelManagementConfig()` 读取；不引入通用拆分器、不改模块 config.ts 形态。
 *
 * 八条 schema **逐字转写**宿主 env.ts 的同名行，不做「顺手改进」：`RCS_MODEL_GATEWAY_TYPE` /
 * `_BASE_URL` / `_ADMIN_UI_URL` 的 `.default(...)` 只对 `undefined` 生效，空串仍按原样落成空串（`""`
 * 会在模块配置校验里失败，这是宿主今天已有的行为，本声明不代为收紧）；`_PUBLIC_BASE_URL` 的
 * 「未配置时回退 Base URL」是宿主 `buildConfig` 的 `??` 语义，属于投影层，故此处保持 `optional()`；
 * `_CREDENTIAL_ENCRYPTION_KEY` / `_ADMIN_KEY` / `_PUBLIC_BASE_URL` / `_DEFAULT_USER_BUDGET_USD` /
 * `_DEFAULT_BUDGET_DURATION` 在宿主行都没有默认值，一律**省略** `defaultValue`（写 `null` 会让
 * `loadDeclaredEnv` 的 `parse(null)` 与今天漂移）；`_DEFAULT_USER_BUDGET_USD` 的 `z.coerce` 必须保留
 * （部署模板给的是字符串）；`_DEFAULT_BUDGET_DURATION` 的 `transform` 把 `permanent` / `once` 归一成
 * `undefined`（＝「不创建默认预算周期」），整条表达式逐字照抄。八键都在装配期被读一次并固化进模块配置
 * （请求期不再读 env），故 `restartRequired: true`；只有 `_ADMIN_KEY` 与 `_CREDENTIAL_ENCRYPTION_KEY`
 * 是密钥材料，`secret: true`（禁止进日志、响应与错误文案，`src/server/config.ts` 的报错已只回字段路径与
 * 错误码）。
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
  // 形状逐字对齐宿主 apps/server/src/env.ts:33-48 的同名行；无默认值的宿主行一律省略 defaultValue，
  // 避免 loadDeclaredEnv 走 parse(defaultValue) 分支而与今天的 parse(undefined) 语义漂移。
  envDefinitions: [
    {
      moduleId: "model-management",
      key: "RCS_MODEL_GATEWAY_CREDENTIAL_ENCRYPTION_KEY",
      schema: z.string().optional(),
      secret: true,
      restartRequired: true,
      description:
        "网关写库凭据（Virtual Key）的本地加密密钥；未配置时网关运行时整体不启用（runtime.ts 以「admin key 与加密密钥都缺失」判定不启用）。宿主行无可省略默认值（z.string().optional()），故本声明不写 defaultValue。密钥材料，禁止进日志、响应与错误文案。装配期由宿主投影为模块配置，改后需重启。",
    },
    {
      moduleId: "model-management",
      key: "RCS_MODEL_GATEWAY_TYPE",
      schema: z.string().default("litellm"),
      defaultValue: "litellm",
      secret: false,
      restartRequired: true,
      description:
        "模型网关类型标识（当前为 litellm），决定选用哪个适配器；未设置时默认 litellm。注意 .default() 只对 undefined 生效，空串仍按原样落成空串（模块配置校验会拒绝），与宿主原行等价。装配期由宿主投影为模块配置 modelGatewayType，改后需重启。",
    },
    {
      moduleId: "model-management",
      key: "RCS_MODEL_GATEWAY_BASE_URL",
      schema: z.string().url().default("http://localhost:4000"),
      defaultValue: "http://localhost:4000",
      secret: false,
      restartRequired: true,
      description:
        "Fenix 后端访问模型网关的 API 基址；未设置时默认 http://localhost:4000，非 URL 串在启动期即被拒绝。装配期由宿主投影为模块配置 modelGatewayBaseUrl，改后需重启。",
    },
    {
      moduleId: "model-management",
      key: "RCS_MODEL_GATEWAY_PUBLIC_BASE_URL",
      schema: z.string().url().optional(),
      secret: false,
      restartRequired: true,
      description:
        "暴露给沙盒 Agent 的网关地址（后端与 Agent 可能处于不同网络命名空间）；未配置时由宿主 buildConfig 回退到 RCS_MODEL_GATEWAY_BASE_URL——回退属投影层语义，故本声明保持 optional() 且不写 defaultValue。装配期由宿主投影为模块配置 modelGatewayPublicBaseUrl，改后需重启。",
    },
    {
      moduleId: "model-management",
      key: "RCS_MODEL_GATEWAY_ADMIN_KEY",
      schema: z.string().optional(),
      secret: true,
      restartRequired: true,
      description:
        "网关管理密钥（LiteLLM master key 一类）；未配置时网关运行时整体不启用。宿主行无可省略默认值（z.string().optional()），故本声明不写 defaultValue。密钥材料，禁止进日志、响应与错误文案（src/server/config.ts 的报错只回字段路径与错误码）。装配期由宿主投影为模块配置，改后需重启。",
    },
    {
      moduleId: "model-management",
      key: "RCS_MODEL_GATEWAY_ADMIN_UI_URL",
      schema: z.string().url().default("http://localhost:4000/ui/"),
      defaultValue: "http://localhost:4000/ui/",
      secret: false,
      restartRequired: true,
      description:
        "管理员浏览器打开网关控制台的地址，系统管理页据此生成跳转链接；未设置时默认 http://localhost:4000/ui/，非 URL 串启动期即被拒。装配期由宿主投影为模块配置 modelGatewayAdminUiUrl（宿主保证恒有值，故模块契约里该字段必填），改后需重启。",
    },
    {
      moduleId: "model-management",
      key: "RCS_MODEL_GATEWAY_DEFAULT_USER_BUDGET_USD",
      schema: z.coerce.number().nonnegative().optional(),
      secret: false,
      restartRequired: true,
      description:
        "首次激活用户的默认预算（美元，非负数）；未配置时不创建默认预算，因此无默认值。z.coerce 必须保留——部署模板给的是字符串（空串经 coerce 归一为数字 0，与宿主原行等价）。装配期由宿主投影为模块配置 modelGatewayDefaultUserBudgetUsd，改后需重启。",
    },
    {
      moduleId: "model-management",
      key: "RCS_MODEL_GATEWAY_DEFAULT_BUDGET_DURATION",
      // 与宿主 env.ts:41-48 逐字等价：先 trim + 小写归一，再把空值 / permanent / once 折成 undefined
      // （＝「不创建默认预算周期」），其余取值原样透传；无默认值，故不写 defaultValue。
      schema: z
        .string()
        .optional()
        .transform((value) => {
          const normalized = value?.trim().toLowerCase();
          return !normalized || normalized === "permanent" || normalized === "once" ? undefined : value;
        })
        .optional(),
      secret: false,
      restartRequired: true,
      description:
        "新用户默认预算周期（如 30d / monthly）；permanent、once 与空串被归一成 undefined，表达「不创建周期性预算」。装配期由宿主投影为模块配置 modelGatewayDefaultBudgetDuration，改后需重启。",
    },
  ],
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
